/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const CREDS = { apiKey: "k", baseUrl: "https://api.evermind.test" };

function mockEveros(handlers: Partial<Record<string, (body: any) => unknown>>) {
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url.toString())
        .pathname;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const h = handlers[path];
      if (!h) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(h(body)), { status: 200 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// PROBE 1: claimQueued increments `attempts` for a stale reclaim in memory but
// never persists it -> a row whose action dies every time is reclaimed forever.
test("PROBE 1: stale reclaim does not persist the incremented attempt count", async () => {
  const t = convexTest(schema, modules);
  const id = await t.run(async (ctx) =>
    ctx.db.insert("pending", {
      userId: "u1",
      content: "c",
      role: "user",
      status: "sending",
      claimedAt: Date.now() - 10 * 60_000,
      attempts: 0,
    }),
  );

  // Reclaim it 20 times, each time re-abandoning it (action died again).
  for (let i = 0; i < 20; i++) {
    const claimed = await t.mutation(internal.lib.claimQueued, { ...CREDS });
    expect(claimed.length).toBe(1); // reclaimed every single time
    await t.run(async (ctx) =>
      ctx.db.patch(id, { claimedAt: Date.now() - 10 * 60_000 }),
    );
  }
  const row = await t.run(async (ctx) => ctx.db.get(id));
  console.log("PROBE 1 after 20 reclaims ->", {
    status: row?.status,
    attempts: row?.attempts,
  });
  expect(row?.attempts).toBe(0); // never incremented in the DB
  expect(row?.status).toBe("sending"); // never reaches "failed"
});

// PROBE 2: a full queued batch (>= limit) makes the stale-reclaim branch
// unreachable, so `sending` rows are starved for as long as backlog >= limit.
test("PROBE 2: a full queued batch starves stale `sending` rows", async () => {
  const t = convexTest(schema, modules);
  const stale = await t.run(async (ctx) => {
    const s = await ctx.db.insert("pending", {
      userId: "u1",
      content: "stranded",
      role: "user",
      status: "sending",
      claimedAt: 0,
      attempts: 0,
    });
    for (let i = 0; i < 25; i++) {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: `q${i}`,
        role: "user",
        status: "queued",
        attempts: 0,
      });
    }
    return s;
  });
  const claimed = await t.mutation(internal.lib.claimQueued, { ...CREDS });
  console.log("PROBE 2 claimed ids include stale?", claimed.some((c) => c._id === stale));
  expect(claimed.length).toBe(25);
  expect(claimed.some((c) => c._id === stale)).toBe(false);
  const row = await t.run(async (ctx) => ctx.db.get(stale));
  expect(row?.status).toBe("sending"); // untouched
});

// PROBE 3: markSent patches without an existence check. If any row in the
// group vanished mid-flight, the whole markSent transaction aborts, flush
// treats the successful ingest as a failure and requeues the ENTIRE group.
test("PROBE 3: one vanished row requeues an entire successfully-ingested group", async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const a: Id<"pending">[] = [];
    for (const c of ["one", "two", "three"]) {
      a.push(
        await ctx.db.insert("pending", {
          userId: "u1",
          content: c,
          role: "user",
          sessionId: "s1",
          status: "queued",
          attempts: 0,
        }),
      );
    }
    return a;
  });

  let addCalls = 0;
  mockEveros({
    "/api/v2/memory/add": () => {
      addCalls++;
      return { data: { status: "queued", message_count: 3 } };
    },
  });

  // The ingest succeeds; while it is in flight a concurrent extraction /
  // forgetUser deletes one of the claimed rows.
  await t.run(async (ctx) => ctx.db.delete(ids[0]));

  const result = await t.action(internal.lib.flush, { ...CREDS, eager: false });
  const rows = await t.run(async (ctx) =>
    Promise.all(ids.slice(1).map((i) => ctx.db.get(i))),
  );
  console.log("PROBE 3", {
    addCalls,
    result,
    survivors: rows.map((r) => ({ s: r?.status, a: r?.attempts, e: r?.lastError })),
  });
  expect(addCalls).toBe(1); // content DID reach EverOS
  expect(result.failed).toBe(3); // ...but flush reports total failure
  // and the two surviving, already-ingested rows are queued for a re-send:
  expect(rows.every((r) => r?.status === "queued")).toBe(true);
});

// PROBE 4: `sent` is a state a row can never leave when EverOS keeps
// answering "no_extraction" (the normal outcome for the 2nd+ concurrent
// extraction chain on one session, whose buffer the 1st chain already drained).
test("PROBE 4: `sent` rows are never retired when extraction reports no_extraction", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  mockEveros({
    "/api/v2/memory/add": () => ({
      data: { status: "queued", message_count: 1 },
    }),
    "/api/v2/memory/flush": () => ({ data: { status: "no_extraction" } }),
  });
  await t.mutation(internal.lib.claimQueued, { ...CREDS }); // no-op, warms nothing
  await t.run(async (ctx) =>
    ctx.db.insert("pending", {
      userId: "u1",
      content: "extracted by someone else's flush",
      role: "user",
      sessionId: "s1",
      status: "queued",
      attempts: 0,
    }),
  );
  await t.action(internal.lib.flush, { ...CREDS });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const rows = await t.run(async (ctx) => ctx.db.query("pending").collect());
  console.log(
    "PROBE 4 terminal rows ->",
    rows.map((r) => ({ s: r.status, a: r.attempts, e: r.lastError?.slice(0, 40) })),
  );
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("sent"); // stuck forever, nothing deletes it
});

// PROBE 5: transaction-limit exposure of clearUserLocal — it collects the
// whole `usage` table for a user, which grows one row per remember AND recall.
test("PROBE 5: clearUserLocal collects unbounded per-user history", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 5000; i++) {
      await ctx.db.insert("usage", { userId: "u1", op: "recall", ts: i });
    }
  });
  const t0 = Date.now();
  await t.mutation(internal.lib.clearUserLocal, { userId: "u1" });
  console.log(
    `PROBE 5: single transaction read+deleted 5000 usage rows in ${Date.now() - t0}ms ` +
      "(convex-test enforces no doc limits; production caps a transaction at " +
      "16384 docs read / 8MiB, so this throws for a heavy user and forgetUser " +
      "can then never succeed)",
  );
  const left = await t.run(async (ctx) => ctx.db.query("usage").collect());
  expect(left.length).toBe(0);
});
