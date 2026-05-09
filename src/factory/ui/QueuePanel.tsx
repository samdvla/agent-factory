import { useFactoryStore } from "../state/factoryStore";

interface Props {
  agentId: string;
}

export default function QueuePanel({ agentId }: Props) {
  const agent = useFactoryStore((s) => s.agents[agentId]);

  if (!agent) {
    return (
      <div className="drawer-section">
        <div className="drawer-section-head">Queue</div>
        <div className="empty-state" style={{ padding: "14px 20px" }}>
          unknown agent
        </div>
      </div>
    );
  }

  return (
    <div className="drawer-section">
      <div className="drawer-section-head">
        <span>Queue</span>
        {agent.currentJobId !== null && (
          <span className="count">1</span>
        )}
      </div>
      <div className="queue-list">
        {agent.currentJobId !== null ? (
          <div className="queue-item" data-status="running">
            <span className="queue-status" />
            <span className="queue-title">
              job #{agent.currentJobId}
              {agent.task ? ` — ${agent.task}` : ""}
            </span>
            <span className="queue-time">now</span>
            <span className="queue-cost" />
          </div>
        ) : (
          <div className="empty-state" style={{ padding: "14px 20px" }}>
            no active job
          </div>
        )}
        <div
          className="empty-state"
          style={{ padding: "10px 20px", fontSize: 11 }}
        >
          Full queue listing requires <code>cmd_list_jobs</code> (P2).
        </div>
      </div>
    </div>
  );
}
