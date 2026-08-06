/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const CREDS = { apiKey: "test-key", baseUrl: "https://api.evermind.test" };

/** Route a mocked EverOS request by path. */
function mockEveros(
  handlers: Partial<Record<string, (body: any) => unknown>>,
) {
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const path = new URL(u).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const handler = handlers[path];
      if (!handler) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(handler(body)), { status: 200 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A minimal v2 search response; all result arrays empty unless overridden. */
function searchResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      episodes: [],
      profiles: [],
      agent_cases: [],
      agent_skills: [],
      unprocessed_messages: [],
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remember + flush", () => {
  test("enqueues, flushes to the v2 ingest API, and retires the row once extracted", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const fetchMock = mockEveros({
      "/api/v2/memory/add": (body) => {
        // v2 has no top-level user_id or async_mode — identity rides on each
        // message's sender_id, and a session_id is always required.
        expect(body.user_id).toBeUndefined();
        expect(body.async_mode).toBeUndefined();
        expect(body.session_id).toBe("user:u1");
        expect(body.messages[0].content).toBe("I love espresso");
        expect(body.messages[0].sender_id).toBe("u1");
        return { data: { status: "queued", message_count: 1 } };
      },
      "/api/v2/memory/flush": (body) => {
        expect(body.session_id).toBe("user:u1");
        return { data: { status: "extracted" } };
      },
    });

    const { pendingId } = await t.mutation(api.lib.remember, {
      userId: "u1",
      content: "I love espresso",
      ...CREDS,
    });
    expect(pendingId).toBeDefined();

    // The remember mutation scheduled a flush; run it (and anything it schedules).
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // One ingest POST + one eager-extraction flush POST.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // EverOS confirmed extraction, so the queue row is retired entirely
    // rather than accumulating for the life of the app.
    const row = await t.run(async (ctx) => ctx.db.get(pendingId as Id<"pending">));
    expect(row).toBeNull();

    // Usage was logged.
    const usage = await t.run(async (ctx) =>
      ctx.db
        .query("usage")
        .withIndex("by_user", (q) => q.eq("userId", "u1"))
        .collect(),
    );
    expect(usage.some((u) => u.op === "remember")).toBe(true);
  });

  test("retries flush while the ingest hasn't landed (no_extraction)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    let flushCalls = 0;
    mockEveros({
      "/api/v2/memory/add": () => ({
        data: { status: "queued", message_count: 1 },
      }),
      "/api/v2/memory/flush": () => {
        flushCalls++;
        // First flush hits the ingest landing window (a silent no-op);
        // the retry succeeds.
        return {
          data: { status: flushCalls === 1 ? "no_extraction" : "extracted" },
        };
      },
    });

    const { pendingId } = await t.mutation(api.lib.remember, {
      userId: "u1",
      content: "landed late",
      ...CREDS,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(flushCalls).toBe(2);
    const row = await t.run(async (ctx) => ctx.db.get(pendingId as Id<"pending">));
    expect(row).toBeNull();
  });

  test("rejects empty content with a clear error", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.lib.remember, { userId: "u1", content: "   ", ...CREDS }),
    ).rejects.toThrow(/empty content/);
  });

  test("retries a failed ingest on its own and gives up after MAX_ATTEMPTS", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    // Force fetch to return a server error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server error", { status: 500 })),
    );

    const { pendingId } = await t.mutation(api.lib.remember, {
      userId: "u1",
      content: "will fail",
      ...CREDS,
    });
    // A requeued row must not wait for the next remember() — the flush
    // schedules its own retry, so draining the scheduler exhausts them.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await t.run(async (ctx) => ctx.db.get(pendingId as Id<"pending">));
    expect(row?.attempts).toBe(5);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("500");

    // And the failure is reportable rather than silent.
    const status = await t.query(api.lib.getPendingStatus, { userId: "u1" });
    expect(status.failed).toBe(1);
    expect(status.lastError).toContain("500");
  });

  test("clears rows left behind by the previous version", async () => {
    const t = convexTest(schema, modules);
    mockEveros({
      "/api/v2/memory/add": () => ({
        data: { status: "queued", message_count: 1 },
      }),
    });
    // Rows written by 0.1: a status and fields this version no longer writes.
    // Convex validates every existing document on deploy, so an upgrade must
    // still accept them, and the leftovers must not linger forever.
    await t.run(async (ctx) => {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "written by 0.1",
        role: "user",
        status: "extracted",
        attempts: 0,
        metadata: { source: "email" },
        everosTaskId: "task-from-v1",
      });
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "new work",
        role: "user",
        status: "queued",
        attempts: 0,
      });
    });

    await t.action(internal.lib.flush, { eager: false, ...CREDS });

    const rows = await t.run(async (ctx) => ctx.db.query("pending").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("new work");
  });

  test("recovers rows claimed by a flush that died before reporting back", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { status: "queued", message_count: 1 } }), {
          status: 200,
        }),
      ),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "claimed then abandoned",
        role: "user",
        status: "queued",
        attempts: 0,
      });
    });
  
    // Claim the row and then stop, exactly as an action that dies mid-flight
    // leaves things. Nothing else happens: no further remember(), no manual flush.
    await t.mutation(internal.lib.claimQueued, { ...CREDS });
    const stranded = await t.run(async (ctx) => ctx.db.query("pending").collect());
    expect(stranded[0].status).toBe("sending");
  
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  
    // The claim scheduled its own recovery, so the row was picked back up.
    const after = await t.run(async (ctx) => ctx.db.query("pending").collect());
    expect(after[0]?.status).not.toBe("sending");
  });

  test("retires rows when a sibling extraction already drained the buffer", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    let flushCalls = 0;
    mockEveros({
      "/api/v2/memory/add": () => ({
        data: { status: "queued", message_count: 1 },
      }),
      // Two remembers in one session schedule two extractions against one
      // server-side buffer. The first drains it; every later one sees an empty
      // buffer and reports no_extraction forever.
      "/api/v2/memory/flush": () => {
        flushCalls++;
        return {
          data: { status: flushCalls === 1 ? "extracted" : "no_extraction" },
        };
      },
    });

    await t.mutation(api.lib.remember, {
      userId: "u1",
      content: "first",
      sessionId: "s1",
      ...CREDS,
    });
    await t.mutation(api.lib.remember, {
      userId: "u1",
      content: "second",
      sessionId: "s1",
      ...CREDS,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // `sent` must not be a state rows can never leave: the table would grow
    // for the life of the app and getPendingStatus would never read zero.
    const rows = await t.run(async (ctx) => ctx.db.query("pending").collect());
    expect(rows).toHaveLength(0);
    const status = await t.query(api.lib.getPendingStatus, { userId: "u1" });
    expect(status.unextracted).toBe(0);
  });

  test("concurrent flushes never ingest the same row twice", async () => {
    const t = convexTest(schema, modules);
    const adds: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        const path = new URL(url.toString()).pathname;
        if (path === "/api/v2/memory/add") {
          adds.push(JSON.parse(init.body));
          // Hold the request open so the second flush overlaps this one.
          await new Promise((r) => setTimeout(r, 50));
          return new Response(
            JSON.stringify({ data: { status: "queued", message_count: 1 } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: { status: "extracted" } }), {
          status: 200,
        });
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "only once please",
        role: "user",
        status: "queued",
        attempts: 0,
      });
    });

    await Promise.all([
      t.action(internal.lib.flush, { eager: false, ...CREDS }),
      t.action(internal.lib.flush, { eager: false, ...CREDS }),
    ]);

    const sent = adds.flatMap((b) => b.messages.map((m: any) => m.content));
    expect(sent).toEqual(["only once please"]);
  });
});

