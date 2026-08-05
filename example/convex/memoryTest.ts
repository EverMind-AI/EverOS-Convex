import { v } from "convex/values";
import { EverOS } from "@everos/convex";
import { components } from "./_generated/api.js";
import { action, mutation } from "./_generated/server.js";

// Direct memory smoke-test entrypoints (no LLM involved) — used to verify the
// component end-to-end against real EverOS Cloud from a deployed Convex app:
//   npx convex run memoryTest:remember '{"content":"..."}'
//   npx convex run memoryTest:recall '{"query":"..."}'
const everos = new EverOS(components.everos);
const TEST_USER = "e2e-test-user";

export const remember = mutation({
  args: { content: v.string() },
  handler: async (ctx, { content }) => {
    return await everos.remember(ctx, { userId: TEST_USER, content });
  },
});

export const recall = action({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    return await everos.recall(ctx, { userId: TEST_USER, query, topK: 5 });
  },
});
