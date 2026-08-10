import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { Agent, stepCountIs } from "@convex-dev/agent";
import { createOpenAI } from "@ai-sdk/openai";
import { EverOS } from "@everos-ai/convex";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// ---------------------------------------------------------------------------
// LLM providers — two DIFFERENT models so the two support tiers genuinely run
// on different providers. OpenRouter is OpenAI-API-compatible.
// ---------------------------------------------------------------------------
const useOpenRouter = !!process.env.OPENROUTER_API_KEY;
const provider = createOpenAI(
  useOpenRouter
    ? {
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      }
    : {},
);
const MODEL_TIER1 =
  process.env.LLM_MODEL_A ??
  (useOpenRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini");
const MODEL_TIER2 =
  process.env.LLM_MODEL_B ??
  (useOpenRouter ? "meta-llama/llama-3.3-70b-instruct" : MODEL_TIER1);

// Long-term customer memory, backed by EverOS Cloud. The customerId is
// generated per-browser on the frontend and passed into every function.
//
// The demo runs in its own namespace on the EverOS account. Anyone can type
// into a public demo, so its memories must not be searchable or deletable
// from whatever else that account holds. Issuing a second API key does not do
// this: keys on one account share a namespace.
export const everos = new EverOS(components.everos, {
  appId: "convex-demo",
  projectId: "convex-demo",
});

// ---------------------------------------------------------------------------
// The two support agents. They share NO chat history — a tier-2 escalation
// opens a brand-new thread. Everything the specialist knows about the customer
// comes from EverOS memory.
// ---------------------------------------------------------------------------
function makeAgent(name: string, model: string, role: string) {
  return new Agent(components.agent, {
    name,
    languageModel: provider.chat(model),
    instructions:
      `You are ${name}, ${role} for Lumon, a developer-tools SaaS ` +
      "(APIs, webhooks, dashboards; Free/Pro/Enterprise plans). " +
      "You have long-term memory of this customer shared across all their " +
      "past conversations and other support agents, provided as context or " +
      "retrievable with the searchMemory tool. Use it — never ask the " +
      "customer to repeat information they've already given. " +
      "Be concise and professional; plain text only, no markdown headers.",
    stopWhen: stepCountIs(5),
  });
}

export const AGENTS = {
  tier1: {
    key: "tier1",
    label: "Mindy",
    sub: "Frontline AI agent",
    model: MODEL_TIER1,
    agent: makeAgent(
      "Mindy",
      MODEL_TIER1,
      "the frontline support agent. Handle common questions; for complex " +
        "account-specific issues suggest the customer escalate to a specialist",
    ),
  },
  tier2: {
    key: "tier2",
    label: "Mindy Pro",
    sub: "Specialist AI agent",
    model: MODEL_TIER2,
    agent: makeAgent(
      "Mindy Pro",
      MODEL_TIER2,
      "the senior support specialist handling escalations. You take over " +
        "conversations mid-flight",
    ),
  },
} as const;

// Any agent instance can read/delete threads (they're keyed by threadId).
export const anyAgent = AGENTS.tier1.agent;

// Facts "remembered from a previous session" — seeded once per customer so the
// demo starts as a returning customer with an existing memory profile.
const PRIOR_SESSION_FACTS = [
  "My name is Alex Chen and I'm on the Pro plan, billed annually.",
  "I mainly use the REST API and webhooks; my stack is Node.js on Vercel.",
  "Last month I kept hitting rate limits and support raised my limit to 10k requests/min.",
  "I had a webhook delivery bug before — retries with exponential backoff fixed it.",
  "Please follow up by email, not phone. My timezone is US Pacific.",
];

// The demo runs on our own LLM key with no sign-in, so each conversation gets
// a fixed budget. A visitor can start over with a new browser profile; this is
// a spend guard against loops and casual abuse, not access control.
const DEMO_MESSAGE_LIMIT = 12;
// A budgeted message is only a spend bound if the message itself is bounded:
// the agent runs up to 5 steps, each resending the full context.
const MAX_PROMPT_CHARS = 2000;

// ---------------------------------------------------------------------------
// Conversation lifecycle
// ---------------------------------------------------------------------------

export const getConversation = query({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .unique();
    if (!conv) return null;
    return {
      _id: conv._id,
      ticketNo: conv.ticketNo,
      subject: conv.subject,
      currentTier: conv.currentTier,
      tier1ThreadId: conv.tier1ThreadId,
      tier2ThreadId: conv.tier2ThreadId ?? null,
      escalatedAt: conv.escalatedAt ?? null,
      tiers: {
        tier1: { label: AGENTS.tier1.label, sub: AGENTS.tier1.sub, model: AGENTS.tier1.model },
        tier2: { label: AGENTS.tier2.label, sub: AGENTS.tier2.sub, model: AGENTS.tier2.model },
      },
    };
  },
});

