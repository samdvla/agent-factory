import { useFactoryStore } from "../state/factoryStore";

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export default function AlertTray({ open, onClose }: { open: boolean; onClose: () => void }) {
  const alerts = useFactoryStore((s) => s.alerts);
  const dismissAlert = useFactoryStore((s) => s.dismissAlert);
  const selectAgent = useFactoryStore((s) => s.selectAgent);

  return (
    <div className={`alert-tray${open ? " is-open" : ""}`}>
      <div className="alert-tray-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>ALERTS</span>
        <button
          style={{ background: "none", border: "none", color: "var(--ink-2)", cursor: "pointer", fontSize: 10, letterSpacing: "0.08em" }}
          onClick={onClose}
        >
          CLOSE
        </button>
      </div>
      {alerts.length === 0 ? (
        <div className="empty-state" style={{ padding: "14px", textAlign: "center" }}>
          No alerts.
        </div>
      ) : (
        alerts.map((a, i) => (
          <div
            key={i}
            className="alert-row"
            onClick={() => {
              if (a.agent) selectAgent(a.agent);
              dismissAlert(i);
              onClose();
            }}
          >
            <div className={`alert-icon ${a.kind === "err" ? "bad" : "warn"}`}>
              {a.kind === "err" ? "!" : "⚠"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="a-title">{a.title}</div>
              <div className="a-sub">{a.sub}</div>
              <div className="a-time">{timeAgo(a.ts)}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
