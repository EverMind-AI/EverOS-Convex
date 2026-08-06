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
);

export default defineSchema({
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
    // When the caller says this was said, if they told us.
    saidAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    // Recall reads only a user's unextracted rows; without this it would scan
    // every row the user has ever written.
    .index("by_user_and_status", ["userId", "status"]),
});
