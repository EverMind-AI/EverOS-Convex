import { v } from "convex/values";
import { EverOS } from "@everos-ai/convex";
import { components } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";

// Direct memory smoke-test entrypoints (no LLM involved) — used to verify the
// component end-to-end against real EverOS Cloud from a deployed Convex app:
// Internal on purpose: these write to and read from our real EverOS account.
// A public mutation here is an anonymous write primitive against it.
//   npx convex run memoryTest:remember '{"content":"..."}'
//   npx convex run memoryTest:recall '{"query":"..."}'
//   npx convex run memoryTest:status '{}'
//   npx convex run memoryTest:forget '{}'
// Pass `userId` to keep one run's data apart from another's.
const everos = new EverOS(components.everos);
const TEST_USER = "e2e-test-user";

export const remember = internalMutation({
  args: {
    content: v.string(),
    userId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    senderName: v.optional(v.string()),
  },
  handler: async (ctx, { content, userId, sessionId, senderName }) => {
    return await everos.remember(ctx, {
      userId: userId ?? TEST_USER,
      content,
      sessionId,
      senderName,
    });
  },
});

export const recall = internalAction({
  args: { query: v.string(), userId: v.optional(v.string()) },
  handler: async (ctx, { query, userId }) => {
    return await everos.recall(ctx, {
      userId: userId ?? TEST_USER,
      query,
      topK: 5,
    });
  },
});

/** What is still on its way to EverOS for the test user, and why if stuck. */
export const status = internalQuery({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, { userId }) => {
    return await everos.getPendingStatus(ctx, { userId: userId ?? TEST_USER });
  },
});

/** Clean up: delete the test user's memories in EverOS and locally. */
export const forget = internalAction({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, { userId }) => {
    return await everos.forgetUser(ctx, { userId: userId ?? TEST_USER });
  },
});
