import { v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema, { kind } from "./schema.js";
import {
  addMemories,
  getEpisodes,
  deleteSessionMemories,
  deleteUserMemories,
  flushExtraction,
  getProfileMemory,
  memoryTypeToKind,
  normalizeTimestamp,
  searchMemories,
  type EverosConfig,
  type EverosEpisode,
} from "./everos.js";

const MAX_ATTEMPTS = 5;

// v2 ingest requires a session_id on every add; remembers that don't name a
// session share one long-lived per-user session. The API caps session ids at
// 128 chars — beyond that, keep the tail (the distinctive end of a long
// app-generated user id) rather than fail the ingest.
function effectiveSessionId(userId: string, sessionId?: string): string {
  const sid = sessionId ?? `user:${userId}`;
  return sid.length <= 128 ? sid : sid.slice(-128);
}

// A single verifiable fact underlying a memory (for auditability / traceability).
const atomicFact = v.object({
  text: v.string(),
  score: v.optional(v.number()),
  timestamp: v.optional(v.number()),
  sessionId: v.optional(v.string()),
});

// A memory returned from a retrieval call.
const recalledMemory = v.object({
  everosMemoryId: v.string(),
  userId: v.string(),
  kind,
  text: v.string(),
  summary: v.optional(v.string()),
  score: v.optional(v.number()),
  timestamp: v.optional(v.number()),
  sessionId: v.optional(v.string()),
  // True for content that was remembered but not yet extracted by EverOS —
  // returned so "what was just said" is never invisible (read-your-writes).
  pending: v.optional(v.boolean()),
  // The atomic facts this memory decomposes into — each traceable to when and
  // in which session it was said.
  atomicFacts: v.optional(v.array(atomicFact)),
});

const profileResult = v.object({
  everosMemoryId: v.string(),
  scenario: v.optional(v.string()),
  summary: v.optional(v.string()),
  explicitInfo: v.array(v.any()),
  implicitTraits: v.array(v.any()),
});

// ===========================================================================
// remember (mutation) — enqueue content, schedule a flush to EverOS
// ===========================================================================

export const remember = mutation({
  args: {
    userId: v.string(),
    content: v.string(),
    role: v.optional(v.union(v.literal("user"), v.literal("assistant"))),
    sessionId: v.optional(v.string()),
    // When this was actually said. Without it the timestamp is synthesized at
    // flush time, which a retry can push minutes past the real moment — and
    // "when was this said" is half of what makes a memory auditable.
    timestamp: v.optional(v.number()),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.object({ pendingId: v.string() }),
  handler: async (ctx, args) => {
    if (args.content.trim() === "") {
      throw new Error(
        "remember() called with empty content — pass the text to remember.",
      );
    }
    const pendingId = await ctx.db.insert("pending", {
      userId: args.userId,
      content: args.content,
      role: args.role ?? "user",
      sessionId: args.sessionId,
      appId: args.appId,
      projectId: args.projectId,
      saidAt: args.timestamp,
      status: "queued",
      attempts: 0,
    });
    // Mutations can't call external APIs — hand off to a scheduled action.
    await ctx.scheduler.runAfter(0, internal.lib.flush, {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    });
    return { pendingId };
  },
});

// ===========================================================================
// rememberMessages (mutation) — a whole turn in one call
// ===========================================================================

// An agent turn is a user message and the assistant's reply. Calling
// `remember` twice enqueues two rows and schedules two flushes, and it is the
// reason the README's own example only ever stores the user's half: the
// assistant's answer, where the commitments live, never reaches memory.
export const rememberMessages = mutation({
  args: {
    userId: v.string(),
    messages: v.array(
      v.object({
        content: v.string(),
        role: v.optional(v.union(v.literal("user"), v.literal("assistant"))),
        timestamp: v.optional(v.number()),
      }),
    ),
    sessionId: v.optional(v.string()),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.object({ pendingIds: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const pendingIds: string[] = [];
    for (const message of args.messages) {
      if (message.content.trim() === "") continue;
      const id = await ctx.db.insert("pending", {
        userId: args.userId,
        content: message.content,
        role: message.role ?? "user",
        sessionId: args.sessionId,
        appId: args.appId,
        projectId: args.projectId,
        saidAt: message.timestamp,
        status: "queued",
        attempts: 0,
      });
      pendingIds.push(id);
    }
    if (pendingIds.length === 0) {
      throw new Error("rememberMessages() called with no non-empty messages.");
    }
    // One flush for the whole turn, not one per message.
    await ctx.scheduler.runAfter(0, internal.lib.flush, {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    });
    return { pendingIds };
  },
});

// ===========================================================================
// flush (internal action) — POST queued items to EverOS
// ===========================================================================

// A claim lease. If an action dies between claiming rows and reporting the
// result, its rows would otherwise sit in `sending` forever, so a later flush
// reclaims anything held longer than this.
const STALE_CLAIM_MS = 2 * 60_000;

// Backoff for re-attempting an ingest that failed. A requeued row would
// otherwise wait for the next `remember`, which may never come.
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

/**
 * Atomically take ownership of queued rows.
 *
 * This runs in a mutation, so concurrent flush actions are serialized here and
 * each gets a disjoint set. Without the claim, two flushes triggered by two
 * quick `remember` calls both read the same `queued` rows (nothing is marked
 * until the HTTP round trip returns) and ingest the same content twice.
 */
export const claimQueued = internalMutation({
  args: {
    limit: v.optional(v.number()),
    // Carried so the claim can schedule its own recovery in the same
    // transaction (see the sweep below).
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.object({
    rows: v.array(
      v.object({
        _id: v.id("pending"),
        userId: v.string(),
        content: v.string(),
        role: v.union(v.literal("user"), v.literal("assistant")),
        sessionId: v.optional(v.string()),
        appId: v.optional(v.string()),
        projectId: v.optional(v.string()),
        saidAt: v.optional(v.number()),
        attempts: v.number(),
      }),
    ),
    // The recovery sweep committed alongside the claim. A flush that reaches
    // the end cancels it; one that dies does not, and the sweep fires.
    sweepId: v.union(v.id("_scheduled_functions"), v.null()),
  }),
  // Annotated because this mutation schedules a function from the same module,
  // which makes its inferred type circular through the generated api.
  handler: async (
    ctx,
    args,
  ): Promise<{
    rows: Array<{
      _id: Id<"pending">;
      userId: string;
      content: string;
      role: "user" | "assistant";
      sessionId?: string;
      appId?: string;
      projectId?: string;
      saidAt?: number;
      attempts: number;
    }>;
    sweepId: Id<"_scheduled_functions"> | null;
  }> => {
    const limit = args.limit ?? 25;
    const now = Date.now();
    const rows = await ctx.db
      .query("pending")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(limit);
    // Always look for rows abandoned by an action that never reported back.
    // Gating this on a non-full batch would starve reclaim exactly when the
    // queue is busy, which is when actions are most likely to be cut short.
    {
      const stale = await ctx.db
        .query("pending")
        .withIndex("by_status", (q) => q.eq("status", "sending"))
        .take(limit);
      for (const r of stale) {
        if (now - (r.claimedAt ?? 0) <= STALE_CLAIM_MS) continue;
        // Count the abandoned attempt. Otherwise a row whose action dies every
        // time is reclaimed forever instead of eventually being given up on.
        const attempts = r.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await ctx.db.patch(r._id, {
            status: "failed",
            attempts,
            claimedAt: undefined,
            lastError:
              "Ingest was claimed but never completed, after " +
              `${attempts} attempts.`,
          });
          continue;
        }
        rows.push({ ...r, attempts });
      }
    }
    const claimed = [];
    for (const r of rows) {
      // `attempts` is carried from the reclaim branch above. Patching only
      // status/claimedAt would drop it, so a row that is always abandoned
      // would be reclaimed forever and never reach MAX_ATTEMPTS.
      await ctx.db.patch(r._id, {
        status: "sending",
        claimedAt: now,
        attempts: r.attempts,
      });
      claimed.push({
        _id: r._id,
        userId: r.userId,
        content: r.content,
        role: r.role,
        sessionId: r.sessionId,
        appId: r.appId,
        projectId: r.projectId,
        saidAt: r.saidAt,
        attempts: r.attempts,
      });
    }

    // Schedule the recovery sweep here, not at the end of the flush: if the
    // action dies right after claiming, code at the end of it never runs, and
    // the rows would sit in `sending` forever because only `remember` and a
    // failed flush schedule a flush. Committing the sweep in the same
    // transaction as the claim makes recovery durable. It terminates on its
    // own — a sweep that claims nothing schedules nothing.
    let sweepId = null;
    if (claimed.length > 0) {
      sweepId = await ctx.scheduler.runAfter(
        STALE_CLAIM_MS + 1_000,
        internal.lib.flush,
        {
          apiKey: args.apiKey,
          baseUrl: args.baseUrl,
          appId: args.appId,
          projectId: args.projectId,
        },
      );
    }
    return { rows: claimed, sweepId };
  },
});

export const markSent = internalMutation({
  args: { ids: v.array(v.id("pending")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      // A row can be deleted underneath us by `forgetUser` / `forgetSession`.
      // Patching it would throw, and because the mutation is transactional the
      // whole group would stay unmarked and be re-sent to EverOS.
      const row = await ctx.db.get(id);
      if (!row) continue;
      await ctx.db.patch(id, {
        status: "sent",
        claimedAt: undefined,
        sentAt: Date.now(),
      });
    }
    return null;
  },
});

export const markFailed = internalMutation({
  args: { ids: v.array(v.id("pending")), error: v.string() },
  // The largest attempt count among the requeued rows, so the caller can pick
  // a backoff; -1 when every row is permanently failed and a retry is pointless.
  returns: v.number(),
  handler: async (ctx, args) => {
    let maxAttempts = -1;
    for (const id of args.ids) {
      // Re-read rather than trust the action's snapshot: two attempts that
      // overlapped would otherwise both write the same count and the row would
      // outlive MAX_ATTEMPTS.
      const row = await ctx.db.get(id);
      if (!row) continue;
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await ctx.db.patch(id, {
        status: exhausted ? "failed" : "queued",
        attempts,
        claimedAt: undefined,
        lastError: args.error,
      });
      if (!exhausted) maxAttempts = Math.max(maxAttempts, attempts);
    }
    return maxAttempts;
  },
});

// Retire exactly the rows whose ingest this extraction covered. Marking every
// `sent` row in the session instead would retire content ingested after the
// flush was scheduled, hiding it from the read-your-writes merge before it is
// actually searchable.
export const markExtracted = internalMutation({
  args: {
    ids: v.array(v.id("pending")),
    // Everything ingested into this session before the extraction ran was in
    // the buffer it drained, so it is covered too. Without this, two
    // `remember` calls in one session start two extraction chains against one
    // buffer: the first drains it, and the second is told "no_extraction"
    // about rows that are in fact searchable.
    userId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    coveredBefore: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const done = new Set<string>();
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row && row.status === "sent") {
        // Delete rather than mark: once EverOS holds the memory this row has
        // no further purpose, and keeping it would grow the table for the
        // lifetime of the app and slow every subsequent read of it.
        await ctx.db.delete(id);
        done.add(id);
      }
    }
    const { userId, sessionId, coveredBefore } = args;
    if (userId === undefined || coveredBefore === undefined) return null;
    const siblings = await ctx.db
      .query("pending")
      .withIndex("by_user_and_status", (q) =>
        q.eq("userId", userId).eq("status", "sent"),
      )
      .take(200);
    for (const row of siblings) {
      if (done.has(row._id)) continue;
      if (effectiveSessionId(row.userId, row.sessionId) !== sessionId) continue;
      // Only rows whose ingest had already landed when the extraction ran.
      if ((row.sentAt ?? Infinity) <= coveredBefore) {
        await ctx.db.delete(row._id);
      }
    }
    return null;
  },
});

// Record why content is ingested but still not searchable, so it is
// reportable through `getPendingStatus` instead of failing silently.
export const markExtractionStalled = internalMutation({
  args: { ids: v.array(v.id("pending")), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row && row.status === "sent") {
        await ctx.db.patch(id, { lastError: args.error });
      }
    }
    return null;
  },
});

