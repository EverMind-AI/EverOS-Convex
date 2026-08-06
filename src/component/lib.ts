import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
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
import schema, { kind } from "./schema.js";
import {
  addMemories,
  deleteSessionMemories,
  deleteUserMemories,
  flushExtraction,
  getProfileMemory,
  memoryTypeToKind,
  normalizeTimestamp,
  searchMemories,
  type EverosConfig,
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

// Full-document validator for the local memories index (ids become strings at
// the component boundary).
const memoryDoc = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  userId: v.string(),
  everosMemoryId: v.string(),
  kind,
  preview: v.string(),
  sessionId: v.optional(v.string()),
  syncedAt: v.number(),
});

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
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    eager: v.optional(v.boolean()),
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
      status: "queued",
      attempts: 0,
    });
    await ctx.db.insert("usage", {
      userId: args.userId,
      op: "remember",
      ts: Date.now(),
    });
    // Mutations can't call external APIs — hand off to a scheduled action.
    await ctx.scheduler.runAfter(0, internal.lib.flush, {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
      eager: args.eager,
    });
    return { pendingId };
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
    eager: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id("pending"),
      userId: v.string(),
      content: v.string(),
      role: v.union(v.literal("user"), v.literal("assistant")),
      sessionId: v.optional(v.string()),
      attempts: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 25;
    const now = Date.now();
    const rows = await ctx.db
      .query("pending")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(limit);
    // Top up with rows abandoned by an action that never reported back.
    if (rows.length < limit) {
      const stale = await ctx.db
        .query("pending")
        .withIndex("by_status", (q) => q.eq("status", "sending"))
        .take(limit - rows.length);
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
    // Opportunistic cleanup of rows left behind by 0.1, which marked a row
    // `extracted` instead of deleting it. Bounded so a large backlog is
    // cleared over several flushes rather than in one oversized transaction.
    const legacy = await ctx.db
      .query("pending")
      .withIndex("by_status", (q) => q.eq("status", "extracted"))
      .take(50);
    for (const r of legacy) await ctx.db.delete(r._id);

    const claimed = [];
    for (const r of rows) {
      await ctx.db.patch(r._id, { status: "sending", claimedAt: now });
      claimed.push({
        _id: r._id,
        userId: r.userId,
        content: r.content,
        role: r.role,
        sessionId: r.sessionId,
        attempts: r.attempts,
      });
    }

    // Schedule the recovery sweep here, not at the end of the flush: if the
    // action dies right after claiming, code at the end of it never runs, and
    // the rows would sit in `sending` forever because only `remember` and a
    // failed flush schedule a flush. Committing the sweep in the same
    // transaction as the claim makes recovery durable. It terminates on its
    // own — a sweep that claims nothing schedules nothing.
    if (claimed.length > 0) {
      await ctx.scheduler.runAfter(STALE_CLAIM_MS + 1_000, internal.lib.flush, {
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        appId: args.appId,
        projectId: args.projectId,
        eager: args.eager,
      });
    }
    return claimed;
  },
});

