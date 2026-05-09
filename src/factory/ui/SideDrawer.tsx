import { useState } from "react";
import { useFactoryStore } from "../state/factoryStore";
import ChatPanel from "./ChatPanel";
import LiveLog from "./LiveLog";
import QueuePanel from "./QueuePanel";
import ControlsRow from "./ControlsRow";

type Tab = "chat" | "log" | "queue" | "controls";

export default function SideDrawer() {
  const drawerOpen = useFactoryStore((s) => s.drawerOpen);
  const selectedAgentId = useFactoryStore((s) => s.selectedAgent);
  const agent = useFactoryStore((s) =>
    selectedAgentId ? s.agents[selectedAgentId] : null
  );
  const [tab, setTab] = useState<Tab>("log");

  const close = () => useFactoryStore.getState().selectAgent(null);

  const role = useFactoryStore((s) => selectedAgentId ? s.roles[selectedAgentId] : undefined);

  if (!drawerOpen || !selectedAgentId || !agent) return null;

  return (
    <>
      <div className="drawer-scrim is-open" onClick={close} />
      <aside
        className="drawer is-open"
        style={
          { "--role-color": role?.hex ?? "#5fd4f0" } as React.CSSProperties
        }
      >
        <header className="drawer-head">
          <div
            className="drawer-portrait"
            style={{ background: role?.hex ?? "#666" }}
          >
            {role?.portrait ?? "?"}
          </div>
          <div className="drawer-head-info">
            <div className="drawer-role">{role?.title ?? selectedAgentId}</div>
            <div className="drawer-name">{role?.name ?? selectedAgentId}</div>
            <div className="drawer-meta">
              <span
                className="state-pill"
                data-state={agent.state}
              >
                <span className="state-dot" />
                {agent.state}
              </span>
              <span className="model-badge">{agent.model}</span>
              <span className="drawer-stat">
                <strong>{agent.tokensToday.toLocaleString()}</strong> tok today
              </span>
            </div>
          </div>
          <button className="drawer-close" onClick={close} aria-label="Close drawer">
            ×
          </button>
        </header>

        <nav className="drawer-tabs">
          {(["chat", "log", "queue", "controls"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`drawer-tab${tab === t ? " is-active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="drawer-body">
          {tab === "chat" && <ChatPanel agentId={selectedAgentId} />}
          {tab === "log" && <LiveLog agentId={selectedAgentId} />}
          {tab === "queue" && <QueuePanel agentId={selectedAgentId} />}
          {tab === "controls" && <ControlsRow agentId={selectedAgentId} />}
        </div>
      </aside>
    </>
  );
}