describe("namespace scoping", () => {
  test("sends appId/projectId on every call so one account can hold several spaces", async () => {
    const t = convexTest(schema, modules);
    const bodies: Record<string, any> = {};
    mockEveros({
      "/api/v2/memory/add": (body) => {
        bodies.add = body;
        return { data: { status: "queued", message_count: 1 } };
      },
      "/api/v2/memory/search": (body) => {
        bodies.search = body;
        return searchResponse();
      },
      "/api/v2/memory/delete": (body) => {
        bodies.delete = body;
        return { data: { filters: ["user_id"], count: 0 } };
      },
    });
    const SCOPED = { ...CREDS, appId: "demo", projectId: "demo" };

    await t.run(async (ctx) => {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "scoped write",
        role: "user",
        status: "queued",
        attempts: 0,
      });
    });
    await t.action(internal.lib.flush, { eager: false, ...SCOPED });
    await t.action(api.lib.recall, { userId: "u1", query: "q", ...SCOPED });
    await t.action(api.lib.forgetUser, { userId: "u1", ...SCOPED });

    // Without these, a demo and production sharing one account read and
    // delete each other's memories.
    for (const key of ["add", "search", "delete"]) {
      expect(bodies[key].app_id).toBe("demo");
      expect(bodies[key].project_id).toBe("demo");
    }
  });

  test("omits them entirely when unset, so EverOS applies its own default", async () => {
    const t = convexTest(schema, modules);
    let body: any;
    mockEveros({
      "/api/v2/memory/search": (b) => {
        body = b;
        return searchResponse();
      },
    });
    await t.action(api.lib.recall, { userId: "u1", query: "q", ...CREDS });
    expect(body.app_id).toBeUndefined();
    expect(body.project_id).toBeUndefined();
  });
});

