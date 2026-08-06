import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The memory kinds surfaced to app developers, mapping onto EverOS wire
// memory types (see `everos.ts`): episodic -> "episode", profile -> "profile".
// There is deliberately no "semantic": nothing ever produced it, so asking for
// it returned rows labelled "profile" and a `kind === "semantic"` filter
// always came back empty.
export const kind = v.union(v.literal("episodic"), v.literal("profile"));

// queued -> sending -> sent, then the row is deleted once EverOS confirms
// extraction (it has no purpose after that, and keeping it would grow the
// table forever). `sending` is a claim: a row is flipped into it inside a
// mutation so concurrent flush actions cannot pick up the same row and ingest
// it twice. Rows still here are merged into recall results as read-your-writes,
// because extraction is asynchronous. `failed` rows are kept deliberately, as
// the only record that content never made it.
export const pendingStatus = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  // Never written any more: 0.1 kept a row after extraction instead of
  // deleting it. Still accepted so that upgrading an app whose table holds
  // such rows does not fail schema validation on deploy; `claimQueued`
  // clears them out a batch at a time.
  v.literal("extracted"),
);

export default defineSchema({
  // Local, reactive index of what's stored in EverOS. Populated from retrieval
  // results (EverOS ingest is asynchronous and returns a task id, not a memory
  // id, so rows are hydrated when memories come back from `recall`/`getProfile`).
  // Keeping a local mirror lets app queries/joins stay reactive inside Convex.
  memories: defineTable({
    userId: v.string(), // app-owned id, so v.string() not v.id(...)
    everosMemoryId: v.string(),
    kind: kind,
    preview: v.string(),
    // EverOS session the memory was extracted from (when known) — lets
    // forgetSession clear the matching local rows.
    sessionId: v.optional(v.string()),
    syncedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_everosMemoryId", ["everosMemoryId"])
    .index("by_user_and_everosMemoryId", ["userId", "everosMemoryId"]),

  // Write-ahead queue. A mutation enqueues (mutations can't call external APIs);
  // a scheduled action flushes queued rows to the EverOS ingest API.
  pending: defineTable({
    userId: v.string(),
    content: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    sessionId: v.optional(v.string()),
    status: pendingStatus,
    attempts: v.number(),
    // When the row was claimed into `sending`, so a flush that never reported
    // back can be reclaimed instead of stranding the row.
    claimedAt: v.optional(v.number()),
    // When EverOS accepted the ingest. A successful extraction drains the
    // whole session buffer, so it covers every row ingested before it ran;
    // this is what lets one extraction retire its siblings' rows without
    // guessing.
    sentAt: v.optional(v.number()),
    // Which EverOS namespace the row was enqueued for. One deployment may hold
    // more than one client (staging and production, say), and a flush must not
    // ingest one client's rows under another's scope.
    appId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    // Neither of these is written any more. They are still declared because
    // Convex validates every existing document against the schema on deploy,
    // so removing a field that an earlier version wrote turns an upgrade into
    // a failed deploy for the consuming app.
    //   metadata:     0.1 accepted and stored it but never sent it anywhere.
    //   everosTaskId: the v1 ingest API returned a task id; v2 has none.
    metadata: v.optional(v.record(v.string(), v.any())),
    everosTaskId: v.optional(v.string()),
    lastError: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_user", ["userId"])
    // Recall reads only a user's unextracted rows; without this it would scan
    // every row the user has ever written.
    .index("by_user_and_status", ["userId", "status"]),

  // Optional usage log for billing / analytics examples.
  usage: defineTable({
    userId: v.string(),
    op: v.union(v.literal("remember"), v.literal("recall")),
    ts: v.number(),
  }).index("by_user", ["userId"]),
});
