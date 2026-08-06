// Thin wrapper around the EverOS Cloud v2 REST API (https://docs.evermind.ai).
//
// All network I/O lives here and is only ever called from Convex *actions*
// (queries/mutations cannot use `fetch`). The API key and base URL are passed
// in explicitly — the component never reads `process.env` itself.

export const DEFAULT_BASE_URL = "https://api.evermind.ai";

/** EverOS wire memory_type -> app-facing memory kind. */
export function memoryTypeToKind(
  memoryType: string,
): "episodic" | "profile" {
  switch (memoryType) {
    case "profile":
      return "profile";
    default:
      // v2 episodes carry a descriptive `type` (e.g. "Conversation").
      return "episodic";
  }
}

export type EverosConfig = {
  apiKey: string;
  baseUrl?: string;
  /**
   * Namespace within the EverOS account. One account can hold several
   * independent memory spaces, and every operation is scoped to one: content
   * written under one `appId` is not searchable or deletable from another.
   * Use it to keep staging, demos and production apart without needing a
   * separate account for each. Both default to EverOS's own `"default"`.
   */
  appId?: string;
  projectId?: string;
};

/** The scope fields every v2 endpoint accepts, omitted when unset. */
function scope(config: EverosConfig): Record<string, string> {
  return {
    ...(config.appId ? { app_id: config.appId } : {}),
    ...(config.projectId ? { project_id: config.projectId } : {}),
  };
}