export const flush = internalAction({
  args: {
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.object({ sent: v.number(), failed: v.number() }),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    const { rows: claimed, sweepId } = await ctx.runMutation(
      internal.lib.claimQueued,
      {
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        appId: args.appId,
        projectId: args.projectId,
      },
    );
    let sent = 0;
    let failed = 0;
    let retryAfter = -1;

    // Group by (userId, session) and send each group as ONE ingest call:
    // fewer server-side tasks and faster extraction than one call per message.
    const groups = new Map<string, typeof claimed>();
    for (const item of claimed) {
      // Keyed by namespace as well as session: a deployment can hold more
      // than one client, and rows enqueued for one namespace must not be
      // ingested under another's scope, or billed to its key. JSON rather
      // than a delimiter, because a user id may contain any character.
      const key = JSON.stringify([
        item.userId,
        effectiveSessionId(item.userId, item.sessionId),
        item.appId ?? null,
        item.projectId ?? null,
      ]);
      const g = groups.get(key);
      if (g) g.push(item);
      else groups.set(key, [item]);
    }

    for (const group of groups.values()) {
      const { userId } = group[0];
      const sessionId = effectiveSessionId(userId, group[0].sessionId);
      const ids = group.map((item) => item._id);
      // The row's own namespace wins over this flush's, since the flush may
      // have been scheduled by a different client in the same deployment.
      const groupConfig: EverosConfig = {
        ...config,
        appId: group[0].appId ?? config.appId,
        projectId: group[0].projectId ?? config.projectId,
      };
      try {
        await addMemories(groupConfig, {
          sessionId,
          messages: group.map((item, i) => ({
            role: item.role,
            // The caller's timestamp when given; otherwise now, offset to
            // preserve ordering within the batch.
            timestamp: item.saidAt ?? Date.now() - (group.length - i),
            content: item.content,
            // v2 attributes memories via per-message sender_id — without a
            // user-id sender on user messages, nothing is extracted for them.
            sender_id: item.role === "user" ? userId : "assistant",
          })),
        });
        await ctx.runMutation(internal.lib.markSent, { ids });
        sent += group.length;
        // Don't flush inline: an ingest takes ~10s to land in the
        // accumulation buffer server-side, and a flush before that is a
        // silent no-op. Schedule past the landing window instead.
        await ctx.scheduler.runAfter(
          EXTRACTION_DELAY_MS,
          internal.lib.runExtraction,
          {
            apiKey: args.apiKey,
            baseUrl: args.baseUrl,
            appId: groupConfig.appId,
            projectId: groupConfig.projectId,
            sessionId,
            userId,
            ids,
          },
        );
      } catch (e) {
        failed += group.length;
        const attempts = await ctx.runMutation(internal.lib.markFailed, {
          ids,
          error: e instanceof Error ? e.message : String(e),
        });
        retryAfter = Math.max(retryAfter, attempts);
      }
    }

    // Requeued rows would otherwise wait for the next `remember`, which may
    // never arrive — schedule their retry here.
    if (retryAfter >= 0) {
      const delay =
        RETRY_DELAYS_MS[Math.min(retryAfter - 1, RETRY_DELAYS_MS.length - 1)];
      await ctx.scheduler.runAfter(delay, internal.lib.flush, {
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        appId: args.appId,
        projectId: args.projectId,
      });
    }

    // Every claimed row now has a recorded outcome, so the recovery sweep is
    // not needed. Leaving it would mean an outage schedules two successors per
    // flush (this retry and the sweep), and each of those two more, so upstream
    // failure would be met with escalating traffic instead of backoff.
    if (sweepId !== null) await ctx.scheduler.cancel(sweepId);
    return { sent, failed };
  },
});