export const logEvent = internalMutation({
  args: {
    customerId: v.string(),
    conversationId: v.string(),
    type: v.union(
      v.literal("seeded"),
      v.literal("remembered"),
      v.literal("recalled"),
      v.literal("escalated"),
    ),
    detail: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("memoryEvents", { ...args, ts: Date.now() });
  },
});

// Idempotent: create the customer's conversation + tier1 thread. Safe across
// tabs (Convex mutations are transactional).
export const ensureConversation = mutation({
  args: { customerId: v.string() },
  returns: v.object({ conversationId: v.string(), needsSeed: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .unique();
    if (existing) {
      return { conversationId: existing._id, needsSeed: !existing.seeded };
    }
    const { threadId } = await AGENTS.tier1.agent.createThread(ctx, {
      userId: args.customerId,
    });
    const conversationId = await ctx.db.insert("conversations", {
      customerId: args.customerId,
      ticketNo: `#${4800 + Math.floor(Math.random() * 200)}`,
      subject: "API & billing",
      currentTier: "tier1",
      tier1ThreadId: threadId,
      seeded: false,
    });
    return { conversationId, needsSeed: true };
  },
});

export const markSeeded = internalMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, { seeded: true });
  },
});

// Seed the "previous session": remember a handful of facts for this customer
// so the console opens with a real memory profile. Runs once per customer.
export const seedReturningCustomer = action({
  args: { customerId: v.string(), conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const fact of PRIOR_SESSION_FACTS) {
      await everos.remember(ctx, {
        userId: args.customerId,
        content: fact,
        sessionId: "prior-session",
      });
    }
    await ctx.runMutation(internal.chat.markSeeded, {
      conversationId: args.conversationId as any,
    });
    await ctx.runMutation(internal.chat.logEvent, {
      customerId: args.customerId,
      conversationId: args.conversationId,
      type: "seeded",
      detail: `Imported ${PRIOR_SESSION_FACTS.length} facts from previous session`,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Console queries
// ---------------------------------------------------------------------------

export const listThreadMessages = query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await anyAgent.listMessages(ctx, {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    });
  },
});

export const getRecalls = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("recalls")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
  },
});

// Live view of the write pipeline. EverOS extraction is asynchronous, so
// without this the console looks idle between "you said it" and "it is
// searchable" — and a genuine failure looks the same as slow indexing.
export const getMemoryPipeline = query({
  args: { customerId: v.string() },
  returns: v.object({
    unextracted: v.number(),
    failed: v.number(),
    capped: v.boolean(),
    lastError: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    return await everos.getPendingStatus(ctx, { userId: args.customerId });
  },
});

export const listMemoryEvents = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("memoryEvents")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    return events.sort((a, b) => b.ts - a.ts).slice(0, 30);
  },
});

// The customer memory profile: everything EverOS can recall about them,
// aggregated from a broad query. Shown as the "Customer memory" card.
export const getCustomerMemory = action({
  args: { customerId: v.string() },
  returns: v.array(
    v.object({
      text: v.string(),
      score: v.optional(v.number()),
      timestamp: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    // Primary source: the extracted user profile — structured facts with an
    // evidence trail, exactly what a "who is this customer" card wants.
    // (Atomic facts alone don't fill a panel: search embeds a fact only when
    // that fact is what drove the episode's recall.)
    const profiles = await everos.getProfile(ctx, { userId: args.customerId });
    const out: { text: string; score?: number; timestamp?: number }[] = [];
    const seen = new Set<string>();
    const push = (text: string, score?: number, timestamp?: number) => {
      const k = text.toLowerCase().replace(/\W+/g, " ").trim();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ text, score, timestamp });
    };

    for (const p of profiles) {
      for (const item of [...p.explicitInfo, ...p.implicitTraits]) {
        const d = item as { description?: string };
        if (d.description) push(d.description);
      }
    }

    // Augment with recall: high-scoring atomic facts, then episode summaries,
    // then not-yet-extracted content (so a freshly seeded customer still
    // shows a panel before extraction lands).
    const recalled = await everos.recall(ctx, {
      userId: args.customerId,
      query:
        "customer profile: name, plan, stack, past issues, limits, preferences",
      topK: 5,
    });
    const facts = recalled
      .flatMap((m) => m.atomicFacts ?? [])
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const f of facts) push(f.text, f.score, f.timestamp);
    for (const m of recalled) {
      if (m.kind === "episodic") push(m.summary ?? m.text, m.score, m.timestamp);
    }

    return out.slice(0, 8);
  },
});