describe("recall", () => {
  test("searches EverOS and hydrates the local index", async () => {
    const t = convexTest(schema, modules);
    mockEveros({
      "/api/v2/memory/search": (body) => {
        expect(body.query).toBe("what coffee do I like");
        // v2 scopes by top-level user_id (no filters object).
        expect(body.user_id).toBe("u1");
        expect(body.include_profile).toBe(true);
        return searchResponse({
          episodes: [
            {
              id: "ep-1",
              user_id: "u1",
              session_id: "s1",
              // Live API returns null (not absent) for optional strings,
              // null score, ISO-string timestamp, type "Conversation" —
              // recall must normalize all of these.
              summary: null,
              episode: "User loves espresso",
              type: "Conversation",
              timestamp: "2026-07-08T19:13:21",
              score: null,
              atomic_facts: [
                {
                  id: "af-1",
                  // v2 renamed the fact text field to `content`.
                  content: "u1 drinks espresso every morning",
                  score: 0.79,
                  timestamp: "2026-07-08T19:13:21",
                  session_id: null, // null must become undefined, not throw
                },
                { id: "af-2", content: "" }, // empty facts should be filtered out
              ],
            },
          ],
        });
      },
    });

    const results = await t.action(api.lib.recall, {
      userId: "u1",
      query: "what coffee do I like",
      topK: 5,
      ...CREDS,
    });
    expect(results).toHaveLength(1);
    expect(results[0].everosMemoryId).toBe("ep-1");
    expect(results[0].text).toBe("User loves espresso");
    expect(results[0].kind).toBe("episodic");
    expect(results[0].score).toBeUndefined();
    expect(results[0].timestamp).toBe(Date.parse("2026-07-08T19:13:21Z"));
    expect(results[0].summary).toBeUndefined(); // null coerced to undefined
    expect(results[0].sessionId).toBe("s1");
    // Atomic facts surfaced for traceability; empty ones filtered out.
    expect(results[0].atomicFacts).toHaveLength(1);
    expect(results[0].atomicFacts![0].text).toBe(
      "u1 drinks espresso every morning",
    );
    expect(results[0].atomicFacts![0].score).toBeCloseTo(0.79);
    expect(results[0].atomicFacts![0].sessionId).toBeUndefined();

    // Local index hydrated.
    const mem = await t.run(async (ctx) =>
      ctx.db
        .query("memories")
        .withIndex("by_user", (q) => q.eq("userId", "u1"))
        .collect(),
    );
    expect(mem).toHaveLength(1);
    expect(mem[0].everosMemoryId).toBe("ep-1");
    expect(mem[0].preview).toContain("espresso");
    expect(mem[0].sessionId).toBe("s1");
  });

  test("renders profile items as readable text, not serialized records", async () => {
    const t = convexTest(schema, modules);
    mockEveros({
      "/api/v2/memory/search": () =>
        searchResponse({
          profiles: [
            {
              id: "prof-1",
              user_id: "u1",
              profile_data: {
                summary: "Alex is on the Pro plan.",
                explicit_info: [
                  {
                    category: "subscription",
                    description: "Alex is on the Pro plan, billed annually.",
                    evidence: "Alex said 'I'm on the Pro plan'.",
                    item_id: "ei_6a73a1731d3a82c08a7ae316",
                    source: "llm",
                    created_at: "2026-08-05T20:47:47.123560+00:00",
                  },
                ],
                implicit_traits: [
                  {
                    trait: "routine-oriented",
                    description: "Alex follows a consistent weekly schedule.",
                    item_id: "it_6a73a1731d3a82c08a7ae317",
                  },
                ],
              },
            },
          ],
        }),
    });

    const results = await t.action(api.lib.recall, {
      userId: "u1",
      query: "who is this customer",
      ...CREDS,
    });
    const profile = results.find((r) => r.kind === "profile")!;
    expect(profile.text).toBe(
      "Alex is on the Pro plan, billed annually.; " +
        "Alex follows a consistent weekly schedule.",
    );
    // Provenance must not leak into text that reaches a prompt or a UI.
    expect(profile.text).not.toContain("item_id");
    expect(profile.text).not.toContain("created_at");
    expect(profile.text).not.toContain("{");
  });

  test("merges not-yet-extracted content as pending (read-your-writes)", async () => {
    const t = convexTest(schema, modules);
    mockEveros({ "/api/v2/memory/search": () => searchResponse() });
    // Content ingested but not yet extracted server-side.
    await t.run(async (ctx) => {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "I just switched to oat milk",
        role: "user",
        status: "sent",
        attempts: 0,
      });
      // Another user's queue must not leak in.
      await ctx.db.insert("pending", {
        userId: "u2",
        content: "not mine",
        role: "user",
        status: "sent",
        attempts: 0,
      });
      // A permanently failed row is not "recent content" either.
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "old news",
        role: "user",
        status: "failed",
        attempts: 5,
      });
    });

    const results = await t.action(api.lib.recall, {
      userId: "u1",
      query: "milk",
      ...CREDS,
    });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("I just switched to oat milk");
    expect(results[0].pending).toBe(true);
    expect(results[0].everosMemoryId).toMatch(/^pending:/);

    // Opt out returns only extracted memories.
    const strict = await t.action(api.lib.recall, {
      userId: "u1",
      query: "milk",
      includeRecent: false,
      ...CREDS,
    });
    expect(strict).toHaveLength(0);
  });

  test("surfaces the newest content, not the oldest backlog", async () => {
    const t = convexTest(schema, modules);
    mockEveros({ "/api/v2/memory/search": () => searchResponse() });
    // More unextracted rows than the merge returns. An ascending scan that
    // slices the head would hand back the oldest ones and drop the thing the
    // user just said, which is the entire point of the merge.
    await t.run(async (ctx) => {
      for (let i = 1; i <= 30; i++) {
        await ctx.db.insert("pending", {
          userId: "u1",
          content: `note ${i}`,
          role: "user",
          status: "sent",
          attempts: 0,
        });
      }
    });

    const results = await t.action(api.lib.recall, {
      userId: "u1",
      query: "note 30",
      ...CREDS,
    });
    const texts = results.map((r) => r.text);
    expect(texts).toContain("note 30");
    expect(texts).not.toContain("note 1");
    // Bounded so unranked rows cannot crowd out ranked results in a prompt.
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test("stops merging stalled rows after the max age", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    mockEveros({ "/api/v2/memory/search": () => searchResponse() });
    await t.run(async (ctx) => {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "stuck in sent forever",
        role: "user",
        status: "sent",
        attempts: 0,
      });
    });

    const fresh = await t.action(api.lib.recall, {
      userId: "u1",
      query: "anything",
      ...CREDS,
    });
    expect(fresh).toHaveLength(1);

    // 20 minutes later the row counts as a stalled pipeline, not recent
    // content — its text was almost certainly extracted server-side.
    vi.advanceTimersByTime(20 * 60_000);
    const later = await t.action(api.lib.recall, {
      userId: "u1",
      query: "anything",
      ...CREDS,
    });
    expect(later).toHaveLength(0);
  });
});

