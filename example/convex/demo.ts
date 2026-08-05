import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  action,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";
import { anyAgent, everos } from "./chat.js";

// Reset the demo for a fresh recording:
//   npx convex run demo:clearAll                              # wipe everything
//   npx convex run demo:clearAll '{"customerId":"<uuid>"}'    # one browser
//
// Deletes conversations + recalls + memory events, the agent component's
// threads/messages, and the customers' memories in EverOS Cloud (+ the
// component's local index).

export const listTargets = internalQuery({
  args: { customerId: v.optional(v.string()) },
  returns: v.object({
    threadIds: v.array(v.string()),
    customerIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const convs = args.customerId
      ? await ctx.db
          .query("conversations")
          .withIndex("by_customer", (q) =>
            q.eq("customerId", args.customerId!),
          )
          .collect()
      : await ctx.db.query("conversations").collect();
    const threadIds = convs.flatMap((c) =>
      c.tier2ThreadId ? [c.tier1ThreadId, c.tier2ThreadId] : [c.tier1ThreadId],
    );
    const customerIds = args.customerId
      ? [args.customerId]
      : [...new Set(convs.map((c) => c.customerId))];
    return { threadIds, customerIds };
  },
});

export const wipeAppRows = internalMutation({
  args: { customerId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const convs = args.customerId
      ? await ctx.db
          .query("conversations")
          .withIndex("by_customer", (q) =>
            q.eq("customerId", args.customerId!),
          )
          .collect()
      : await ctx.db.query("conversations").collect();
    for (const c of convs) {
      const recalls = await ctx.db
        .query("recalls")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .collect();
      for (const r of recalls) await ctx.db.delete(r._id);
      const events = await ctx.db
        .query("memoryEvents")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .collect();
      for (const e of events) await ctx.db.delete(e._id);
      await ctx.db.delete(c._id);
    }
    return null;
  },
});

export const clearAll = action({
  args: { customerId: v.optional(v.string()) },
  returns: v.object({
    conversationsDeleted: v.number(),
    customersCleared: v.number(),
  }),
  handler: async (ctx, args) => {
    const { threadIds, customerIds } = await ctx.runQuery(
      internal.demo.listTargets,
      { customerId: args.customerId },
    );
    for (const threadId of threadIds) {
      await anyAgent.deleteThreadSync(ctx, { threadId });
    }
    await ctx.runMutation(internal.demo.wipeAppRows, {
      customerId: args.customerId,
    });
    for (const customerId of customerIds) {
      await everos.forgetUser(ctx, { userId: customerId });
    }
    return {
      conversationsDeleted: threadIds.length,
      customersCleared: customerIds.length,
    };
  },
});
