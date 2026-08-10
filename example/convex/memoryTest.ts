import { v } from "convex/values";
import { EverOS } from "@everos-ai/convex";
import { components } from "./_generated/api.js";
import { internalAction, internalMutation } from "./_generated/server.js";

// Direct memory smoke-test entrypoints (no LLM involved) — used to verify the
// component end-to-end against real EverOS Cloud from a deployed Convex app:
// Internal on purpose: these write to and read from our real EverOS account.
// A public mutation here is an anonymous write primitive against it.
//   npx convex run memoryTest:remember '{"content":"..."}'
//   npx convex run memoryTest:recall '{"query":"..."}'
const everos = new EverOS(components.everos);
const TEST_USER = "e2e-test-user";

export const remember = internalMutation({
  args: { content: v.string() },
  handler: async (ctx, { content }) => {
    return await everos.remember(ctx, { userId: TEST_USER, content });
  },
});

export const recall = internalAction({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    return await everos.recall(ctx, { userId: TEST_USER, query, topK: 5 });
  },
});