// ---------------------------------------------------------------------------
// Messaging + escalation
// ---------------------------------------------------------------------------

export const saveRecalls = internalMutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("recalls")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        memories: args.memories,
        ts: Date.now(),
      });
    } else {
      await ctx.db.insert("recalls", {
        conversationId: args.conversationId,
        memories: args.memories,
        ts: Date.now(),
      });
    }
  },
});

function toRecallRows(
  recalled: Awaited<ReturnType<EverOS["recall"]>>,
): Array<{
  everosMemoryId: string;
  text: string;
  kind: string;
  atomicFacts: { text: string; score?: number; timestamp?: number }[];
}> {
  return recalled.map((m) => ({
    everosMemoryId: m.everosMemoryId,
    text: m.text,
    kind: m.kind,
    atomicFacts: (m.atomicFacts ?? []).map((f) => ({
      text: f.text,
      score: f.score,
      timestamp: f.timestamp,
    })),
  }));
}

// Claim one message from the conversation's budget. A mutation so the
// check and the increment are a single transaction.
export const reserveMessageSlot = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.object({ allowed: v.boolean(), remaining: v.number() }),
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversationId);
    if (!conv) throw new Error("Conversation not found");
    const used = conv.messageCount ?? 0;
    if (used >= DEMO_MESSAGE_LIMIT) return { allowed: false, remaining: 0 };
    await ctx.db.patch(args.conversationId, { messageCount: used + 1 });
    return { allowed: true, remaining: DEMO_MESSAGE_LIMIT - used - 1 };
  },
});

export const sendMessage = action({
  args: {
    conversationId: v.string(),
    customerId: v.string(),
    prompt: v.string(),
  },
  returns: v.object({ text: v.string(), recalledCount: v.number() }),
  // MAX_PROMPT_CHARS below bounds what one budgeted message can cost.
  // The return type is annotated because this action calls a query declared in
  // the same module, which makes its type circular through the generated api.
  handler: async (
    ctx,
    args,
  ): Promise<{ text: string; recalledCount: number }> => {
    const conv: Doc<"conversations"> | null = await ctx.runQuery(
      internal.chat.getConvInternal,
      { conversationId: args.conversationId as Id<"conversations"> },
    );
    if (!conv) throw new Error("Conversation not found");

    if (args.prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `This shared demo caps messages at ${MAX_PROMPT_CHARS} characters.`,
      );
    }

    const slot = await ctx.runMutation(internal.chat.reserveMessageSlot, {
      conversationId: args.conversationId as Id<"conversations">,
    });
    if (!slot.allowed) {
      throw new Error(
        `This shared demo allows ${DEMO_MESSAGE_LIMIT} messages per ` +
          "conversation. Install the component to run it without limits: " +
          "npm i @everos-ai/convex",
      );
    }

    const def = AGENTS[conv.currentTier];
    const threadId =
      conv.currentTier === "tier2" && conv.tier2ThreadId
        ? conv.tier2ThreadId
        : conv.tier1ThreadId;

    // 1. Recall relevant long-term memories for this message.
    const recalled = await everos.recall(ctx, {
      userId: args.customerId,
      query: args.prompt,
      topK: 5,
    });

    // 2. Surface them in the console, reactively.
    await ctx.runMutation(internal.chat.saveRecalls, {
      conversationId: args.conversationId,
      memories: toRecallRows(recalled),
    });
    if (recalled.length > 0) {
      await ctx.runMutation(internal.chat.logEvent, {
        customerId: args.customerId,
        conversationId: args.conversationId,
        type: "recalled",
        detail: `${def.label} recalled ${recalled.length} memories for this message`,
      });
    }

    // 3. Context + live searchMemory tool.
    const contextMsgs =
      recalled.length > 0
        ? [
            {
              role: "system" as const,
              content:
                "Long-term memory about this customer (EverOS):\n" +
                recalled.map((m) => `- ${m.text}`).join("\n"),
            },
          ]
        : [];

    const result = await def.agent.generateText(
      ctx,
      { threadId, userId: args.customerId },
      {
        messages: contextMsgs,
        prompt: args.prompt,
        tools: { searchMemory: everos.asTool({ userId: args.customerId }) },
      },
    );

    // 4. Remember both halves of the turn for future sessions/agents.
    // Storing only the prompt loses the answers and the commitments, which is
    // exactly what a customer asks about when they come back.
    await everos.rememberMessages(ctx, {
      userId: args.customerId,
      messages: [
        { content: args.prompt, role: "user" },
        { content: result.text, role: "assistant" },
      ],
    });
    await ctx.runMutation(internal.chat.logEvent, {
      customerId: args.customerId,
      conversationId: args.conversationId,
      type: "remembered",
      detail: `Turn queued for memory extraction`,
    });

    return { text: result.text, recalledCount: recalled.length };
  },
});

