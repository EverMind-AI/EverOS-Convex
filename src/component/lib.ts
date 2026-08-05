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
    metadata: v.optional(v.record(v.string(), v.any())),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
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
      metadata: args.metadata,
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
      eager: args.eager,
    });
    return { pendingId };
  },
});

// ===========================================================================
// flush (internal action) — POST queued items to EverOS
// ===========================================================================

export const getQueued = internalQuery({
  args: { limit: v.optional(v.number()) },
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
    const rows = await ctx.db
      .query("pending")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(args.limit ?? 25);
    return rows.map((r) => ({
      _id: r._id,
      userId: r.userId,
      content: r.content,
      role: r.role,
      sessionId: r.sessionId,
      attempts: r.attempts,
    }));
  },
});

export const markSent = internalMutation({
  args: { id: v.id("pending") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "sent" });
    return null;
  },
});

export const markFailed = internalMutation({
  args: { id: v.id("pending"), attempts: v.number(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: args.attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      attempts: args.attempts,
      lastError: args.error,
    });
    return null;
  },
});

// Once EverOS confirms a session's buffer was extracted, its sent rows stop
// being merged into recall results (the real memories now cover them).
export const markExtracted = internalMutation({
  args: { userId: v.string(), sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pending")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of rows) {
      if (
        row.status === "sent" &&
        effectiveSessionId(row.userId, row.sessionId) === args.sessionId
      ) {
        await ctx.db.patch(row._id, { status: "extracted" });
      }
    }
    return null;
  },
});

export const flush = internalAction({
  args: {
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    // When true (default), ask EverOS to extract immediately after ingest so
    // content becomes recallable right away. The cloud does not extract on
    // its own schedule — without these flushes, ingested messages sit in the
    // accumulation buffer indefinitely.
    eager: v.optional(v.boolean()),
  },
  returns: v.object({ sent: v.number(), failed: v.number() }),
  handler: async (ctx, args) => {
    const config: EverosConfig = { apiKey: args.apiKey, baseUrl: args.baseUrl };
    const queued = await ctx.runQuery(internal.lib.getQueued, {});
    let sent = 0;
    let failed = 0;
    // Extraction buffers are keyed by session on the EverOS side — each
    // session must be flushed individually, so track exact pairs.
    const sentPairs = new Map<string, { userId: string; sessionId: string }>();

    // Group queued items by (userId, session) and send each group as ONE
    // ingest call — fewer server-side tasks and faster extraction than
    // one call per message.
    const groups = new Map<string, typeof queued>();
    for (const item of queued) {
      const key = `${item.userId} ${effectiveSessionId(item.userId, item.sessionId)}`;
      const g = groups.get(key);
      if (g) g.push(item);
      else groups.set(key, [item]);
    }

    for (const group of groups.values()) {
      const { userId } = group[0];
      const sessionId = effectiveSessionId(userId, group[0].sessionId);
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
        for (const item of group) {
          await ctx.runMutation(internal.lib.markSent, { id: item._id });
        }
        sentPairs.set(`${userId} ${sessionId}`, { userId, sessionId });
        sent += group.length;
      } catch (e) {
        failed += group.length;
        for (const item of group) {
          await ctx.runMutation(internal.lib.markFailed, {
            id: item._id,
            attempts: item.attempts + 1,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    if (args.eager !== false && sentPairs.size > 0) {
      // Don't flush inline: an ingest takes ~10s to land in the accumulation
      // buffer server-side, and a flush before that is a silent no-op.
      // Schedule the extraction after the landing window instead.
      await ctx.scheduler.runAfter(EXTRACTION_DELAY_MS, internal.lib.runExtraction, {
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        targets: [...sentPairs.values()],
      });
    }
    return { sent, failed };
  },
});

const EXTRACTION_DELAY_MS = 15_000;
// The ingest→buffer landing window is ~10s under normal load but can
// stretch; a flush during it returns "no_extraction" (a silent no-op).
// Retry with backoff until EverOS reports an actual extraction.
const EXTRACTION_RETRY_DELAYS_MS = [20_000, 40_000, 80_000];

export const runExtraction = internalAction({
  args: {
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    // (userId, sessionId) pairs — EverOS extraction buffers are keyed by
    // session, so each pair must be flushed individually.
    targets: v.array(
      v.object({ userId: v.string(), sessionId: v.string() }),
    ),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config: EverosConfig = { apiKey: args.apiKey, baseUrl: args.baseUrl };
    const attempt = args.attempt ?? 0;
    const needRetry: { userId: string; sessionId: string }[] = [];
    for (const target of args.targets) {
      // Best-effort: the messages are already durably ingested and stay
      // merged into recall results (pending rows) until extraction lands.
      try {
        const { status } = await flushExtraction(config, {
          sessionId: target.sessionId,
        });
        if (status === "extracted") {
          await ctx.runMutation(internal.lib.markExtracted, target);
        } else {
          // "no_extraction" means the ingest hadn't landed in the
          // accumulation buffer yet — try again later.
          needRetry.push(target);
        }
      } catch (e) {
        needRetry.push(target);
        console.warn(
          `EverOS flushExtraction failed for ${target.sessionId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    if (needRetry.length > 0 && attempt < EXTRACTION_RETRY_DELAYS_MS.length) {
      await ctx.scheduler.runAfter(
        EXTRACTION_RETRY_DELAYS_MS[attempt],
        internal.lib.runExtraction,
        {
          apiKey: args.apiKey,
          baseUrl: args.baseUrl,
          targets: needRetry,
          attempt: attempt + 1,
        },
      );
    }
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
    const rows = await ctx.db
      .query("pending")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return rows
      .filter(
        (r) =>
          (r.status === "queued" || r.status === "sent") &&
          r._creationTime > cutoff,
      )
      .slice(0, args.limit ?? 25)
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
  },
  returns: v.array(recalledMemory),
  handler: async (ctx, args) => {
    const config: EverosConfig = { apiKey: args.apiKey, baseUrl: args.baseUrl };
    const { episodes, profiles } = await searchMemories(config, {
      userId: args.userId,
      query: args.query,
      topK: args.topK,
      kind: args.kind,
    });

    const results: Array<{
      everosMemoryId: string;
      userId: string;
      kind: "episodic" | "semantic" | "profile";
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
      const recent = await ctx.runQuery(internal.lib.getUnextracted, {
        userId: args.userId,
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
  },
  returns: v.array(profileResult),
  handler: async (ctx, args) => {
    const config: EverosConfig = { apiKey: args.apiKey, baseUrl: args.baseUrl };
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
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const config: EverosConfig = { apiKey: args.apiKey, baseUrl: args.baseUrl };
    const { deletedCount } = await deleteSessionMemories(config, {
      sessionId: args.sessionId,
    });
    await ctx.runMutation(internal.lib.clearSessionLocal, {
      userId: args.userId,
      sessionId: args.sessionId,
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
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const config: EverosConfig = { apiKey: args.apiKey, baseUrl: args.baseUrl };
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
