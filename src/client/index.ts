import type { PaginationOptions, PaginationResult } from "convex/server";
import { createTool, type ToolCtx } from "@convex-dev/agent";
import { z } from "zod";
import type {
  ComponentApi,
  MemoryDoc,
  MemoryKind,
  MemoryProfile,
  PendingStatus,
  RecalledMemory,
} from "./component.js";

export type {
  AtomicFact,
  ComponentApi,
  MemoryDoc,
  MemoryKind,
  MemoryProfile,
  PendingStatus,
  RecalledMemory,
} from "./component.js";

export const DEFAULT_BASE_URL = "https://api.evermind.ai";

/** A chat message shape compatible with `@convex-dev/agent`'s `messages`. */
export type ContextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type EverOSOptions = {
  /** EverOS Cloud API key. Defaults to `process.env.EVEROS_API_KEY`. */
  apiKey?: string;
  /** EverOS Cloud base URL. Defaults to `process.env.EVEROS_BASE_URL` or the public cloud. */
  baseUrl?: string;
  /**
   * When true (the default), the component drives EverOS extraction after each
   * ingest so remembered content becomes searchable.
   *
   * EverOS Cloud does **not** extract on a schedule of its own: with this off,
   * ingested content stays in its buffer and never becomes searchable. Only
   * set it to false if your app calls the EverOS flush endpoint itself.
   */
  eagerExtraction?: boolean;
};

// Minimal, permissive ctx shapes so the same method works from a query,
// mutation, or action ctx (whose `run*` signatures differ slightly). The
// public method return types below stay precise.
type RunQueryCtx = { runQuery: (...args: any[]) => Promise<any> };
type RunMutationCtx = { runMutation: (...args: any[]) => Promise<any> };
type RunActionCtx = { runAction: (...args: any[]) => Promise<any> };

/**
 * Long-term memory for a Convex app, backed by EverOS Cloud.
 *
 * ```ts
 * const everos = new EverOS(components.everos);
 * await everos.remember(ctx, { userId, content });
 * const memories = await everos.recall(ctx, { userId, query, topK: 5 });
 * ```
 */
export class EverOS {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly eagerExtraction: boolean;

  constructor(
    public component: ComponentApi,
    options: EverOSOptions = {},
  ) {
    this.apiKey = options.apiKey ?? process.env.EVEROS_API_KEY ?? "";
    this.baseUrl =
      options.baseUrl ?? process.env.EVEROS_BASE_URL ?? DEFAULT_BASE_URL;
    this.eagerExtraction = options.eagerExtraction ?? true;
  }

  // Resolve credentials lazily (at call time, not construction) so that a
  // missing key never breaks module load / deploy analysis — only the actual
  // memory call fails, with a clear message.
  private creds() {
    if (!this.apiKey) {
      throw new Error(
        "Missing EverOS API key.\n\n" +
          "Set it with `npx convex env set EVEROS_API_KEY <key>` " +
          "or pass `{ apiKey }` to `new EverOS(...)`.\n" +
          "Get a free key at https://evermind.ai.",
      );
    }
    return { apiKey: this.apiKey, baseUrl: this.baseUrl };
  }

  /** Enqueue content to be remembered for a user. Flushed to EverOS async. */
  async remember(
    ctx: RunMutationCtx,
    args: {
      userId: string;
      content: string;
      role?: "user" | "assistant";
      sessionId?: string;
    },
  ): Promise<{ pendingId: string }> {
    return ctx.runMutation(this.component.lib.remember, {
      ...args,
      ...this.creds(),
      eager: this.eagerExtraction,
    });
  }

  /**
   * Retrieve memories relevant to a query, ranked by relevance.
   *
   * EverOS extraction is asynchronous, so content saved moments ago isn't
   * searchable yet — by default, recall also appends that content from the
   * component's local queue, marked `pending: true`. Pass
   * `includeRecent: false` to return only extracted memories.
   */
  async recall(
    ctx: RunActionCtx,
    args: {
      userId: string;
      query: string;
      topK?: number;
      kind?: MemoryKind;
      includeRecent?: boolean;
    },
  ): Promise<RecalledMemory[]> {
    return ctx.runAction(this.component.lib.recall, {
      ...args,
      ...this.creds(),
    });
  }

