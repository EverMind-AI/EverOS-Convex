import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useThreadMessages, toUIMessages } from "@convex-dev/agent/react";
import { api } from "../convex/_generated/api.js";

// Per-browser customer, persisted so memory survives reloads while each viewer
// gets their own memory space.
function getCustomerId(): string {
  const KEY = "lumon-demo-customer-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
const CUSTOMER_ID = getCustomerId();

export default function App() {
  const conversation = useQuery(api.chat.getConversation, {
    customerId: CUSTOMER_ID,
  });
  const ensureConversation = useMutation(api.chat.ensureConversation);
  const seed = useAction(api.chat.seedReturningCustomer);
  const seeding = useRef(false);

  useEffect(() => {
    void (async () => {
      const { conversationId, needsSeed } = await ensureConversation({
        customerId: CUSTOMER_ID,
      });
      if (needsSeed && !seeding.current) {
        seeding.current = true;
        await seed({ customerId: CUSTOMER_ID, conversationId });
      }
    })();
  }, [ensureConversation, seed]);

  if (!conversation) {
    return (
      <div className="app">
        <TopBar ticketNo="…" />
        <div className="loading">Setting up conversation…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar ticketNo={conversation.ticketNo} />
      <div className="layout">
        <ConversationPanel conversation={conversation} />
        <ConsolePanel conversation={conversation} />
      </div>
    </div>
  );
}

function TopBar({ ticketNo }: { ticketNo: string }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">◆</span> Mindy
        <span className="brand-sub">AI Support · by EverMind</span>
      </div>
      <div className="topbar-right">
        <span className="crumb">Lumon</span>
        <span className="crumb-sep">/</span>
        <span className="crumb">Tickets</span>
        <span className="crumb-sep">/</span>
        <span className="ticket-no">{ticketNo}</span>
        <span className="pill pill-open">Open</span>
      </div>
    </header>
  );
}

type Conversation = NonNullable<
  ReturnType<typeof useQuery<typeof api.chat.getConversation>>
>;

function messageText(m: any): string {
  if (typeof m.text === "string" && m.text) return m.text;
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
  }
  if (typeof m.content === "string") return m.content;
  return "";
}