export const getConvInternal = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.conversationId);
  },
});

export const setEscalated = internalMutation({
  args: { conversationId: v.id("conversations"), tier2ThreadId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      currentTier: "tier2",
      tier2ThreadId: args.tier2ThreadId,
      escalatedAt: Date.now(),
    });
  },
});

// Escalate to the specialist: brand-new thread, different agent, different
// model. Everything Mindy Pro knows about the customer comes from EverOS.
export const escalate = action({
  args: { conversationId: v.string(), customerId: v.string() },
  returns: v.object({ text: v.string(), recalledCount: v.number() }),
  // Annotated for the same reason as sendMessage above.
  handler: async (
    ctx,
    args,
  ): Promise<{ text: string; recalledCount: number }> => {
    const conv: Doc<"conversations"> | null = await ctx.runQuery(
      internal.chat.getConvInternal,
      { conversationId: args.conversationId as Id<"conversations"> },
    );
    if (!conv) throw new Error("Conversation not found");
    if (conv.currentTier === "tier2" && conv.tier2ThreadId) {
      return { text: "", recalledCount: 0 };
    }

    // Escalation runs a full tier-2 generation, so it draws on the same
    // budget as a message. Without this it is an unmetered LLM call.
    const slot = await ctx.runMutation(internal.chat.reserveMessageSlot, {
      conversationId: args.conversationId as Id<"conversations">,
    });
    if (!slot.allowed) {
      throw new Error(
        `This shared demo allows ${DEMO_MESSAGE_LIMIT} messages per ` +
          "conversation. Install the component to run it without limits: " +
          "npm i @everos-ai/convex",
      );
    }

    // Fresh thread for the specialist — zero shared chat history.
    const { threadId } = await AGENTS.tier2.agent.createThread(ctx, {
      userId: args.customerId,
    });

    // Pull the customer's context from EverOS long-term memory.
    const recalled = await everos.recall(ctx, {
      userId: args.customerId,
      query:
        "who is this customer: plan, stack, current issue, past issues, preferences",
      topK: 6,
    });
    await ctx.runMutation(internal.chat.saveRecalls, {
      conversationId: args.conversationId,
      memories: toRecallRows(recalled),
    });
    // Takeover greeting. Passed via `messages` only (not `prompt`), so no fake
    // customer message is persisted to the thread.
    const result = await AGENTS.tier2.agent.generateText(
      ctx,
      { threadId, userId: args.customerId },
      {
        messages: [
          {
            role: "system" as const,
            content:
              "Long-term memory about this customer (EverOS):\n" +
              recalled.map((m) => `- ${m.text}`).join("\n"),
          },
          {
            role: "user" as const,
            content:
              "[internal handoff note — not from the customer] You are taking " +
              "over this escalated conversation. Greet the customer by name, " +
              "show in one or two sentences that you're already up to speed " +
              "(their plan, setup, and current issue), and ask one targeted " +
              "question to move the issue forward. Do not ask them to repeat " +
              "anything.",
          },
        ],
        tools: { searchMemory: everos.asTool({ userId: args.customerId }) },
      },
      // Don't persist the internal handoff instruction into the thread —
      // we save only the greeting below. (storageOptions is the 4th arg.)
      { storageOptions: { saveMessages: "none" } },
    );

    // Persist just the specialist's greeting as the thread's first message.
    await AGENTS.tier2.agent.saveMessages(ctx, {
      threadId,
      userId: args.customerId,
      messages: [{ role: "assistant", content: result.text }],
      skipEmbeddings: true,
    });

    // Only flip the conversation to tier2 once the takeover greeting exists —
    // a failure above leaves the conversation cleanly on tier1 for retry.
    await ctx.runMutation(internal.chat.setEscalated, {
      conversationId: conv._id,
      tier2ThreadId: threadId,
    });
    await ctx.runMutation(internal.chat.logEvent, {
      customerId: args.customerId,
      conversationId: args.conversationId,
      type: "escalated",
      detail: `Escalated to ${AGENTS.tier2.label} (${AGENTS.tier2.model}) — new thread, context via EverOS (${recalled.length} memories)`,
    });

    return { text: result.text, recalledCount: recalled.length };
  },
});