const EXTRACTION_DELAY_MS = 15_000;
// The ingest to buffer landing window is ~10s under normal load but can
// stretch; a flush during it returns "no_extraction" (a silent no-op).
// Retry with backoff until EverOS reports an actual extraction.
const EXTRACTION_RETRY_DELAYS_MS = [20_000, 40_000, 80_000];

export const runExtraction = internalAction({
  args: {
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    // Extraction buffers are keyed by session on the EverOS side.
    sessionId: v.string(),
    userId: v.string(),
    // The rows this extraction covers, so only they are retired.
    ids: v.array(v.id("pending")),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    const attempt = args.attempt ?? 0;
    // Captured before the call: anything ingested by now is in the buffer this
    // extraction drains, so a success covers it.
    const coveredBefore = Date.now();
    let extracted = false;
    let lastError: string | undefined;
    try {
      const { status } = await flushExtraction(config, {
        sessionId: args.sessionId,
      });
      // "no_extraction" also means the ingest had not landed in the buffer yet.
      extracted = status === "extracted";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    if (extracted) {
      await ctx.runMutation(internal.lib.markExtracted, {
        ids: args.ids,
        userId: args.userId,
        sessionId: args.sessionId,
        coveredBefore,
      });
      return null;
    }
    if (attempt < EXTRACTION_RETRY_DELAYS_MS.length) {
      await ctx.scheduler.runAfter(
        EXTRACTION_RETRY_DELAYS_MS[attempt],
        internal.lib.runExtraction,
        { ...args, attempt: attempt + 1 },
      );
      return null;
    }
    // Out of retries. Do not assume a sibling covered these rows and delete
    // them: when that assumption is wrong the content disappears from recall
    // and `getPendingStatus` reports all clear, which is the one failure this
    // component exists to make visible. A sibling that genuinely did cover
    // them retires them through `markExtracted` above. Keep them and record
    // why.
    await ctx.runMutation(internal.lib.markExtractionStalled, {
      ids: args.ids,
      error:
        lastError ??
        "EverOS reported no extraction after repeated flushes; the content is " +
          "ingested but not confirmed searchable.",
    });
    return null;
  },
});

// ===========================================================================
// recall (action) — query EverOS retrieval API
// ===========================================================================

// Extraction lands within a couple of minutes; anything older than this in
// queued/sent state is a stalled pipeline (e.g. an action killed between the
// EverOS flush and markExtracted) whose content was likely extracted anyway —
// stop merging it into recall results rather than duplicate real memories.
const UNEXTRACTED_MAX_AGE_MS = 15 * 60_000;

// How many not-yet-extracted items recall may append. These are unranked, so
// an unbounded merge would swamp the ranked results and blow up prompt size
// for anyone feeding recall output to a model.
const DEFAULT_PENDING_MERGE_LIMIT = 5;

// Remembered-but-not-yet-extracted rows for a user. Merged into recall
// results so freshly saved content is never invisible while EverOS's
// asynchronous extraction catches up.
export const getUnextracted = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("pending"),
      _creationTime: v.number(),
      content: v.string(),
      sessionId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - UNEXTRACTED_MAX_AGE_MS;
    const limit = args.limit ?? DEFAULT_PENDING_MERGE_LIMIT;
    // Newest first, and bounded per status: the point of this merge is the
    // thing the user just said, so an ascending scan that slices the head
    // would return the oldest backlog and drop exactly what matters.
    const rows = [];
    for (const status of ["queued", "sending", "sent"] as const) {
      const page = await ctx.db
        .query("pending")
        .withIndex("by_user_and_status", (q) =>
          q.eq("userId", args.userId).eq("status", status),
        )
        .order("desc")
        .take(limit);
      rows.push(...page);
    }
    return rows
      .filter((r) => r._creationTime > cutoff)
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, limit)
      .map((r) => ({
        _id: r._id,
        _creationTime: r._creationTime,
        content: r.content,
        sessionId: r.sessionId,
      }));
  },
});
// Render one profile item as the sentence a human (or a model) should read.
// A profile item is a record — `{category|trait, description, evidence,
// item_id, source, created_at, ...}` — whose `description` is the whole point;
// the rest is provenance. Serializing the record would put ids and timestamps
// into agent context and into any UI that shows recalled text.
function profileItemToText(item: unknown): string | undefined {
  if (typeof item === "string") return item.trim() || undefined;
  if (item && typeof item === "object") {
    const { description, trait, category } = item as Record<string, unknown>;
    for (const field of [description, trait, category]) {
      if (typeof field === "string" && field.trim()) return field.trim();
    }
  }
  return undefined;
}

