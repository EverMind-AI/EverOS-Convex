# EverOS Convex Component — Technical Spec

Build a Convex component that gives any Convex app (especially apps using `@convex-dev/agent`) long-term memory backed by EverOS Cloud. Form: **Cloud API wrapper** — component tables hold references/state, actions call the EverOS Cloud API. Simplest to ship, funnels users to EverOS Cloud.

## Package

- npm: `@everos/convex`
- component name: `everos`
- Scaffold: `npx create-convex@latest --component` (uses get-convex/template-component; keep its build/publish/test setup)

## Required reading before implementing

- https://docs.convex.dev/components/authoring (constraints: no `ctx.auth` inside component, `Id` types become strings at the boundary, all public functions need arg + return validators, use `paginator` from `convex-helpers` not `.paginate()`, external HTTP calls only in actions)
- https://github.com/get-convex/templates/tree/main/template-component (structure, entry points, PUBLISHING.md)
- https://github.com/get-convex/twilio (reference: component wrapping an external API)
- https://docs.convex.dev/agents/tools and https://docs.convex.dev/agents/context (for the agent integration)
- EverOS Cloud API docs: https://docs.evermind.ai

## Component config

```ts
// src/component/convex.config.ts
import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("everos", {
  env: {
    EVEROS_API_KEY: v.string(),
    EVEROS_BASE_URL: v.optional(v.string()), // default https://api.evermind.ai
  },
});
```

## Component schema (own tables)