describe("getProfile", () => {
  test("fetches profile memory", async () => {
    const t = convexTest(schema, modules);
    mockEveros({
      "/api/v2/memory/get": (body) => {
        expect(body.memory_type).toBe("profile");
        expect(body.user_id).toBe("u1");
        return {
          data: {
            profiles: [
              {
                id: "prof-1",
                user_id: "u1",
                scenario: "personal",
                profile_data: {
                  summary: "Alex, prefers concise answers",
                  explicit_info: ["name: Alex"],
                  implicit_traits: ["prefers concise answers"],
                },
              },
            ],
            total_count: 1,
            count: 1,
          },
        };
      },
    });

    const profiles = await t.action(api.lib.getProfile, {
      userId: "u1",
      ...CREDS,
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].scenario).toBe("personal");
    expect(profiles[0].summary).toBe("Alex, prefers concise answers");
    expect(profiles[0].implicitTraits).toContain("prefers concise answers");
  });

  test("returns [] when the user has no profile yet", async () => {
    const t = convexTest(schema, modules);
    mockEveros({
      "/api/v2/memory/get": () => ({
        data: { profiles: [], total_count: 0, count: 0 },
      }),
    });
    const profiles = await t.action(api.lib.getProfile, {
      userId: "u1",
      ...CREDS,
    });
    expect(profiles).toEqual([]);
  });
});

