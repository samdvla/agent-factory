import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type AgentMessageRow, type AgentMessageImportance } from "../../api";
import { ROLES } from "../state/fixtures";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ROLE_FALLBACK = "#94a3b8";

function roleColor(role: string): string {
  if (role === "*") return "#94a3b8";
  return ROLES[role]?.hex ?? ROLE_FALLBACK;
}

function roleLabel(role: string): string {
  if (role === "*") return "broadcast";
  return ROLES[role]?.title ?? role;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = Date.now();
  const ageSec = (now - ts * 1000) / 1000;
  if (ageSec < 60) return `${Math.max(1, Math.floor(ageSec))}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return d.toLocaleString();
}

function importanceClass(i: AgentMessageImportance): string {
  if (i === "critical") return "conv-msg--critical";
  if (i === "heads_up") return "conv-msg--heads-up";
  return "conv-msg--info";
}

/**
 * Conversations modal: chronological log of agent-to-agent messages so the
 * boss can see how the team is reasoning together (not just task hand-offs).
 */
export default function ConversationsModal({ open, onClose }: Props) {
  const [messages, setMessages] = useState<AgentMessageRow[]>([]);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listAgentMessages({ limit: 200, role: roleFilter });
      setMessages(rows);
    } catch {
      // Silent during boot / non-Tauri
    } finally {
      setLoading(false);
    }
  }, [roleFilter]);

  useEffect(() => {
    if (!open) return;
    load();
    let unlisten: UnlistenFn | undefined;
    listen<{ kind?: string; method?: string }>("supervisor:event", (e) => {
      const p = e.payload as { kind?: string; method?: string };
      // The supervisor mirrors message inserts as a WorkerNotification with
      // method="agent_message" — reload on any of those.
      if (p.method === "agent_message" || p.kind === "worker_notification") {
        load();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open, load]);

  // Esc to close, lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const knownRoles = Object.keys(ROLES);

  return (
    <div
      className="settings-back"
      role="dialog"
      aria-modal="true"
      aria-label="Conversations — agent-to-agent message log"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="activity-modal">
        <div className="settings-modal-head">
          <div className="settings-modal-head-left">
            <span
              className="settings-modal-tag"
              style={{
                color: "#9be0b3",
                borderColor: "rgba(155, 224, 179, 0.3)",
                background: "rgba(155, 224, 179, 0.08)",
              }}
            >
              Conversations
            </span>
            <span className="settings-modal-title">
              Agents talking — design briefs, prompt updates, heads-ups
            </span>
          </div>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close conversations"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="conv-filter-row">
          <button
            type="button"
            className={`conv-filter${roleFilter === null ? " is-active" : ""}`}
            onClick={() => setRoleFilter(null)}
          >
            All
          </button>
          {knownRoles.map((r) => (
            <button
              key={r}
              type="button"
              className={`conv-filter${roleFilter === r ? " is-active" : ""}`}
              style={
                roleFilter === r
                  ? ({ "--c": roleColor(r) } as React.CSSProperties)
                  : undefined
              }
              onClick={() => setRoleFilter(r)}
            >
              <span className="conv-filter-dot" style={{ background: roleColor(r) }} />
              {ROLES[r]?.title ?? r}
            </button>
          ))}
          <button type="button" className="conv-refresh" onClick={load} disabled={loading}>
            {loading ? "…" : "↻"}
          </button>
        </div>

        <div className="activity-modal-body" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="conv-empty">
              {loading
                ? "Loading conversation log…"
                : "No messages yet. As soon as research, designer, or strategist run, they'll talk here."}
            </div>
          ) : (
            <ul className="conv-list">
              {messages.map((m) => (
                <li key={m.id} className={`conv-msg ${importanceClass(m.importance)}`}>
                  <div className="conv-msg-head">
                    <span
                      className="conv-msg-from"
                      style={{
                        color: roleColor(m.from_role),
                        borderColor: roleColor(m.from_role),
                      }}
                    >
                      {roleLabel(m.from_role)}
                    </span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="conv-msg-arrow"
                      aria-hidden="true"
                    >
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                    <span
                      className="conv-msg-to"
                      style={{ color: roleColor(m.to_role) }}
                    >
                      {roleLabel(m.to_role)}
                    </span>
                    {m.topic && <span className="conv-msg-topic">{m.topic}</span>}
                    {m.importance !== "info" && (
                      <span className={`conv-msg-badge ${importanceClass(m.importance)}`}>
                        {m.importance === "critical" ? "critical" : "heads-up"}
                      </span>
                    )}
                    <span className="conv-msg-time">{fmtTime(m.ts)}</span>
                  </div>
                  <div className="conv-msg-body">{m.content}</div>
                  {m.job_id != null && (
                    <div className="conv-msg-foot">job #{m.job_id}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
