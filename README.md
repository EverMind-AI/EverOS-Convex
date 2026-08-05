# @everos/convex

Long-term memory for [Convex](https://convex.dev) apps, backed by
[EverOS Cloud](https://evermind.ai) — the open-source agent memory OS
(state of the art on LoCoMo).

Drop-in `remember` / `recall` / user memory profiles for any Convex app, plus
**one-line long-term memory for [`@convex-dev/agent`](https://docs.convex.dev/agents)**:
persistent, cross-thread, cross-session memory that goes beyond vector search
over chat logs.

```ts
const everos = new EverOS(components.everos);

await everos.remember(ctx, { userId, content: "I'm vegetarian" });
const memories = await everos.recall(ctx, { userId, query: "what do I eat?" });
```

---

## Install

```bash
npm install @everos/convex @convex-dev/agent zod
```

> `@convex-dev/agent` and `zod` are peer dependencies used by the agent-tool
> helpers (`asTool`, `contextMessages`). Install them even if you only use
> `remember`/`recall` today.

### 1. Register the component

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import everos from "@everos/convex/convex.config";

const app = defineApp();
app.use(everos);
export default app;
```

### 2. Set your EverOS API key

Get a free key at **[evermind.ai](https://evermind.ai)** (free tier), then:

```bash
npx convex env set EVEROS_API_KEY 00000000-0000-0000-0000-000000000000
# optional — defaults to https://api.evermind.ai
npx convex env set EVEROS_BASE_URL https://api.evermind.ai
```

The app-side client reads these from `process.env` (you can also pass
`{ apiKey, baseUrl }` to `new EverOS(...)`). Per Convex component authoring
best practice, secrets are resolved in your app and threaded into the component
— they are never read inside the component itself.

---

## Usage

> **Memory extraction is asynchronous.** EverOS runs layered extraction on
> ingested content in the background — after `remember`, extracted memories
> typically become searchable within **~15–30 seconds** (the component drives
> extraction automatically). Until then, `recall` still returns the freshly
> saved content from the component's local queue, marked `pending: true`, so
> nothing is ever invisible. Long-term memory complements (doesn't replace)
> your thread's conversation context: use the thread for "what was just
> said", EverOS for "what's worth remembering across sessions".

```ts
// convex/memory.ts
import { action, mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { EverOS } from "@everos/convex";

const everos = new EverOS(components.everos);

export const remember = mutation({
  args: { content: v.string() },
  handler: async (ctx, { content }) => {
    const userId = (await ctx.auth.getUserIdentity())!.subject; // auth in the app
    await everos.remember(ctx, { userId, content });
  },
});

export const recall = action({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const userId = (await ctx.auth.getUserIdentity())!.subject;
    return await everos.recall(ctx, { userId, query, topK: 5 });
  },
});
```

### API

| Method | Kind | Description |
| --- | --- | --- |
| `everos.remember(ctx, { userId, content, metadata?, role?, sessionId? })` | mutation | Enqueue content; flushed to EverOS asynchronously |
| `everos.recall(ctx, { userId, query, topK?, kind?, includeRecent? })` | action | Retrieve relevant memories, ranked (plus not-yet-extracted content marked `pending`) |
| `everos.getProfile(ctx, { userId })` | action | Fetch the user's profile / semantic memory |
| `everos.forgetSession(ctx, { userId, sessionId })` | action | Delete one session's memories remotely + locally |
| `everos.forgetUser(ctx, { userId })` | action | Delete ALL of a user's memories remotely + locally |
| `everos.listMemories(ctx, { userId, paginationOpts })` | query | Reactive local index of a user's memories |

> **How ingestion works:** `remember` is a mutation (mutations can't make
> external calls), so it writes to a durable `pending` queue and schedules a
> `flush` action that POSTs to EverOS. EverOS extracts memories
> asynchronously, so the local `memories` index is hydrated from retrieval
> results rather than at ingest time.
>
> The component also drives extraction itself (`eagerExtraction: true`, the
> default): EverOS Cloud does not extract on a schedule of its own, so without
> this step ingested content would stay in its buffer and never become
> searchable. Only pass `new EverOS(components.everos, { eagerExtraction:
> false })` if your app calls the EverOS flush endpoint on its own.

---

## Agent integration (`@convex-dev/agent`)

Add persistent memory to any Convex agent in one line — either as a **tool** the
model calls, or as **context** you prepend.

```ts
import { Agent } from "@convex-dev/agent";
import { openai } from "@ai-sdk/openai";
import { EverOS } from "@everos/convex";
import { components } from "./_generated/api";

const everos = new EverOS(components.everos);
const agent = new Agent(components.agent, {
  languageModel: openai.chat("gpt-4o-mini"),
  instructions: "You have long-term memory of the user. Use searchMemory.",
});

export const chat = action({
  args: { threadId: v.string(), prompt: v.string() },
  handler: async (ctx, { threadId, prompt }) => {
    const userId = (await ctx.auth.getUserIdentity())!.subject;

    // Option A — give the agent a memory-search tool:
    const result = await agent.generateText(
      ctx,
      { threadId, userId },
      { prompt, tools: { searchMemory: everos.asTool({ userId }) } },
    );

    // Option B — prepend recalled memories as context:
    const messages = await everos.contextMessages(ctx, { userId, prompt });
    // await agent.generateText(ctx, { threadId, userId }, { messages, prompt });

    // Remember the turn for future threads/sessions:
    await everos.remember(ctx, { userId, content: prompt });
    return result.text;
  },
});
```

- `everos.asTool({ userId, topK? })` → a `@convex-dev/agent` tool that searches
  long-term memory.
- `everos.contextMessages(ctx, { userId, prompt, topK? })` → an array of
  `{ role, content }` messages to pass as `messages` before your `prompt`.

---

## Demo app

[`example/`](./example) is **Mindy**, an AI support desk built on
`@convex-dev/agent` + this component. A returning customer chats with the
frontline agent (GPT-4o-mini); clicking **Escalate to specialist** hands the
conversation to a different agent on a different model (Llama-3.3-70B) in a
**brand-new thread with zero shared chat history** — the specialist greets the
customer already knowing their plan, stack, and issue, purely from EverOS
memory. A live agent console shows the customer's memory profile, per-message
recalled context with traceable atomic facts (scored + timestamped), and the
memory pipeline activity feed. It demonstrates the differentiator vs a model's
built-in memory: **memory belongs to the user — portable across agents,
models, and sessions — and auditable**.

```bash
cd example
npm install
npx convex env set EVEROS_API_KEY 00000000-0000-0000-0000-000000000000
# LLM: either OpenRouter (any model) or plain OpenAI
npx convex env set OPENROUTER_API_KEY sk-or-...   # uses openai/gpt-4o-mini
# or: npx convex env set OPENAI_API_KEY sk-...
npm run dev
```

To reset between recordings: `npx convex run demo:clearAll` wipes all demo
conversations, the agent console state, and the customers' EverOS memories.

---

## Testing

Component functions are tested with [`convex-test`](https://docs.convex.dev/testing/convex-test)
and a mocked EverOS API:

```bash
npm test
```

To test the component inside your own app, register it with a `convexTest`
instance:

```ts
import { convexTest } from "convex-test";
import schema from "./schema.js";
import everos from "@everos/convex/test";

const t = convexTest(schema, import.meta.glob("./**/*.ts"));
everos.register(t);
```

---

## Design notes

**Why the API key is passed as an argument, not read from `process.env` inside
the component.** Convex's docs sketch a typed `env` block on `defineComponent`,
but reading `process.env` *inside* a component is not reliable. Following
Convex's own reference component ([`@convex-dev/twilio`](https://github.com/get-convex/twilio)),
this component keeps `convex.config.ts` as a plain `defineComponent("everos")`
and the app-side `EverOS` client resolves `EVEROS_API_KEY` / `EVEROS_BASE_URL`
(from its options or `process.env`) and threads them into every action call.
The component stays pure and portable; secrets live in the app.

**Ingestion is a durable, asynchronous pipeline.** `remember` is a mutation
(mutations can't call external APIs), so it writes to a `pending` queue and
schedules a `flush` action. `flush` batches queued items per `(userId,
sessionId)` into one EverOS ingest call, then schedules `runExtraction`, which
calls EverOS's `/flush` with backoff-retry until extraction actually lands (an
ingest takes ~10s to reach the accumulation buffer, and a flush before that is
a silent no-op — EverOS Cloud does not extract on its own schedule).
Extraction buffers are **session-scoped**, so each `(user, session)` pair is
flushed individually; once a flush reports `extracted`, the pair's queue rows
are retired from the read-your-writes merge. Because EverOS extracts memories
asynchronously (ingest returns a queue status, not a memory id), the local `memories`
index is hydrated from retrieval results, not at ingest time.

## Local development

The [`example/`](./example) app links this package with `file:..`. That means
two copies of `convex` resolve during local dev, which makes the example's
`convex.config.ts` fail a strict type-check with a spurious `env` type
mismatch. It's a link-only artifact — apps that install `@everos/convex` from
npm have a single `convex` and are unaffected — so the example's dev script
runs `convex dev --typecheck=disable`. The component package itself
type-checks and tests cleanly (`npm run build`, `npm test`).

---

## License

Apache-2.0 © [EverMind](https://evermind.ai)
