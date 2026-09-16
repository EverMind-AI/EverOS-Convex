# @everos-ai/convex

[![npm](https://img.shields.io/npm/v/@everos-ai/convex.svg)](https://www.npmjs.com/package/@everos-ai/convex)
[![CI](https://github.com/EverMind-AI/EverOS-Convex/actions/workflows/ci.yml/badge.svg)](https://github.com/EverMind-AI/EverOS-Convex/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Long-term memory for [Convex](https://convex.dev) apps, backed by
[EverOS Cloud](https://evermind.ai/everos), the hosted service of
[EverOS](https://github.com/EverMind-AI/EverOS) — the open-source agent memory
OS (state of the art on LoCoMo).

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
npm install @everos-ai/convex @convex-dev/agent zod
```

> `@convex-dev/agent` and `zod` are peer dependencies. The main entry imports
> them for `asTool`, and Convex resolves imports when it pushes your code, so
> they are required even if you only call `remember` / `recall`. Splitting the
> agent helpers into their own entry point is tracked for a later release.
> Both `@convex-dev/agent` 0.6 (AI SDK v6) and 0.7 (AI SDK v7) are supported;
> npm installs the matching `ai` packages as its peers.

### 1. Register the component

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import everos from "@everos-ai/convex/convex.config";

const app = defineApp();
app.use(everos);
export default app;
```

### 2. Set your EverOS API key

Get a free key at **[everos.evermind.ai](https://everos.evermind.ai/)** (free
tier; API reference at
[docs.evermind.ai](https://docs.evermind.ai/api-reference/introduction)), then:

```bash
npx convex env set EVEROS_API_KEY <your-key>
# optional — defaults to https://api.evermind.ai
npx convex env set EVEROS_BASE_URL https://api.evermind.ai
```

To keep separate memory spaces on one account (staging, a public demo,
production), give each a namespace:

```ts
new EverOS(components.everos, { appId: "staging", projectId: "staging" });
```

Reads, writes and deletes are all scoped to it, so nothing under one namespace
is searchable or deletable from another. Issuing a second API key does **not**
do this: keys on the same account share a namespace. `EVEROS_APP_ID` /
`EVEROS_PROJECT_ID` work too.

The app-side client reads credentials from `process.env` (you can also pass
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
import { EverOS } from "@everos-ai/convex";

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
| `everos.remember(ctx, { userId, content, role?, senderName?, sessionId?, timestamp? })` | mutation | Enqueue content; flushed to EverOS asynchronously |
| | | Pass `senderName` whenever `userId` is opaque (a UUID, an auth subject). It is the attribution key, and without a display name extraction writes it into the fact text itself — `"1036ffce-… said their webhooks fail"`. |
| `everos.rememberMessages(ctx, { userId, messages, sessionId? })` | mutation | Remember a whole turn (prompt **and** reply) in one call; each message takes its own `senderName` |
| `everos.recall(ctx, { userId, query, topK?, kind?, includeRecent? })` | action | Retrieve relevant memories, ranked (plus not-yet-extracted content marked `pending`) |
| | | `topK` bounds the ranked episodes only. Profiles ride along, and up to 5 `pending` items may be appended, so size prompts from the returned array rather than from `topK`. |
| `everos.getProfile(ctx, { userId })` | action | Fetch the user's profile / semantic memory |
| `everos.forgetSession(ctx, { userId, sessionId })` | action | Delete one session's memories remotely + locally |
| `everos.forgetUser(ctx, { userId })` | action | Delete ALL of a user's memories remotely + locally |
| `everos.getPendingStatus(ctx, { userId })` | query | Whether anything is still on its way to EverOS, and why if it is stuck |
| `everos.listMemories(ctx, { userId, page?, pageSize? })` | action | Page through everything EverOS holds for a user, newest first |

> **How ingestion works:** `remember` is a mutation (mutations can't make
> external calls), so it writes to a durable `pending` queue and schedules a
> `flush` action that POSTs to EverOS. A queue row is deleted once EverOS
> confirms it was extracted — the component keeps no local copy of your
> memories, and `recall` / `listMemories` always read EverOS itself.
>
> Extraction is asynchronous on the EverOS side: a self-contained segment is
> extracted within seconds of ingest, an open-ended one waits for more
> messages. The component nudges the latter with a flush, then reads the
> session's episodes back until it can confirm the content is extracted.
>
> **If something looks missing**, `getPendingStatus` says whether it is still
> in flight or actually failed. A rejected API key shows up there as
> `lastError`; without checking it, a bad key is indistinguishable from
> extraction being slow.

---

## Security model

**`userId` is trusted input — derive it server-side.** The component performs
no authentication of its own (it can't; only your app knows who is signed in).
Every method reads and writes exactly the memory space of the `userId` you
pass, so a `userId` taken from a client-supplied argument lets any caller
read — or, via `forgetUser`, delete — anyone's memories. Always derive it
from your app's auth, as every example in this README does:

```ts
const userId = (await ctx.auth.getUserIdentity())!.subject; // never an arg
```

**Memories are user-generated content, not verified facts.** Whatever a user
says is extracted and later replayed into prompts as context. That is the
point of a memory system, but if your agent makes decisions on it (refunds,
account changes, access), remember that users can seed their own memory with
convenient "facts" ("support agreed to a full refund last month"). For
anything with consequences, audit the claim: each recalled memory decomposes
into `atomicFacts` with timestamps and session provenance.

**Where the API key travels.** The key lives in your deployment's environment
variables and is threaded into component calls as an argument, so it also
appears in scheduled-function arguments (the `_scheduled_functions` system
table) — visible to people with dashboard access to your deployment, who can
already read your environment variables. It is never exposed to clients, and
component functions are not callable from clients. Requests refuse non-HTTPS
base URLs (loopback excepted, for self-hosted local dev), and `baseUrl`
should only ever come from an environment variable or a constant — never from
user input.

---

## Agent integration (`@convex-dev/agent`)

Add persistent memory to any Convex agent in one line — either as a **tool** the
model calls, or as **context** you prepend.

```ts
import { Agent } from "@convex-dev/agent";
import { openai } from "@ai-sdk/openai";
import { EverOS } from "@everos-ai/convex";
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
npx convex env set EVEROS_API_KEY <your-key>
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
import everos from "@everos-ai/convex/test";

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
sessionId)` into one EverOS ingest call, then schedules `runExtraction` 15s
out. EverOS extracts a self-contained segment on its own a few seconds after
ingest, so `runExtraction` first calls EverOS's `/flush` (which closes an
open-ended tail, and otherwise answers `no_extraction` because there is
nothing left pending), then reads the session's episodes back with `/get` to
confirm one exists for this batch, retrying with backoff for about ten
minutes to cover the long tail.
Extraction buffers are **session-scoped**, so each `(user, session)` pair is
confirmed individually; once its episode is readable, the pair's queue rows
are deleted. Nothing else is stored locally: the queue exists to survive a
failed ingest and to answer "what did I just say" while extraction catches up,
not as a mirror of your memories. Rows that never made it are kept as `failed`,
because that is the one thing worth reporting through `getPendingStatus`.

## Local development

The [`example/`](./example) app links this package with `file:..`, so two
copies of `convex` resolve during local dev and the two `ComponentDefinition`
types end up structurally identical but nominally distinct. The example's
`convex.config.ts` casts around it with a comment. It is a link-only artifact:
apps that install `@everos-ai/convex` from npm resolve a single `convex` and need
no cast. Everything else type-checks strictly, in the example and in the
component package (`npm run build`, `npm test`).

---

## License

Apache-2.0 © [EverMind](https://evermind.ai)
