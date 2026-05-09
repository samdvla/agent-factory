import { useEffect, useState } from "react";
import { api, StatusReport } from "../../api";
import { useFactoryStore } from "../state/factoryStore";

export default function TopBar({ onAlertClick }: { onAlertClick: () => void }) {
  const [status, setStatus] = useState<StatusReport | null>(null);
  const sandbox = useFactoryStore((s) => s.sandbox);
  const setSandbox = useFactoryStore((s) => s.setSandbox);
  const budgetUsd = useFactoryStore((s) => s.budgetTodayUsd);
  const budgetCap = useFactoryStore((s) => s.budgetCapUsd);
  const revenueUsd = useFactoryStore((s) => s.revenueTodayUsd);
  const alerts = useFactoryStore((s) => s.alerts);
  const setAllStop = useFactoryStore((s) => s.setAllStop);

  useEffect(() => {
    const refresh = async () => setStatus(await api.status());
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, []);

  const netUsd = revenueUsd - budgetUsd;
  const pct = Math.min(100, (budgetUsd / budgetCap) * 100);
  const fillClass =
    pct > 90
      ? "budget-bar-fill bad"
      : pct > 70
        ? "budget-bar-fill warn"
        : "budget-bar-fill";

  const onStartStop = async () => {
    if (status?.running) {
      await api.stop();
      setAllStop(true);
    } else {
      await api.start();
      setAllStop(false);
    }
    setStatus(await api.status());
  };

  const onSendTest = async () => {
    if (status?.running) await api.enqueue("hello", { msg: "world" });
  };

  return (
    <header className="topbar">
      {/* Left: brand + project select + guardian */}
      <div className="brand">
        <div className="brand-mark" />
        <div>
          <div className="brand-name">agent-factory</div>
          <div className="brand-sub">multi-agent terminal</div>
        </div>
      </div>

      <div
        className="project-select"
        onClick={() => setSandbox(!sandbox)}
        title="Sandbox mode (toggle)"
      >
        <span className="dot" />
        <span className="name">{sandbox ? "Sandbox" : "Live"}</span>
        <span className="sub">mode</span>
        <span className="caret">▾</span>
      </div>

      <div
        className="guardian"
        title={`Guardian — supervisor watchdog${status?.running ? " · OK" : " · Idle"}`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      </div>

      {/* Center: budget bar */}
      <div className="topbar-spacer" />

      <div className="budget">
        <span className="budget-label">Daily Budget</span>
        <div className="budget-bar">
          <div className={fillClass} style={{ width: `${pct}%` }} />
        </div>
        <div className="budget-numbers">
          <span className="spent">${budgetUsd.toFixed(2)}</span>
          <span className="cap"> / ${budgetCap.toFixed(2)}</span>
        </div>
      </div>

      <div className="topbar-pill">
        <span className="topbar-pill-label">Revenue</span>
        <span className="topbar-pill-value">${revenueUsd.toFixed(2)}</span>
      </div>

      <div className={`topbar-pill topbar-net${budgetUsd > 0 ? (netUsd >= 0 ? " is-gain" : " is-loss") : ""}`}>
        <span className="topbar-pill-label">Net</span>
        <span className="topbar-pill-value">
          {budgetUsd > 0
            ? `${netUsd >= 0 ? "+" : ""}$${netUsd.toFixed(2)}`
            : "—"}
        </span>
      </div>

      <div className="topbar-spacer" />

      {/* Right: test job button + alerts + all-stop */}
      <button
        className="topbar-icon"
        onClick={onSendTest}
        disabled={!status?.running}
        title="Send test job to hello agent"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <button className="alert-pill" onClick={onAlertClick}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 01-3.4 0" />
        </svg>
        <span>Alerts</span>
        {alerts.length > 0 && <span className="badge">{alerts.length}</span>}
      </button>

      <button
        className="all-stop"
        onClick={onStartStop}
        title={status?.running ? "Halt all agents" : "Start supervisor"}
      >
        <span className="stop-glyph" />
        {status?.running ? "All Stop" : "Start"}
      </button>
    </header>
  );
}
