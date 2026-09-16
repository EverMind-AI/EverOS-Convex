# Contributing to @everos-ai/convex

Thanks for helping. This file covers how to work on the package itself; the
[README](./README.md) covers using it in an app.

## Local development

```bash
npm install
npm run build        # tsc build of the client + component into dist/
npm test             # component tests (convex-test + a mocked EverOS API)
npm run typecheck
npm run lint
```

The [`example/`](./example) app links this package with `file:..`, so two
copies of `convex` resolve during local dev and the two `ComponentDefinition`
types end up structurally identical but nominally distinct. The example's
`convex.config.ts` casts around it with a comment. It is a link-only artifact:
apps that install `@everos-ai/convex` from npm resolve a single `convex` and need
no cast. Everything else type-checks strictly, in the example and in the
component package (`npm run build`, `npm test`).

## Pull requests

`main` is protected: every change goes through a pull request, and the CI
workflow (build + tests, gitleaks secret scan) must pass before merging.
Merged branches are deleted automatically.

Releases are documented in [PUBLISHING.md](./PUBLISHING.md). The design
decisions and the reasoning behind the client API are in
[everos-component-spec.md](./everos-component-spec.md).

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

## Verifying against a real deployment

The example app has smoke-test entrypoints that exercise the component against
EverOS Cloud from a deployed Convex app (they are `internal*` functions, so
they can only be run by an operator):

```bash
cd example
npx convex run memoryTest:remember '{"content":"I love espresso"}'
npx convex run memoryTest:status   '{}'      # pending -> 0 once extracted
npx convex run memoryTest:recall   '{"query":"coffee"}'
npx convex run memoryTest:forget   '{}'      # clean up the test user
```
