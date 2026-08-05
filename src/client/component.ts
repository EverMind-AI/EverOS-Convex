import type {
  FunctionReference,
  PaginationOptions,
  PaginationResult,
} from "convex/server";

/** App-facing memory kind. */
export type MemoryKind = "episodic" | "semantic" | "profile";

/**
 * A single verifiable fact underlying a memory — the drill-down layer beneath
 * an episode. Present when the fact is what drove the episode's recall.
 */
export type AtomicFact = {
  text: string;
  score?: number;
  timestamp?: number;
  sessionId?: string;
};

export type RecalledMemory = {
  everosMemoryId: string;
  userId: string;
  kind: MemoryKind;
  text: string;
  summary?: string;
  score?: number;
  timestamp?: number;
  sessionId?: string;
  /**
   * True for content that was remembered but not yet extracted by EverOS
   * (extraction is asynchronous) — returned so freshly saved content is
   * never invisible.
   */
  pending?: boolean;
  atomicFacts?: AtomicFact[];
};

export type MemoryProfile = {
  everosMemoryId: string;
  scenario?: string;
  summary?: string;
  explicitInfo: unknown[];
  implicitTraits: unknown[];
};

export type MemoryDoc = {
  _id: string;
  _creationTime: number;
  userId: string;
  everosMemoryId: string;
  kind: MemoryKind;
  preview: string;
  sessionId?: string;
  syncedAt: number;
};

/**
 * The EverOS component's exposed API surface, as referenced from an app via
 * `components.everos`. Hand-written (rather than relying on generated
 * `component.ts`) so the client type is stable across codegen setups — the
 * same structural pattern `@convex-dev/agent` uses for its `ComponentApi`.
 */
export type ComponentApi<
  Name extends string | undefined = string | undefined,
> = {
  lib: {
    remember: FunctionReference<
      "mutation",
      "internal",
      {
        userId: string;
        content: string;
        role?: "user" | "assistant";
        sessionId?: string;
        metadata?: Record<string, unknown>;
        apiKey: string;
        baseUrl?: string;
        eager?: boolean;
      },
      { pendingId: string },
      Name
    >;
    recall: FunctionReference<
      "action",
      "internal",
      {
        userId: string;
        query: string;
        topK?: number;
        kind?: MemoryKind;
        includeRecent?: boolean;
        apiKey: string;
        baseUrl?: string;
      },
      RecalledMemory[],
      Name
    >;
    getProfile: FunctionReference<
      "action",
      "internal",
      { userId: string; apiKey: string; baseUrl?: string },
      MemoryProfile[],
      Name
    >;
    forgetSession: FunctionReference<
      "action",
      "internal",
      {
        userId: string;
        sessionId: string;
        apiKey: string;
        baseUrl?: string;
      },
      { deletedCount: number },
      Name
    >;
    forgetUser: FunctionReference<
      "action",
      "internal",
      { userId: string; apiKey: string; baseUrl?: string },
      { deletedCount: number },
      Name
    >;
    listMemories: FunctionReference<
      "query",
      "internal",
      { userId: string; paginationOpts: PaginationOptions },
      PaginationResult<MemoryDoc>,
      Name
    >;
  };
};
