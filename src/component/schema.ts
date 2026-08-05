import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The three memory "kinds" surfaced to app developers. These map onto EverOS
// memory types on the wire (see `everos.ts`):
//   episodic -> "episode"
//   semantic -> "profile"
//   profile  -> "profile"
export const kind = v.union(
  v.literal("episodic"),
  v.literal("semantic"),
  v.literal("profile"),
);

// queued -> sent (ingested, awaiting extraction) -> extracted | failed.
// Rows in queued/sent are merged into recall results as read-your-writes
// (EverOS extraction is asynchronous); extracted rows drop out of that merge.
export const pendingStatus = v.union(
  v.literal("queued"),
  v.literal("sent"),
  v.literal("extracted"),
  v.literal("failed"),
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
    metadata: v.optional(v.record(v.string(), v.any())),
    status: pendingStatus,
    attempts: v.number(),
    // Deprecated: v1 ingest returned a task id; v2 has none. Kept optional so
    // rows written by earlier versions still validate.
    everosTaskId: v.optional(v.string()),
    lastError: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_user", ["userId"]),

  // Optional usage log for billing / analytics examples.
  usage: defineTable({
    userId: v.string(),
    op: v.union(v.literal("remember"), v.literal("recall")),
    ts: v.number(),
  }).index("by_user", ["userId"]),
});