function ThreadMessages({ threadId }: { threadId: string }) {
  const messages = useThreadMessages(
    api.chat.listThreadMessages,
    { threadId },
    { initialNumItems: 100 },
  );
  const ui = toUIMessages(messages.results ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  return (
    <>
      {ui.map((m) => (
        <div key={m.key} className={`msg ${m.role}`}>
          <div className="msg-meta">
            {m.role === "user" ? "Alex Chen · Customer" : "Agent"}
          </div>
          <div className="msg-body">{messageText(m)}</div>
        </div>
      ))}
    </>
  );
}

function ConversationPanel({ conversation }: { conversation: Conversation }) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendMessage = useAction(api.chat.sendMessage);
  const escalate = useAction(api.chat.escalate);

  const tier = conversation.currentTier;
  const tierInfo = conversation.tiers[tier];
  const escalated = conversation.tier2ThreadId !== null;

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || pending) return;
    setInput("");
    setPending(true);
    setError(null);
    try {
      await sendMessage({
        conversationId: conversation._id,
        customerId: CUSTOMER_ID,
        prompt,
      });
    } catch (err) {
      // Surface the server message (e.g. the shared-demo message budget)
      // instead of failing silently.
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^\[.*?\]\s*/, "").split("\n")[0]);
      setInput(prompt);
    } finally {
      setPending(false);
    }
  }

  async function onEscalate() {
    if (escalating || escalated) return;
    setEscalating(true);
    try {
      await escalate({
        conversationId: conversation._id,
        customerId: CUSTOMER_ID,
      });
    } finally {
      setEscalating(false);
    }
  }

  return (
    <section className="panel conv">
      <div className="panel-head">
        <div>
          <div className="agent-name">
            {tierInfo.label}
            <span className={`pill ${tier === "tier2" ? "pill-tier2" : "pill-tier1"}`}>
              {tier === "tier2" ? "Specialist" : "Frontline"}
            </span>
          </div>
          <div className="agent-sub">
            {tierInfo.sub} · <code>{tierInfo.model}</code>
          </div>
        </div>
        {!escalated && (
          <button
            className="btn btn-secondary"
            onClick={onEscalate}
            disabled={escalating}
          >
            {escalating ? "Escalating…" : "Escalate to specialist"}
          </button>
        )}
      </div>

      <div className="messages">
        <ThreadMessages threadId={conversation.tier1ThreadId} />
        {escalated && (
          <div className="handoff">
            <span>
              Escalated to {conversation.tiers.tier2.label} (
              <code>{conversation.tiers.tier2.model}</code>) — new thread, no
              shared history. Context restored from EverOS memory.
            </span>
          </div>
        )}
        {conversation.tier2ThreadId && (
          <ThreadMessages threadId={conversation.tier2ThreadId} />
        )}
        {(pending || escalating) && (
          <div className="msg assistant">
            <div className="msg-meta">Agent</div>
            <div className="msg-body typing">…</div>
          </div>
        )}
      </div>

      {error && <div className="composer-error">{error}</div>}

      <form className="composer" onSubmit={onSend}>
        <input
          value={input}
          placeholder="Reply as the customer…"
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={pending}>
          Send
        </button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Right column: the live agent console
// ---------------------------------------------------------------------------

function ConsolePanel({ conversation }: { conversation: Conversation }) {
  return (
    <aside className="console">
      <CustomerMemoryCard escalatedAt={conversation.escalatedAt} />
      <RecalledContextCard conversationId={conversation._id} />
      <ActivityCard conversationId={conversation._id} />
    </aside>
  );
}

function CustomerMemoryCard({ escalatedAt }: { escalatedAt: number | null }) {
  const getMemory = useAction(api.chat.getCustomerMemory);
  const [facts, setFacts] = useState<
    { text: string; score?: number; timestamp?: number }[] | null
  >(null);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      setFacts(await getMemory({ customerId: CUSTOMER_ID }));
    } finally {
      setRefreshing(false);
    }
  }

  // Load on mount and again after escalation (memory evolves).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escalatedAt]);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Customer memory</span>
        <span className="card-tools">
          <span className="src-tag">EverOS</span>
          <button
            className="icon-btn"
            onClick={() => void refresh()}
            title="Refresh"
          >
            {refreshing ? "⟳" : "↻"}
          </button>
        </span>
      </div>
      <div className="card-body">
        <div className="kv">
          <span className="k">Customer</span>
          <span className="v">Alex Chen</span>
        </div>
        <div className="kv">
          <span className="k">Plan</span>
          <span className="v">Pro (annual)</span>
        </div>
        {facts === null ? (
          <div className="muted">Loading memory…</div>
        ) : facts.length === 0 ? (
          <div className="muted">
            No extracted memories yet — EverOS is processing the previous
            session (~30s).
          </div>
        ) : (
          <ul className="fact-list">
            {facts.map((f, i) => (
              <li key={i}>
                <span className="fact-text">{f.text}</span>
                {typeof f.score === "number" && (
                  <span className="mono score">{f.score.toFixed(2)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RecalledContextCard({ conversationId }: { conversationId: string }) {
  const recalls = useQuery(api.chat.getRecalls, { conversationId });
  const [flash, setFlash] = useState(false);
  const lastTs = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!recalls || recalls.memories.length === 0) return;
    if (lastTs.current === recalls.ts) return;
    const first = lastTs.current === undefined;
    lastTs.current = recalls.ts;
    if (first) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [recalls]);

  return (
    <div className={`card${flash ? " card-flash" : ""}`}>
      <div className="card-head">
        <span className="card-title">Recalled context</span>
        <span className="card-tools">
          <span className="src-tag">EverOS</span>
          <span className="live-dot" title="Live Convex query">
            ● live
          </span>
        </span>
      </div>
      <div className="card-body">
        {!recalls || recalls.memories.length === 0 ? (
          <div className="muted">
            Nothing recalled yet — send a message to see what the agent pulls
            from long-term memory.
          </div>
        ) : (
          recalls.memories.map((m) => (
            <RecalledMemory key={m.everosMemoryId} mem={m} />
          ))
        )}
      </div>
    </div>
  );
}

function RecalledMemory({
  mem,
}: {
  mem: {
    everosMemoryId: string;
    text: string;
    kind: string;
    atomicFacts?: { text: string; score?: number; timestamp?: number }[];
  };
}) {
  const [open, setOpen] = useState(false);
  const facts = mem.atomicFacts ?? [];
  return (
    <div className="recall">
      <div
        className={`recall-head${facts.length ? " clickable" : ""}`}
        onClick={() => facts.length && setOpen((o) => !o)}
      >
        <span className="badge badge-kind">{mem.kind}</span>
        <span className="recall-text">{mem.text}</span>
        {facts.length > 0 && (
          <span className="expander">
            {open ? "▾" : "▸"} {facts.length}
          </span>
        )}
      </div>
      {open && (
        <table className="facts-table">
          <tbody>
            {facts.map((f, i) => (
              <tr key={i}>
                <td className="fact-cell">{f.text}</td>
                <td className="mono score">
                  {typeof f.score === "number" ? f.score.toFixed(2) : "—"}
                </td>
                <td className="mono dim">
                  {typeof f.timestamp === "number"
                    ? new Date(f.timestamp).toISOString().slice(0, 10)
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  seeded: "SEED",
  remembered: "WRITE",
  recalled: "READ",
  escalated: "HANDOFF",
};

function ActivityCard({ conversationId }: { conversationId: string }) {
  const events = useQuery(api.chat.listMemoryEvents, { conversationId });
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Memory activity</span>
        <span className="card-tools">
          <span className="live-dot" title="Live Convex query">
            ● live
          </span>
        </span>
      </div>
      <div className="card-body log">
        {!events || events.length === 0 ? (
          <div className="muted">No activity yet.</div>
        ) : (
          events.map((e) => (
            <div key={e._id} className="log-row">
              <span className="mono dim">
                {new Date(e.ts).toLocaleTimeString([], {
                  hour12: false,
                })}
              </span>
              <span className={`badge badge-${e.type}`}>
                {EVENT_LABEL[e.type] ?? e.type}
              </span>
              <span className="log-detail">{e.detail}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
