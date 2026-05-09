import { useFactoryStore } from "../state/factoryStore";
import { SUPERVISOR_ROLE_MAP } from "../state/fixtures";

interface Props {
  agentId: string;
}

export default function LiveLog({ agentId }: Props) {
  const ticker = useFactoryStore((s) => s.ticker);

  // Build a reverse map: supervisor source keys that map to this agentId
  const supervisorSources = Object.entries(SUPERVISOR_ROLE_MAP)
    .filter(([, v]) => v === agentId)
    .map(([k]) => k);

  const lines = ticker.filter(
    (t) => t.source === agentId || supervisorSources.includes(t.source)
  );

  return (
    <div className="drawer-section" style={{ flex: 1 }}>
      <div className="drawer-section-head">
        <span>Live Log</span>
        {lines.length > 0 && <span className="count">{lines.length}</span>}
      </div>
      <div className="log-list">
        {lines.length === 0 ? (
          <div className="empty-state" style={{ padding: "14px 20px" }}>
            no events yet
          </div>
        ) : (
          lines.map((t, i) => (
            <div key={i} className="log-line is-event">
              <span className="l-ts">
                {new Date(t.ts).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span className="l-tag">{t.source}</span>
              <span className="l-msg">{t.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
