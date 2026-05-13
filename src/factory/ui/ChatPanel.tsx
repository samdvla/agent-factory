import { useEffect, useRef, useState } from "react";
import { api, type ChatTurn } from "../../api";

interface Props {
  agentId: string;
}

type Msg = (ChatTurn | { from: "system"; text: string }) & { ts: number };

const STEER_MAX_LEN = 2000;

export default function ChatPanel({ agentId }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steerableRoles, setSteerableRoles] = useState<string[] | null>(null);
  const [steers, setSteers] = useState<string[]>([]);
  const [steerBusy, setSteerBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Wipe history when the selected agent changes — chat is per-agent.
  useEffect(() => {
    setMessages([]);
    setError(null);
    setInput("");
  }, [agentId]);

  // Auto-scroll to bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // One-time fetch: which agent ids accept Steer (the 4 LLM-driven roles).
  useEffect(() => {
    let cancelled = false;
    api
      .agentSteerRoles()
      .then((roles) => {
        if (!cancelled) setSteerableRoles(roles);
      })
      .catch(() => {
        if (!cancelled) setSteerableRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-agent: load current steer count whenever the selected agent changes.
  useEffect(() => {
    let cancelled = false;
    if (!steerableRoles?.includes(agentId)) {
      setSteers([]);
      return;
    }
    api
      .agentSteerList(agentId)
      .then((s) => {
        if (!cancelled) setSteers(s);
      })
      .catch(() => {
        if (!cancelled) setSteers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, steerableRoles]);

  const isSteerable = !!steerableRoles?.includes(agentId);

  const send = async () => {
    const trimmed = input.trim();
    if (!trimmed || pending) return;
    const userMsg: Msg = { from: "user", text: trimmed, ts: Date.now() };
    const nextHistory: Msg[] = [...messages, userMsg];
    setMessages(nextHistory);
    setInput("");
    setError(null);
    setPending(true);
    try {
      // Only user/agent turns go to the bridge — system markers stay local.
      const history: ChatTurn[] = messages
        .filter((m): m is ChatTurn & { ts: number } =>
          m.from === "user" || m.from === "agent",
        )
        .map((m) => ({ from: m.from, text: m.text }));
      const reply = await api.chatWithAgent(agentId, history, trimmed);
      setMessages((m) => [
        ...m,
        { from: "agent", text: reply.text, ts: Date.now() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setPending(false);
    }
  };

  const steer = async () => {
    const trimmed = input.trim();
    if (!trimmed || steerBusy || !isSteerable) return;
    if (trimmed.length > STEER_MAX_LEN) {
      setError(
        `Steer too long: ${trimmed.length} chars (max ${STEER_MAX_LEN}). ` +
          `Tighten it down to a single rule.`,
      );
      return;
    }
    setError(null);
    setSteerBusy(true);
    try {
      await api.agentSteerAdd(agentId, trimmed);
      const refreshed = await api.agentSteerList(agentId);
      setSteers(refreshed);
      setMessages((m) => [
        ...m,
        {
          from: "system",
          text:
            `✓ Standing instruction saved. ${agentId} will honor this on every ` +
            `future job (until you clear it).`,
          ts: Date.now(),
        },
      ]);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSteerBusy(false);
    }
  };

  const clearSteers = async () => {
    if (steerBusy || !isSteerable || steers.length === 0) return;
    setSteerBusy(true);
    try {
      await api.agentSteerClear(agentId);
      setSteers([]);
      setMessages((m) => [
        ...m,
        {
          from: "system",
          text: `Cleared all standing instructions for ${agentId}.`,
          ts: Date.now(),
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSteerBusy(false);
    }
  };

  const inputBusy = pending || steerBusy;

  return (
    <div
      className="drawer-section"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <div className="drawer-section-head">Chat</div>
      <div
        ref={listRef}
        className="chat-list"
        style={{ flex: 1, maxHeight: "none", overflowY: "auto" }}
      >
        {messages.length === 0 && !pending ? (
          <div className="empty-state">
            Say hi, ask what they're up to, or steer their focus. Each agent
            has its own conversation.
          </div>
        ) : (
          <>
            {messages.map((m, i) => {
              if (m.from === "system") {
                return (
                  <div
                    key={i}
                    className="chat-msg agent"
                    style={{ opacity: 0.85 }}
                  >
                    <div
                      className="chat-bubble"
                      style={{
                        background: "rgba(120, 200, 140, 0.10)",
                        borderColor: "rgba(120, 200, 140, 0.35)",
                        color: "var(--ink-1, #cbd5d0)",
                        fontStyle: "italic",
                      }}
                    >
                      {m.text}
                    </div>
                    <div className="chat-time">
                      {new Date(m.ts).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className={`chat-msg ${m.from}`}>
                  <div className="chat-bubble">{m.text}</div>
                  <div className="chat-time">
                    {new Date(m.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              );
            })}
            {pending && (
              <div className="chat-msg agent">
                <div
                  className="chat-bubble"
                  style={{ opacity: 0.6, fontStyle: "italic" }}
                >
                  …
                </div>
              </div>
            )}
          </>
        )}
        {error && (
          <div
            className="chat-msg agent"
            style={{ opacity: 0.85 }}
            title={error}
          >
            <div
              className="chat-bubble"
              style={{
                background: "rgba(232, 90, 90, 0.12)",
                borderColor: "rgba(232, 90, 90, 0.4)",
                color: "var(--accent-bad, #e85a5a)",
              }}
            >
              {error.length > 220 ? error.slice(0, 217) + "…" : error}
            </div>
          </div>
        )}
      </div>
      {isSteerable && steers.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 20px",
            fontSize: 11,
            color: "var(--ink-1, #9aa5a0)",
            background: "rgba(120, 200, 140, 0.06)",
            borderTop: "1px solid var(--line)",
          }}
          title={steers.map((s, i) => `${i + 1}. ${s}`).join("\n")}
        >
          <span>
            📌 {steers.length} standing instruction
            {steers.length === 1 ? "" : "s"} active
          </span>
          <button
            className="chat-send"
            style={{ padding: "2px 10px", fontSize: 11 }}
            onClick={clearSteers}
            disabled={steerBusy}
          >
            Clear
          </button>
        </div>
      )}
      <div className="chat-input-row">
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            pending
              ? "Waiting for reply…"
              : steerBusy
                ? "Saving instruction…"
                : `Message ${agentId}…`
          }
          disabled={inputBusy}
        />
        <button
          className="chat-send"
          onClick={send}
          disabled={inputBusy || !input.trim()}
        >
          {pending ? "…" : "Send"}
        </button>
        {isSteerable && (
          <button
            className="chat-send"
            onClick={steer}
            disabled={inputBusy || !input.trim()}
            title="Save as a standing instruction. Applied to every future job until cleared."
            style={{
              background: "rgba(120, 200, 140, 0.12)",
              borderColor: "rgba(120, 200, 140, 0.45)",
            }}
          >
            {steerBusy ? "…" : "Steer"}
          </button>
        )}
      </div>
    </div>
  );
}
