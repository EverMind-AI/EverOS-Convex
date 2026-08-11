import type { FunctionReference } from "convex/server";

/** App-facing memory kind. */
export type MemoryKind = "episodic" | "profile";

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

/**
 * How much of a user's remembered content has not reached EverOS yet, and why
 * if something is stuck. Ingest and extraction run after `remember` returns,
 * so this is the only way to tell a slow extraction from a broken one.
 */
export type PendingStatus = {
  /** Ingested or queued, not yet extracted. Counts down to 0 normally. */
  unextracted: number;
  /** Gave up after repeated ingest failures. Should stay 0. */
  failed: number;
  /** True when there were more rows than the query counted. */
  capped: boolean;
  /** Most recent failure message, e.g. a rejected API key. */
  lastError?: string;
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
        senderName?: string;
        sessionId?: string;
        timestamp?: number;
        apiKey: string;
        baseUrl?: string;
        appId?: string;
        projectId?: string;
        eager?: boolean;
      },
      { pendingId: string },
      Name
    >;
    rememberMessages: FunctionReference<
      "mutation",
      "internal",
      {
        userId: string;
        messages: Array<{
          content: string;
          role?: "user" | "assistant";
          senderName?: string;
          timestamp?: number;
        }>;
        sessionId?: string;
        apiKey: string;
        baseUrl?: string;
        appId?: string;
        projectId?: string;
        eager?: boolean;
      },
      { pendingIds: string[] },
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
        appId?: string;
        projectId?: string;
      },
      RecalledMemory[],
      Name
    >;
    getProfile: FunctionReference<
      "action",
      "internal",
      {
        userId: string;
        apiKey: string;
        baseUrl?: string;
        appId?: string;
        projectId?: string;
      },
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
        appId?: string;
        projectId?: string;
      },
      { deletedCount: number },
      Name
    >;
    forgetUser: FunctionReference<
      "action",
      "internal",
      {
        userId: string;
        apiKey: string;
        baseUrl?: string;
        appId?: string;
        projectId?: string;
      },
      { deletedCount: number },
      Name
    >;
    getPendingStatus: FunctionReference<
      "query",
      "internal",
      { userId: string; limit?: number },
      PendingStatus,
      Name
    >;
    listMemories: FunctionReference<
      "action",
      "internal",
      {
        userId: string;
        page?: number;
        pageSize?: number;
        apiKey: string;
        baseUrl?: string;
        appId?: string;
        projectId?: string;
      },
      { memories: RecalledMemory[]; totalCount: number },
      Name
    >;
  };
};