describe("forgetSession", () => {
  test("deletes the session remotely and clears matching local rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memories", {
        userId: "u1",
        everosMemoryId: "ep-1",
        kind: "episodic",
        preview: "something",
        sessionId: "s1",
        syncedAt: Date.now(),
      });
      // A different session's row must survive.
      await ctx.db.insert("memories", {
        userId: "u1",
        everosMemoryId: "ep-2",
        kind: "episodic",
        preview: "other session",
        sessionId: "s2",
        syncedAt: Date.now(),
      });
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "queued in s1",
        role: "user",
        sessionId: "s1",
        status: "sent",
        attempts: 0,
      });
    });
    mockEveros({
      "/api/v2/memory/delete": (body) => {
        // v2 deletes by scope; a single memory_id is not accepted.
        expect(body.session_id).toBe("s1");
        return { data: { filters: ["session_id"], count: 3 } };
      },
    });

    const res = await t.action(api.lib.forgetSession, {
      userId: "u1",
      sessionId: "s1",
      ...CREDS,
    });
    expect(res.deletedCount).toBe(3);

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("memories").collect(),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].everosMemoryId).toBe("ep-2");
    const pending = await t.run(async (ctx) => ctx.db.query("pending").collect());
    expect(pending).toHaveLength(0);
  });
});

describe("listMemories", () => {
  test("paginates the local index for a user", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("memories", {
          userId: "u1",
          everosMemoryId: `ep-${i}`,
          kind: "episodic",
          preview: `memory ${i}`,
          syncedAt: Date.now() + i,
        });
      }
      await ctx.db.insert("memories", {
        userId: "u2",
        everosMemoryId: "other",
        kind: "episodic",
        preview: "not mine",
        syncedAt: Date.now(),
      });
    });

    const page = await t.query(api.lib.listMemories, {
      userId: "u1",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page).toHaveLength(3);
    expect(page.page.every((m) => m.userId === "u1")).toBe(true);
  });
});