// Live API quirks handled here once: optional strings come back as null where
// validators want undefined, score is null when unscored, and timestamps are
// ISO strings.
function episodeToMemory(ep: EverosEpisode, userId: string) {
  return {
    everosMemoryId: ep.id,
    userId,
    kind: ep.type ? memoryTypeToKind(ep.type) : ("episodic" as const),
    text: ep.episode ?? ep.summary ?? ep.subject ?? "",
    summary: ep.summary ?? undefined,
    score: ep.score ?? undefined,
    timestamp: normalizeTimestamp(ep.timestamp),
    sessionId: ep.session_id ?? undefined,
    atomicFacts: (ep.atomic_facts ?? [])
      .filter((f) => f.content)
      .map((f) => ({
        text: f.content as string,
        score: f.score ?? undefined,
        timestamp: normalizeTimestamp(f.timestamp),
        sessionId: f.session_id ?? undefined,
      })),
  };
}

export const recall = action({
  args: {
    userId: v.string(),
    query: v.string(),
    topK: v.optional(v.number()),
    kind: v.optional(kind),
    // When true (default), append content that was remembered but not yet
    // extracted by EverOS, marked with `pending: true`.
    includeRecent: v.optional(v.boolean()),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.array(recalledMemory),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    const { episodes, profiles } = await searchMemories(config, {
      userId: args.userId,
      query: args.query,
      topK: args.topK,
      kind: args.kind,
    });

    const results: Array<{
      everosMemoryId: string;
      userId: string;
      kind: "episodic" | "profile";
      text: string;
      summary?: string;
      score?: number;
      timestamp?: number;
      sessionId?: string;
      pending?: boolean;
      atomicFacts?: Array<{
        text: string;
        score?: number;
        timestamp?: number;
        sessionId?: string;
      }>;
    }> = [];

    for (const ep of episodes) {
      results.push(episodeToMemory(ep, args.userId));
    }
    for (const p of profiles) {
      const parts = [
        ...(p.profile_data?.explicit_info ?? []),
        ...(p.profile_data?.implicit_traits ?? []),
      ]
        .map(profileItemToText)
        .filter((t): t is string => t !== undefined);
      // Skip empty profile shells — they'd only pollute agent context.
      if (parts.length === 0) continue;
      const traits = parts.join("; ");
      results.push({
        everosMemoryId: p.id,
        userId: args.userId,
        kind: "profile",
        text: p.scenario ? `${p.scenario}: ${traits}` : traits,
      });
    }


    // Read-your-writes: EverOS extraction is asynchronous, so content saved
    // moments ago isn't searchable yet. Append it from the local queue
    // (unranked, marked pending) so it's never invisible to the agent.
    if (args.includeRecent !== false && args.kind !== "profile") {
      // Bounded by topK so the caller's result budget still means something:
      // these rows are unranked, so they cannot be allowed to crowd out the
      // ranked matches in an agent's context window.
      const recent = await ctx.runQuery(internal.lib.getUnextracted, {
        userId: args.userId,
        limit: Math.min(
          args.topK ?? DEFAULT_PENDING_MERGE_LIMIT,
          DEFAULT_PENDING_MERGE_LIMIT,
        ),
      });
      for (const r of recent) {
        results.push({
          everosMemoryId: `pending:${r._id}`,
          userId: args.userId,
          kind: "episodic",
          text: r.content,
          timestamp: r._creationTime,
          sessionId: r.sessionId,
          pending: true,
        });
      }
    }

    return results;
  },
});