  /** Fetch a user's profile / semantic memory. */
  async getProfile(
    ctx: RunActionCtx,
    args: { userId: string },
  ): Promise<MemoryProfile[]> {
    return ctx.runAction(this.component.lib.getProfile, {
      ...args,
      ...this.creds(),
    });
  }

  /** Delete ALL of a user's memories in EverOS and clear the local index. */
  async forgetUser(
    ctx: RunActionCtx,
    args: { userId: string },
  ): Promise<{ deletedCount: number }> {
    return ctx.runAction(this.component.lib.forgetUser, {
      ...args,
      ...this.creds(),
    });
  }

  /**
   * Delete all memories extracted from one session, in EverOS and locally.
   * (The EverOS v2 API deletes by scope — user or session — not by
   * individual memory id.)
   */
  async forgetSession(
    ctx: RunActionCtx,
    args: { userId: string; sessionId: string },
  ): Promise<{ deletedCount: number }> {
    return ctx.runAction(this.component.lib.forgetSession, {
      ...args,
      ...this.creds(),
    });
  }

  /**
   * Whether anything a user remembered is still on its way to EverOS, and why
   * if it is stuck. `remember` returns before the network call happens, so
   * this is how an app surfaces a rejected API key or a stalled extraction
   * instead of it looking like slow indexing.
   */
  async getPendingStatus(
    ctx: RunQueryCtx,
    args: { userId: string; limit?: number },
  ): Promise<PendingStatus> {
    return ctx.runQuery(this.component.lib.getPendingStatus, args);
  }

  /** Paginate the local index of a user's memories (reactive). */
  async listMemories(
    ctx: RunQueryCtx,
    args: { userId: string; paginationOpts: PaginationOptions },
  ): Promise<PaginationResult<MemoryDoc>> {
    return ctx.runQuery(this.component.lib.listMemories, args);
  }

  // -------------------------------------------------------------------------
  // @convex-dev/agent integration
  // -------------------------------------------------------------------------

  /**
   * Returns a tool the agent can call to search the user's long-term memory.
   *
   * ```ts
   * await agent.generateText(ctx, { threadId, userId }, {
   *   prompt,
   *   tools: { searchMemory: everos.asTool({ userId }) },
   * });
   * ```
   */
  asTool(config: { userId?: string; topK?: number } = {}) {
    const component = this.component;
    // Resolve credentials inside execute, not here: tools are built at module
    // scope (in an Agent's `tools`), and throwing there breaks deploy analysis
    // rather than the one call that actually needs a key.
    const creds = () => this.creds();
    return createTool({
      description:
        "Search the user's long-term memory for relevant facts, preferences, " +
        "and past context. Call this whenever the user refers to something " +
        "that may have been said before or in another conversation.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("What to recall from the user's long-term memory."),
      }),
      execute: async (ctx: ToolCtx, args): Promise<string> => {
        // Fall back to the thread's user so the tool can be built once, at
        // module scope, instead of per request.
        const userId = config.userId ?? ctx.userId;
        if (!userId) {
          throw new Error(
            "searchMemory has no user: pass `asTool({ userId })`, or call the " +
              "agent with a `userId` so the tool can use the thread's user.",
          );
        }
        const memories: RecalledMemory[] = await ctx.runAction(
          component.lib.recall,
          {
            userId,
            query: args.query,
            topK: config.topK ?? 5,
            ...creds(),
          },
        );
        if (memories.length === 0)
          return "No relevant long-term memories found.";
        return memories.map((m) => `- ${m.text}`).join("\n");
      },
    });
  }

  /**
   * Recall memories for a prompt and format them as context messages to
   * prepend before `generateText` / `streamText`.
   *
   * ```ts
   * const messages = await everos.contextMessages(ctx, { userId, prompt });
   * await agent.generateText(ctx, { threadId, userId }, { messages, prompt });
   * ```
   */
  async contextMessages(
    ctx: RunActionCtx,
    args: { userId: string; prompt: string; topK?: number },
  ): Promise<ContextMessage[]> {
    const memories = await this.recall(ctx, {
      userId: args.userId,
      query: args.prompt,
      topK: args.topK ?? 5,
    });
    if (memories.length === 0) return [];
    return [
      {
        role: "system",
        content:
          "Relevant long-term memories about the user (from EverOS):\n" +
          memories.map((m) => `- ${m.text}`).join("\n"),
      },
    ];
  }
}

export default EverOS;