describe("flush batching", () => {
  test("groups queued items by (user, session) — one ingest call per session", async () => {
    const t = convexTest(schema, modules);
    const ingest = vi.fn();
    mockEveros({
      "/api/v2/memory/add": (body) => {
        ingest(body);
        return {
          data: { status: "queued", message_count: body.messages.length },
        };
      },
    });
    // Seed the queue directly so batching is tested independent of scheduler timing.
    await t.run(async (ctx) => {
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "fact one",
        role: "user",
        sessionId: "s1",
        status: "queued",
        attempts: 0,
      });
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "fact two",
        role: "user",
        sessionId: "s1",
        status: "queued",
        attempts: 0,
      });
      // Different session → must be a separate ingest call.
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "other",
        role: "user",
        sessionId: "s2",
        status: "queued",
        attempts: 0,
      });
      // No session → the per-user default session.
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "sessionless",
        role: "user",
        status: "queued",
        attempts: 0,
      });
    });

    // eager: false so no extraction flushes are scheduled — isolate ingest.
    await t.action(internal.lib.flush, { eager: false, ...CREDS });

    // s1 (2 messages) + s2 (1) + user:u1 (1) = three ingest calls.
    expect(ingest).toHaveBeenCalledTimes(3);
    const s1 = ingest.mock.calls.find((c) => c[0].session_id === "s1");
    expect(s1![0].messages).toHaveLength(2);
    const sessionless = ingest.mock.calls.find(
      (c) => c[0].session_id === "user:u1",
    );
    expect(sessionless![0].messages).toHaveLength(1);
    const rows = await t.run(async (ctx) => ctx.db.query("pending").collect());
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });
});

describe("flush give-up", () => {
  test("marks a row failed after MAX_ATTEMPTS (5)", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 500 })),
    );
    // A row that has already failed 4 times — the next failure is the 5th.
    const id = await t.run(async (ctx) =>
      ctx.db.insert("pending", {
        userId: "u1",
        content: "x",
        role: "user",
        status: "queued",
        attempts: 4,
      }),
    );

    await t.action(internal.lib.flush, { ...CREDS });

    const row = await t.run(async (ctx) => ctx.db.get(id as Id<"pending">));
    expect(row?.attempts).toBe(5);
    expect(row?.status).toBe("failed");
  });
});

describe("forgetUser", () => {
  test("batch-deletes remotely and clears all of the user's local rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memories", {
        userId: "u1",
        everosMemoryId: "e1",
        kind: "episodic",
        preview: "p",
        syncedAt: Date.now(),
      });
      await ctx.db.insert("pending", {
        userId: "u1",
        content: "c",
        role: "user",
        status: "sent",
        attempts: 0,
      });
      await ctx.db.insert("usage", { userId: "u1", op: "recall", ts: Date.now() });
      // A different user's row must be left untouched.
      await ctx.db.insert("memories", {
        userId: "u2",
        everosMemoryId: "e2",
        kind: "episodic",
        preview: "other",
        syncedAt: Date.now(),
      });
    });
    mockEveros({
      "/api/v2/memory/delete": (body) => {
        expect(body.user_id).toBe("u1");
        return { data: { filters: ["user_id"], count: 5 } };
      },
    });

    const res = await t.action(api.lib.forgetUser, { userId: "u1", ...CREDS });
    expect(res.deletedCount).toBe(5);

    const mem = await t.run(async (ctx) => ctx.db.query("memories").collect());
    expect(mem).toHaveLength(1);
    expect(mem[0].userId).toBe("u2");
    const pending = await t.run(async (ctx) => ctx.db.query("pending").collect());
    expect(pending).toHaveLength(0);
  });
});
