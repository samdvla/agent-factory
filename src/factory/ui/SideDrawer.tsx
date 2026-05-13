import { useEffect, useState } from "react";
import { useFactoryStore } from "../state/factoryStore";
import type { AgentEntry, Role } from "../state/types";
import ChatPanel from "./ChatPanel";
import LiveLog from "./LiveLog";
import QueuePanel from "./QueuePanel";
import ControlsRow from "./ControlsRow";

type Tab = "log" | "queue" | "chat" | "controls";

/**
 * Plain-language summary of what the agent is doing right now. Synthesized
 * from agent.state + task + walkTarget so the operator never has to read raw
 * log lines to understand "is it busy or stuck?"
 */
function thinkingSummary(agent: AgentEntry, role: Role | undefined): {
  headline: string; sub?: string;
} {
  const who = role?.name ?? agent.role;
  const task = agent.task?.trim();
  switch (agent.state) {
    case "working":
      return {
        headline: task ? task : `Working on job #${agent.currentJobId ?? "—"}`,
        sub: agent.currentJobId != null ? `job #${agent.currentJobId} · ${agent.model}` : agent.model,
      };
    case "walking":
      return {
        headline: agent.walkTarget ? `Heading to ${agent.walkTarget}` : "Walking to next station",
        sub: agent.currentJobId != null ? `job #${agent.currentJobId} in flight` : undefined,
      };
    case "awaiting":
      return {
        headline: "Waiting for the next job to arrive",
        sub: "queue is empty — ready when work shows up",
      };
    case "idle":
      return {
        headline: "Idle — ready for new work",
        sub: `${who} is on standby`,
      };
    case "paused":
      return {
        headline: "Paused — not claiming new jobs",
        sub: "resume to bring back online",
      };
    case "crashed":
      return {
        headline: agent.restartIn != null
          ? `Crashed — restarting in ${Math.max(0, Math.round(agent.restartIn))}s`
          : "Crashed — awaiting restart",
        sub: task,
      };
    case "killed":
      return { headline: "Stopped by operator", sub: "use Resume to bring online" };
    case "quarantined":
      return { headline: "Quarantined — held for review", sub: task };
    case "materializing":
      return { headline: "Just spawned — coming online", sub: who };
    case "dissolving":
      return { headline: "Going offline", sub: who };
    default:
      return { headline: task || "—" };
  }
}

/** Pick a small mono glyph that reads at a glance for the thinking row. */
function stateGlyph(state: AgentEntry["state"]): string {
  switch (state) {
    case "working": return "⚙";
    case "walking": return "→";
    case "awaiting": return "…";
    case "idle": return "·";
    case "paused": return "‖";
    case "crashed": return "!";
    case "killed": return "✕";
    case "quarantined": return "Q";
    default: return "•";
  }
}

const COLLAPSED_KEY = "agentFactory.agentPanel.collapsed.v1";

export default function SideDrawer() {
  const drawerOpen = useFactoryStore((s) => s.drawerOpen);
  const selectedAgentId = useFactoryStore((s) => s.selectedAgent);
  const agent = useFactoryStore((s) =>
    selectedAgentId ? s.agents[selectedAgentId] : null
  );
  const role = useFactoryStore((s) =>
    selectedAgentId ? s.roles[selectedAgentId] : undefined
  );
  const [tab, setTab] = useState<Tab>("log");
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
  });
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch {}
      return next;
    });
  };

  const close = () => useFactoryStore.getState().selectAgent(null);

  // Esc still closes the panel — fast keyboard exit.
  useEffect(() => {
    if (!drawerOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [drawerOpen]);

  if (!drawerOpen || !selectedAgentId || !agent) return null;

  const summary = thinkingSummary(agent, role);

  return (
    <aside
      className={`agent-panel${collapsed ? " is-collapsed" : ""}`}
      style={{ "--role-color": role?.hex ?? "var(--accent)" } as React.CSSProperties}
    >
      <button
        type="button"
        className="agent-panel-head"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand agent panel" : "Collapse agent panel"}
        title={collapsed ? "Expand agent panel" : "Collapse agent panel"}
      >
        <div
          className="agent-panel-portrait"
          style={{ background: role?.hex ?? "var(--bg-3)" }}
        >
          {role?.portrait ?? "?"}
        </div>
        <div className="agent-panel-titles">
          <div className="agent-panel-role">{role?.title ?? selectedAgentId}</div>
          <div className="agent-panel-name">{role?.name ?? selectedAgentId}</div>
        </div>
        <span
          className="agent-panel-close"
          role="button"
          tabIndex={0}
          aria-label="Close agent panel"
          title="Close"
          onClick={(e) => { e.stopPropagation(); close(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="9" height="9">
            <path
              d="M3 3L13 13M13 3L3 13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="agent-panel-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="10" height="10">
            <polyline
              points="4 6 8 10 12 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {!collapsed && <>
      <div className="agent-panel-meta">
        <span className="state-pill" data-state={agent.state}>
          <span className="state-dot" />
          {agent.state}
        </span>
        <span className="model-badge">{agent.model}</span>
        <span className="drawer-stat">
          <strong>{(agent.tokensToday ?? 0).toLocaleString()}</strong> tok
        </span>
      </div>

      <div className="agent-panel-now" data-state={agent.state}>
        <span className="agent-panel-now-icon" aria-hidden>{stateGlyph(agent.state)}</span>
        <div className="agent-panel-now-text">
          <span className="agent-panel-now-label">Now</span>
          <span className="agent-panel-now-headline">{summary.headline}</span>
          {summary.sub && <span className="agent-panel-now-sub">{summary.sub}</span>}
        </div>
      </div>

      <nav className="agent-panel-tabs">
        {(["log", "queue", "chat", "controls"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`agent-panel-tab${tab === t ? " is-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      <div className="agent-panel-body">
        {tab === "log" && <LiveLog agentId={selectedAgentId} />}
        {tab === "queue" && <QueuePanel agentId={selectedAgentId} />}
        {tab === "chat" && <ChatPanel agentId={selectedAgentId} />}
        {tab === "controls" && <ControlsRow agentId={selectedAgentId} />}
      </div>
      </>}
    </aside>
  );
}