// ===========================================================================
// getProfile (action) — fetch a user's profile / semantic memory
// ===========================================================================

export const getProfile = action({
  args: {
    userId: v.string(),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.array(profileResult),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    const profiles = await getProfileMemory(config, { userId: args.userId });
    return profiles.map((p) => ({
      everosMemoryId: p.id,
      scenario: p.scenario,
      summary: p.profile_data?.summary,
      explicitInfo: p.profile_data?.explicit_info ?? [],
      implicitTraits: p.profile_data?.implicit_traits ?? [],
    }));
  },
});

// ===========================================================================
// forgetSession (action) — delete one session's memories, remote + local
// ===========================================================================
// v2 deletes by scope only (user_id / agent_id / session_id); there is no
// single-memory delete endpoint.

export const clearSessionLocal = internalMutation({
  args: {
    userId: v.string(),
    sessionId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    // A page at a time, like clearUserLocal: collecting a heavy user's whole
    // history in one transaction makes deletion fail for exactly the users
    // most likely to ask for it. Paged by cursor rather than by re-reading
    // the head: rows from other sessions are left in place, so a head re-read
    // stalls in front of them forever once the first page holds no match —
    // deleting nothing yet always reporting more to do.
    // by_user_and_status, keyed on its userId prefix: this walk doesn't care
    // about status order, so a second narrower index would be pure write cost.
    const { page, isDone, continueCursor } = await paginator(ctx.db, schema)
      .query("pending")
      .withIndex("by_user_and_status", (q) => q.eq("userId", args.userId))
      .paginate({ numItems: DELETE_PAGE, cursor: args.cursor });
    for (const row of page) {
      if (effectiveSessionId(row.userId, row.sessionId) === args.sessionId) {
        await ctx.db.delete(row._id);
      }
    }
    return { isDone, continueCursor };
  },
});

