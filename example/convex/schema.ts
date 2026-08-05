import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Demo app tables. The agents' threads/messages live in the agent component;
// the memory index lives in the EverOS component.
export default defineSchema({
  // One support conversation (ticket) per customer. Starts on tier1 (frontline
  // bot); `escalate` opens a fresh tier2 thread — the specialist agent knows
  // the customer only through EverOS memory, not chat history.
  conversations: defineTable({
    customerId: v.string(),
    ticketNo: v.string(),
    subject: v.string(),
    currentTier: v.union(v.literal("tier1"), v.literal("tier2")),
    tier1ThreadId: v.string(),
    tier2ThreadId: v.optional(v.string()),
    escalatedAt: v.optional(v.number()),
    seeded: v.boolean(),
  }).index("by_customer", ["customerId"]),

  // Latest set of memories recalled for a conversation — shown live in the
  // agent console (with atomic facts for traceability).
  recalls: defineTable({
    conversationId: v.string(),
    memories: v.array(
      v.object({
        everosMemoryId: v.string(),
        text: v.string(),
        kind: v.string(),
        atomicFacts: v.optional(
          v.array(
            v.object({
              text: v.string(),
              score: v.optional(v.number()),
              timestamp: v.optional(v.number()),
            }),
          ),
        ),
      }),
    ),
    ts: v.number(),
  }).index("by_conversation", ["conversationId"]),

  // Memory pipeline activity feed (remembered / recalled / escalated / seeded)
  // — rendered as a live log in the console.
  memoryEvents: defineTable({
    customerId: v.string(),
    conversationId: v.string(),
    type: v.union(
      v.literal("seeded"),
      v.literal("remembered"),
      v.literal("recalled"),
      v.literal("escalated"),
    ),
    detail: v.string(),
    ts: v.number(),
  }).index("by_conversation", ["conversationId"]),
});