async function everosRequest<T>(
  config: EverosConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      // The most common first-run mistake. Without calling it out, a bad key
      // looks exactly like "extraction is just slow": remember() succeeds,
      // recall() returns only not-yet-extracted rows, and the 401 is buried
      // in the logs of a scheduled action nobody is watching.
      throw new Error(
        `EverOS rejected the API key (${res.status} on ${path}). Check ` +
          "EVEROS_API_KEY in this deployment's environment variables, and " +
          "that the key belongs to the same environment as EVEROS_BASE_URL.",
      );
    }
    throw new Error(
      `EverOS API ${path} failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Wire types (subset of the v2 API relevant to this component)
// ---------------------------------------------------------------------------

// v2 identity model: there is no top-level user id on ingest — every message
// carries a `sender_id`, and retrieval scopes by top-level `user_id`.
export type EverosMessage = {
  role: "user" | "assistant" | "tool";
  timestamp: number; // unix ms
  content: string;
  sender_id: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

type AddResponse = {
  request_id?: string;
  data: {
    // "queued" on the live cloud; the ingest lands asynchronously (~10s),
    // so an immediate flush is a no-op — see lib.ts scheduling.
    status: string;
    message_count: number;
  };
};

// A single verifiable fact extracted from an episode — the basis for
// auditability / traceability (each recalled memory decomposes into these,
// with a relevance score).
export type EverosAtomicFact = {
  id?: string;
  content?: string;
  score?: number | null;
  timestamp?: number | string;
  session_id?: string | null;
};

export type EverosEpisode = {
  id: string;
  user_id?: string;
  session_id?: string;
  app_id?: string;
  project_id?: string;
  // ISO-8601 string on the wire. Normalize with `normalizeTimestamp`.
  timestamp?: number | string;
  summary?: string;
  subject?: string;
  episode?: string;
  type?: string;
  score?: number | null;
  atomic_facts?: EverosAtomicFact[];
  tags?: string[];
};

/** Normalize a wire timestamp (unix ms or ISO string) to epoch ms. */
export function normalizeTimestamp(
  ts: number | string | undefined | null,
): number | undefined {
  if (ts === undefined || ts === null) return undefined;
  if (typeof ts === "number") return ts;
  const parsed = Date.parse(ts.endsWith("Z") ? ts : `${ts}Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export type EverosProfile = {
  id: string;
  user_id?: string;
  profile_data?: {
    summary?: string;
    explicit_info?: unknown[];
    implicit_traits?: unknown[];
  };
  scenario?: string;
  memcell_count?: number;
};

/** A stored-but-not-yet-extracted message (read-your-writes on the server). */
export type EverosUnprocessedMessage = {
  content?: string;
  sender_id?: string;
  role?: string;
  timestamp?: number | string;
  session_id?: string;
};

type SearchResponse = {
  data: {
    episodes?: EverosEpisode[];
    profiles?: EverosProfile[];
    agent_cases?: unknown[];
    agent_skills?: unknown[];
    unprocessed_messages?: EverosUnprocessedMessage[];
  };
};

type GetResponse = {
  data: {
    episodes?: EverosEpisode[];
    profiles?: EverosProfile[];
    total_count?: number;
    count?: number;
  };
};

type DeleteResponse = {
  data: {
    filters?: string[];
    count?: number;
  };
};

// ---------------------------------------------------------------------------
// API operations
// ---------------------------------------------------------------------------

/**
 * Ingest messages into a session's accumulation buffer. Processing is
 * asynchronous: the cloud replies "queued" and the messages land in the
 * buffer shortly after (there is no task id to poll — see lib.ts for the
 * delayed-flush strategy).
 *
 * `mode` picks the extraction track and is bound to the session on its first
 * add (a later add with a different mode is rejected): "chat" (default) runs
 * the user-memory track; "agent" runs the agent boundary detector over the
 * full tool trajectory into the agent-memory track (cases / skills), with the
 * agent identified by the sender_id of the tool-calling assistant messages.
 */
export async function addMemories(
  config: EverosConfig,
  args: {
    sessionId: string;
    messages: EverosMessage[];
    mode?: "chat" | "agent";
  },
): Promise<{ status: string }> {
  const data = await everosRequest<AddResponse>(config, "/api/v2/memory/add", {
    ...scope(config),
    session_id: args.sessionId,
    messages: args.messages,
    ...(args.mode ? { mode: args.mode } : {}),
  });
  return { status: data.data.status };
}

/**
 * Force extraction of a session's accumulated messages. Returns
 * "no_extraction" both when there is nothing to extract AND when the ingest
 * hasn't landed in the buffer yet (~10s after add) — callers must retry.
 * The cloud does not extract on its own schedule; without a flush, ingested
 * messages sit in the buffer indefinitely.
 */
export async function flushExtraction(
  config: EverosConfig,
  args: { sessionId: string },
): Promise<{ status: string }> {
  const data = await everosRequest<{ data: { status: string } }>(
    config,
    "/api/v2/memory/flush",
    { ...scope(config), session_id: args.sessionId },
  );
  return { status: data.data.status };
}

/** Retrieve memories relevant to a query, scoped to one user. */
export async function searchMemories(
  config: EverosConfig,
  args: {
    userId: string;
    query: string;
    topK?: number;
    kind?: "episodic" | "profile";
  },
): Promise<{
  episodes: EverosEpisode[];
  profiles: EverosProfile[];
  unprocessedMessages: EverosUnprocessedMessage[];
}> {
  const data = await everosRequest<SearchResponse>(
    config,
    "/api/v2/memory/search",
    {
      ...scope(config),
      query: args.query,
      user_id: args.userId,
      method: "hybrid",
      top_k: args.topK ?? 10,
      // v2 has no memory_types filter; profiles ride along via this flag and
      // kind filtering happens client-side.
      include_profile: args.kind !== "episodic",
    },
  );
  const wantProfiles = args.kind !== "episodic";
  const wantEpisodes = args.kind === undefined || args.kind === "episodic";
  return {
    episodes: wantEpisodes ? (data.data.episodes ?? []) : [],
    profiles: wantProfiles ? (data.data.profiles ?? []) : [],
    unprocessedMessages: data.data.unprocessed_messages ?? [],
  };
}

/** Fetch a user's profile / semantic memory. */
export async function getProfileMemory(
  config: EverosConfig,
  args: { userId: string; pageSize?: number },
): Promise<EverosProfile[]> {
  const data = await everosRequest<GetResponse>(
    config,
    "/api/v2/memory/get",
    {
      ...scope(config),
      memory_type: "profile",
      user_id: args.userId,
      page: 1,
      page_size: args.pageSize ?? 20,
    },
  );
  return data.data.profiles ?? [];
}

/**
 * Delete all memories belonging to one session. v2 deletes by scope only
 * (user_id / agent_id / session_id) — there is no single-memory delete.
 */
export async function deleteSessionMemories(
  config: EverosConfig,
  args: { sessionId: string },
): Promise<{ deletedCount: number }> {
  const data = await everosRequest<DeleteResponse>(
    config,
    "/api/v2/memory/delete",
    { ...scope(config), session_id: args.sessionId },
  );
  return { deletedCount: data.data.count ?? 0 };
}

/** Delete ALL of a user's memories in EverOS. */
export async function deleteUserMemories(
  config: EverosConfig,
  args: { userId: string },
): Promise<{ deletedCount: number }> {
  const data = await everosRequest<DeleteResponse>(
    config,
    "/api/v2/memory/delete",
    { ...scope(config), user_id: args.userId },
  );
  return { deletedCount: data.data.count ?? 0 };
}