export const forgetSession = action({
  args: {
    userId: v.string(),
    sessionId: v.string(),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    // Ingest rewrites the session id (a sessionless remember lands in a
    // per-user session, and long ids are truncated), so deleting under the
    // caller's raw id would silently match nothing on both sides.
    const sessionId = effectiveSessionId(args.userId, args.sessionId);
    const { deletedCount } = await deleteSessionMemories(config, { sessionId });
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const res: { isDone: boolean; continueCursor: string } =
        await ctx.runMutation(internal.lib.clearSessionLocal, {
          userId: args.userId,
          sessionId,
          cursor,
        });
      isDone = res.isDone;
      cursor = res.continueCursor;
    }
    return { deletedCount };
  },
});

// ===========================================================================
// forgetUser (action) — delete ALL of a user's memories, remote + local
// ===========================================================================

// Deletes a page at a time and reports whether more remains. Collecting a
// user's whole history in one transaction makes deletion fail exactly for the
// heaviest users — the ones most likely to invoke an erasure request.
const DELETE_PAGE = 200;

export const clearUserLocal = internalMutation({
  args: { userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    let budget = DELETE_PAGE;
    for (const table of ["pending"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_user_and_status", (q) => q.eq("userId", args.userId))
        .take(budget + 1);
      for (const row of rows.slice(0, budget)) await ctx.db.delete(row._id);
      budget -= Math.min(rows.length, budget);
      if (budget <= 0) return true; // more to do
    }
    return false;
  },
});

export const forgetUser = action({
  args: {
    userId: v.string(),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    const { deletedCount } = await deleteUserMemories(config, {
      userId: args.userId,
    });
    // Loop rather than delete everything in one transaction.
    let more = true;
    while (more) {
      more = await ctx.runMutation(internal.lib.clearUserLocal, {
        userId: args.userId,
      });
    }
    return { deletedCount };
  },
});

// ===========================================================================
// listMemories (action) — page through what EverOS actually holds
// ===========================================================================

// Backed by EverOS rather than by a local mirror of past recall results: a
// list that only contains what you happened to search for is not a list of a
// user's memories, and a "what do you know about me" screen built on one
// silently omits everything.
export const listMemories = action({
  args: {
    userId: v.string(),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  returns: v.object({
    memories: v.array(recalledMemory),
    totalCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    const { episodes, totalCount } = await getEpisodes(config, {
      userId: args.userId,
      page: args.page,
      pageSize: args.pageSize,
    });
    return {
      memories: episodes.map((ep) => episodeToMemory(ep, args.userId)),
      totalCount,
    };
  },
});

// ===========================================================================
// getPendingStatus (query) — is anything stuck?
// ===========================================================================

// Ingest and extraction both happen after `remember` returns, in scheduled
// actions. Without a way to read their outcome, a bad API key or a stalled
// extraction is indistinguishable from "extraction is just slow".
export const getPendingStatus = query({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({
    unextracted: v.number(),
    failed: v.number(),
    capped: v.boolean(),
    lastError: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    // Reactive callers re-run this whenever the queue changes, so the default
    // is a number worth reading rather than an exact census: four index reads
    // of this size, and `capped` says when the real figure is higher.
    const cap = args.limit ?? 25;
    let unextracted = 0;
    let failed = 0;
    let capped = false;
    let lastError: string | undefined;
    let newestErrorAt = -1;
    for (const status of ["queued", "sending", "sent", "failed"] as const) {
      const page = await ctx.db
        .query("pending")
        .withIndex("by_user_and_status", (q) =>
          q.eq("userId", args.userId).eq("status", status),
        )
        .order("desc")
        .take(cap + 1);
      if (page.length > cap) capped = true;
      const counted = page.slice(0, cap);
      if (status === "failed") failed += counted.length;
      else unextracted += counted.length;
      for (const row of counted) {
        if (row.lastError && row._creationTime > newestErrorAt) {
          newestErrorAt = row._creationTime;
          lastError = row.lastError;
        }
      }
    }
    return { unextracted, failed, capped, lastError };
  },
});

// ===========================================================================
// listMemories (query) — paginated local index per user
// ===========================================================================