- `memories`: { userId: string, everosMemoryId: string, kind: "episodic" | "semantic" | "profile", preview: string, sessionId?: string, syncedAt: number } — local index of what's stored in EverOS, so queries/joins stay reactive inside Convex
- `pending`: { userId: string, content: string, status: "queued" | "sent" | "extracted" | "failed", attempts: number } — write-ahead queue AND read-your-writes source; a mutation enqueues, a scheduled action flushes to EverOS Cloud (mutations can't call external APIs). Rows in queued/sent are merged into `recall` results (marked `pending: true`, 15-min TTL) until a flush confirms extraction, so freshly saved content is never invisible
- `usage`: { userId: string, op: "remember" | "recall", ts: number } — optional, for usage tracking/billing examples

## Component functions (public, all with validators)

- `remember` (mutation): enqueue content + userId + optional metadata; schedule flush action
- `flush` (internal action): POST queued items to the EverOS v2 ingest API (batched per user+session; a session id is always sent — sessionless remembers share a per-user default session `user:{userId}`), then schedule `runExtraction`, which calls EverOS `/flush` with backoff-retry until extraction lands and retires the pending rows (v2 ingest is async with a ~10s landing window, and EverOS Cloud does not extract without a flush)
- `recall` (action): query the EverOS v2 search API { userId, query, topK, kind?, includeRecent? } → returns extracted memories with scores plus not-yet-extracted content marked `pending: true`
- `getProfile` (action): fetch user's semantic/profile memory from EverOS
- `forgetSession` (action): delete one session's memories in EverOS + matching local rows (the v2 API deletes by scope — user / agent / session — there is no single-memory delete)
- `forgetUser` (action): delete ALL of a user's memories in EverOS + all local rows
- `listMemories` (query): paginated local index per userId (use convex-helpers paginator)

## Design decisions: where this component deviates from the EverOS API (and why)

The component is not a 1:1 transport wrapper. It defines its own app-facing
vocabulary and owns several behaviours the raw API leaves to the caller.
Anyone changing either side should read this section first.

### 1. Verb-based client API, wire names kept internal

| Client method | Wire call | Why not just mirror the wire name |
| --- | --- | --- |
| `remember` | `POST /api/v2/memory/add` | **Not 1:1.** `remember` is a Convex mutation that appends to a durable queue; a scheduled action later batches N remembers into ONE `add` + a `flush`. Naming it `add` would imply one call = one server write. |
| `recall` | `POST /api/v2/memory/search` | Returns extracted memories **plus** locally queued content (see §3); it is a superset of `search`. |
| `getProfile` | `POST /api/v2/memory/get` (`memory_type: "profile"`) | Single purpose, so the memory_type is bound rather than exposed. |
| `forgetSession` / `forgetUser` | `POST /api/v2/memory/delete` | The wire endpoint is scope-based; two named methods are clearer than one method with a mutually-exclusive arg union. |
| `listMemories` | *(none — local table)* | Reactive Convex query over the local index; never hits EverOS. |

`src/component/everos.ts` is the only layer that knows wire vocabulary, and its
function names deliberately track it (`addMemories`, `searchMemories`,
`deleteUserMemories`). Client-facing fields are camelCase (`userId`,
`atomicFacts`, `everosMemoryId`); wire fields stay snake_case.

`kind: "episodic" | "semantic" | "profile"` is likewise an app-facing
simplification of the wire `memory_type` enum (`episode` / `profile` /
`agent_case` / `agent_skill`); agent memory is not surfaced in v0.1.

### 2. Concepts this component invents (no server equivalent)

- **Default session** — v2 requires a `session_id` on every `add`, but
  `remember` does not. Sessionless remembers are grouped into a per-user
  session `user:{userId}` (truncated to the 128-char server limit). This
  makes session id optional for the caller at the cost of coarser episode
  granularity, which is documented in the README.
- **`pending: true`** — a marker on recall results meaning "remembered, not
  yet extracted". No server concept; see §3.
- **15-minute pending TTL** — a queued/sent row older than this stops being
  merged into recall results. Guards against a broken pipeline duplicating
  content that was almost certainly extracted anyway.

### 3. Behaviours the component owns

**The ingest state machine.** This is the part worth reviewing closely: it
exists because Convex mutations cannot call external APIs, and Convex actions
are neither transactional nor guaranteed to finish.

```
remember (mutation)          insert row `queued`, schedule flush
   |
flush (action)
   |-- claimQueued (mutation) `queued` -> `sending` + claimedAt, atomically,
   |                          and schedules its own recovery sweep
   |-- POST /memory/add
   |-- markSent (mutation)    -> `sent`, schedule runExtraction
   |   or markFailed          -> back to `queued` (or `failed`), schedule retry
   |
runExtraction (action)        POST /memory/flush, retry 20/40/80s
   |-- markExtracted          delete the row: EverOS now holds the memory
   |   or markExtractionStalled  record why it is ingested but not searchable
```

Four properties this buys, each of which had a failing test before it existed:

- **No duplicate ingest.** `remember` schedules a flush per call and actions
  run concurrently, so rows must be claimed in a mutation (serializable)
  rather than merely read. Reading them and marking them after the HTTP round
  trip lets two flushes send the same content.
- **No stranded rows.** An action can die between claiming and reporting. The
  `claimedAt` lease lets a later flush reclaim the row, but *something has to
  run that flush*: only `remember` and a failed flush schedule one, so a quiet
  app would lose the content silently. `claimQueued` therefore schedules the
  recovery sweep itself, committing it in the same transaction as the claim.
  The sweep terminates on its own, because a sweep that claims nothing
  schedules nothing. A reclaim counts as an attempt, so a row whose action
  dies every time is eventually given up on.
- **Retries actually happen.** A requeued row schedules its own retry
  (5s/30s/2m/10m). Requeuing without scheduling leaves it waiting for a
  `remember` that may never come.
- **Extraction is driven, not awaited.** EverOS Cloud does not extract on its
  own schedule: without a `flush`, ingested messages sit in the accumulation
  buffer indefinitely. Ingest also takes ~10s to land, and a flush inside that
  window returns `no_extraction`, indistinguishable from "nothing to do". So
  extraction is scheduled 15s out and retried at 20/40/80s.

**Read-your-writes.** The server can return `unprocessed_messages`, but only
when the search carries `filters.session_id` as a top-level scalar, which a
cross-session recall by `userId` cannot supply. The component merges its own
queue instead, newest first and bounded by `topK`, so freshly saved content is
never invisible and unranked rows cannot crowd out ranked ones in a prompt.

**Observability.** `remember` returns before any network call happens, so
`getPendingStatus` reports what is still in flight, what failed, and why. A
rejected API key is otherwise indistinguishable from slow indexing.

**Retention.** Rows are deleted once EverOS confirms extraction; `failed` rows
are kept deliberately, as the only record that content never made it.

### 4. Assumptions that break if the server changes

Flag these to the component owner before shipping such a change:

- If Cloud starts **auto-extracting** on its own boundary detection, the
  component's flush scheduling becomes redundant (harmless but wasteful) and
  its "extracted" state write-back may lag reality.
- If `unprocessed_messages` starts returning for owner-scoped searches, the
  local pending merge could be replaced by it (simpler, and ranked).
- If a **single-memory delete** appears, `forget(everosMemoryId)` can return —
  it was removed only because v2 deletes by scope.
- If the ingest **landing window** grows past ~80s, the retry ladder needs
  extending.
- The `mode: "chat" | "agent"` field is wired through `addMemories` but unused
  in v0.1; agent memory ships once Cloud produces `agent_case` / `agent_skill`.

### 5. Known trade-offs a reviewer should weigh

- **The API key travels as a function argument**, including through scheduled
  functions, so it is written to `_scheduled_functions` and visible to anyone
  with Convex dashboard access. This follows Convex's component convention
  (env vars are resolved app-side and threaded in, as `@convex-dev/twilio`
  does) rather than reading `process.env` inside the component. The
  alternative — storing it in a component-owned table — puts it at rest in the
  database instead. Neither is obviously better; the current choice is the
  conventional one.
- **`usage` is written on every remember and recall and never read or
  pruned.** It exists for billing/analytics examples. It should either grow a
  read API or be removed.
- **Session ids longer than 128 chars are truncated to their tail**, so two
  ids sharing a suffix would collide into one session. Hashing would avoid it
  at the cost of unreadable ids in EverOS.
- **`getPendingStatus` returns a capped count**, not a census, because it is
  re-run reactively. `capped` says when the real figure is higher.
- **The agent helpers are in the main entry point**, so `@convex-dev/agent` and
  `zod` are required peers even for an app that only calls `remember` /
  `recall`: Convex resolves imports at push time, so a static import in the
  entry is a hard dependency. Moving `asTool` to a `@everos/convex/agent`
  subpath would make them genuinely optional, and is the right follow-up.
- **`sent` rows that no extraction ever confirms are kept, not deleted.** The
  tempting shortcut is to assume a sibling extraction covered them, but when
  that assumption is wrong the content silently disappears from recall while
  `getPendingStatus` reports all clear — the one failure this component exists
  to make visible. A successful extraction retires its siblings explicitly, by
  comparing each row's `sentAt` against when the extraction ran.

## Client (app-side, src/client/index.ts)

Class-based client per authoring docs:

```ts
const everos = new EverOS(components.everos, { /* optional overrides */ });
await everos.remember(ctx, { userId, content, metadata });
const memories = await everos.recall(ctx, { userId, query, topK: 5 });
```

Plus the key selling point — one-line integration with `@convex-dev/agent`:

```ts
// returns a tool the agent can call, and/or a helper to prepend
// recalled memories to context before generateText
everos.asTool({ userId })          // agent tool: search long-term memory
await everos.contextMessages(ctx, { userId, prompt }) // for manual context injection
```

App authenticates the user itself and passes `userId` in (no ctx.auth inside components).

## Demo app (example/ in the template)

Chat app using `@convex-dev/agent` + this component: two separate threads, agent remembers facts from thread A when chatting in thread B. This is the demo Convex requires for directory submission — make it visually obvious (show "recalled memories" in the UI).

## Testing

- `convex-test` for component functions (mock EverOS API with fetch mock)
- Export `/test` entrypoint with `register()` helper per template convention

## Publishing checklist

1. Entry points in package.json: `.`, `./convex.config.js`, `./_generated/component.js`, `./test`
2. README: install, env var setup, agent integration example, link to EverOS Cloud signup (free tier)
3. Publish to npm (follow template PUBLISHING.md)
4. Submit at https://www.convex.dev/components/submit with demo app link