export const markSent = internalMutation({
  args: { ids: v.array(v.id("pending")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.patch(id, { status: "sent", claimedAt: undefined });
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
  args: { ids: v.array(v.id("pending")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row && row.status === "sent") {
        // Delete rather than mark: once EverOS holds the memory this row has
        // no further purpose, and keeping it would grow the table for the
        // lifetime of the app and slow every subsequent read of it.
        await ctx.db.delete(id);
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
    // When true (default), ask EverOS to extract immediately after ingest so
    // content becomes recallable right away. EverOS Cloud does not extract on
    // a schedule of its own, so without this ingested messages sit in the
    // accumulation buffer indefinitely.
    eager: v.optional(v.boolean()),
  },
  returns: v.object({ sent: v.number(), failed: v.number() }),
  handler: async (ctx, args) => {
    const config: EverosConfig = {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
    };
    const claimed = await ctx.runMutation(internal.lib.claimQueued, {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      appId: args.appId,
      projectId: args.projectId,
      eager: args.eager,
    });
    let sent = 0;
    let failed = 0;
    let retryAfter = -1;

    // Group by (userId, session) and send each group as ONE ingest call:
    // fewer server-side tasks and faster extraction than one call per message.
    const groups = new Map<string, typeof claimed>();
    for (const item of claimed) {
      const key = `${item.userId} ${effectiveSessionId(item.userId, item.sessionId)}`;
      const g = groups.get(key);
      if (g) g.push(item);
      else groups.set(key, [item]);
    }

    for (const group of groups.values()) {
      const { userId } = group[0];
      const sessionId = effectiveSessionId(userId, group[0].sessionId);
      const ids = group.map((item) => item._id);
      try {
        await addMemories(config, {
          sessionId,
          messages: group.map((item, i) => ({
            role: item.role,
            // Preserve ordering within the batch.
            timestamp: Date.now() - (group.length - i),
            content: item.content,
            // v2 attributes memories via per-message sender_id — without a
            // user-id sender on user messages, nothing is extracted for them.
            sender_id: item.role === "user" ? userId : "assistant",
          })),
        });
        await ctx.runMutation(internal.lib.markSent, { ids });
        sent += group.length;
        if (args.eager !== false) {
          // Don't flush inline: an ingest takes ~10s to land in the
          // accumulation buffer server-side, and a flush before that is a
          // silent no-op. Schedule past the landing window instead.
          await ctx.scheduler.runAfter(
            EXTRACTION_DELAY_MS,
            internal.lib.runExtraction,
            {
              apiKey: args.apiKey,
              baseUrl: args.baseUrl,
              appId: args.appId,
              projectId: args.projectId,
              sessionId,
              ids,
            },
          );
        }
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
        eager: args.eager,
      });
    }
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
      await ctx.runMutation(internal.lib.markExtracted, { ids: args.ids });
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
    await ctx.runMutation(internal.lib.markExtractionStalled, {
      ids: args.ids,
      error:
        lastError ??
        "EverOS reported no extraction after repeated flushes; the content is " +
          "ingested but not yet searchable.",
    });
    return null;
  },
});

// ===========================================================================
// recall (action) — query EverOS retrieval API
// ===========================================================================

export const upsertMemory = internalMutation({
  args: {
    userId: v.string(),
    everosMemoryId: v.string(),
    kind,
    preview: v.string(),
    sessionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memories")
      .withIndex("by_user_and_everosMemoryId", (q) =>
        q.eq("userId", args.userId).eq("everosMemoryId", args.everosMemoryId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        kind: args.kind,
        preview: args.preview,
        sessionId: args.sessionId,
        syncedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("memories", {
        userId: args.userId,
        everosMemoryId: args.everosMemoryId,
        kind: args.kind,
        preview: args.preview,
        sessionId: args.sessionId,
        syncedAt: Date.now(),
      });
    }
    return null;
  },
});

export const logUsage = internalMutation({
  args: {
    userId: v.string(),
    op: v.union(v.literal("remember"), v.literal("recall")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("usage", {
      userId: args.userId,
      op: args.op,
      ts: Date.now(),
    });
    return null;
  },
});

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
      lastError: v.optional(v.string()),
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
        lastError: r.lastError,
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
      const text = ep.episode ?? ep.summary ?? ep.subject ?? "";
      results.push({
        everosMemoryId: ep.id,
        userId: args.userId,
        kind: ep.type ? memoryTypeToKind(ep.type) : "episodic",
        text,
        // Live API quirks: optional strings come back as null (validators want
        // undefined), score is null when unscored, timestamp is an ISO string.
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
      });
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

    // Hydrate the local reactive index and log usage.
    for (const r of results) {
      await ctx.runMutation(internal.lib.upsertMemory, {
        userId: r.userId,
        everosMemoryId: r.everosMemoryId,
        kind: r.kind,
        preview: r.text.slice(0, 280),
        sessionId: r.sessionId,
      });
    }
    await ctx.runMutation(internal.lib.logUsage, {
      userId: args.userId,
      op: "recall",
    });

    // Read-your-writes: EverOS extraction is asynchronous, so content saved
    // moments ago isn't searchable yet. Append it from the local queue
    // (unranked, marked pending) so it's never invisible to the agent.
    if (args.includeRecent !== false && args.kind !== "profile") {
      // Bounded by topK so the caller's result budget still means something:
      // these rows are unranked, so they cannot be allowed to crowd out the
      // ranked matches in an agent's context window.
      const recent = await ctx.runQuery(internal.lib.getUnextracted, {
        userId: args.userId,
        limit: Math.min(args.topK ?? DEFAULT_PENDING_MERGE_LIMIT, DEFAULT_PENDING_MERGE_LIMIT),
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
  args: { userId: v.string(), sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of memories) {
      if (row.sessionId === args.sessionId) await ctx.db.delete(row._id);
    }
    const pending = await ctx.db
      .query("pending")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of pending) {
      if (effectiveSessionId(row.userId, row.sessionId) === args.sessionId) {
        await ctx.db.delete(row._id);
      }
    }
    return null;
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
    await ctx.runMutation(internal.lib.clearSessionLocal, {
      userId: args.userId,
      sessionId,
    });
    return { deletedCount };
  },
});

// ===========================================================================
// forgetUser (action) — delete ALL of a user's memories, remote + local
// ===========================================================================

export const clearUserLocal = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of memories) await ctx.db.delete(row._id);
    const pending = await ctx.db
      .query("pending")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of pending) await ctx.db.delete(row._id);
    const usage = await ctx.db
      .query("usage")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of usage) await ctx.db.delete(row._id);
    return null;
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
    await ctx.runMutation(internal.lib.clearUserLocal, {
      userId: args.userId,
    });
    return { deletedCount };
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
    const cap = args.limit ?? 100;
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

export const listMemories = query({
  args: {
    userId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(memoryDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    return await paginator(ctx.db, schema)
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
