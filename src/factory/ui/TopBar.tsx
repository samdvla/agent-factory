import { useEffect, useRef, useState } from "react";
import { api, StatusReport } from "../../api";
import { useFactoryStore } from "../state/factoryStore";

export default function TopBar({
  onAlertClick,
  onSettingsClick,
}: {
  onAlertClick: () => void;
  onSettingsClick: () => void;
}) {
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [realEtsyEnabled, setRealEtsyEnabled] = useState(false);
  const realEtsyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sandbox = useFactoryStore((s) => s.sandbox);
  const setSandbox = useFactoryStore((s) => s.setSandbox);
  // Revenue + Net pill is LIFETIME, not daily. Every dollar burned
  // (Claude + Tripo + Meshy + Gemini + Etsy listing fees) and every
  // dollar earned across every marketplace (Etsy + future Cults3D /
  // Sketchfab / Gumroad / MMF / Pinterest) is summed into these two
  // numbers via the revenue_ledger + budget_ledger rollups in
  // cmd_today_stats. Daily values are still tracked for cap enforcement
  // but they're not what the user sees here.
  const budgetUsd = useFactoryStore((s) => s.budgetLifetimeUsd);
  const revenueUsd = useFactoryStore((s) => s.revenueLifetimeUsd);
  const setLifetimeTotals = useFactoryStore((s) => s.setLifetimeTotals);
  const alerts = useFactoryStore((s) => s.alerts);
  const setAllStop = useFactoryStore((s) => s.setAllStop);
  const setSupervisorRunning = useFactoryStore((s) => s.setSupervisorRunning);

  useEffect(() => {
    const refresh = async () => {
      const s = await api.status();
      setStatus(s);
      setSupervisorRunning(!!s?.running);
    };
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [setSupervisorRunning]);

  // Refresh the lifetime Net pill on a slower cadence (5s). Cheap query
  // — single SUM over two indexed tables — but no point hitting it
  // every 2s like the supervisor status poll.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const stats = await api.todayStats();
        if (cancelled) return;
        setLifetimeTotals(stats.revenue_lifetime_usd, stats.budget_lifetime_usd);
      } catch {
        // Swallow — stale values are fine until the next tick.
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [setLifetimeTotals]);

  // Poll real_etsy_enabled every 5s so the mode badge stays in sync with
  // any changes made in Settings without requiring a full reload.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const enabled = await api.etsyGetEnabled();
        if (!cancelled) setRealEtsyEnabled(enabled);
      } catch {}
    };
    refresh();
    realEtsyIntervalRef.current = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      if (realEtsyIntervalRef.current !== null) {
        clearInterval(realEtsyIntervalRef.current);
      }
    };
  }, []);

  // Derive mode badge properties.
  const modeKey: "live" | "dry-run" | "sandbox" = sandbox
    ? "sandbox"
    : realEtsyEnabled
      ? "live"
      : "dry-run";
  const modeText = modeKey === "live" ? "LIVE" : modeKey === "dry-run" ? "DRY-RUN" : "SANDBOX";
  const modeTooltip =
    modeKey === "live"
      ? "LIVE: real Etsy publishing enabled"
      : modeKey === "dry-run"
        ? "DRY-RUN: Live UI mode but real Etsy publishing is off"
        : "SANDBOX: synthetic floor activity, no live publishing";

  const netUsd = revenueUsd - budgetUsd;

  const onStartStop = async () => {
    if (status?.running) {
      // Disable autonomous loops BEFORE stopping the supervisor so no new
      // jobs sneak in during shutdown.
      await api.setSecret("autonomous_loops_enabled", "false").catch(() => {});
      await api.stop();
      setAllStop(true);
    } else {
      // START === "run the factory" — flip on autonomous loops so the boot
      // orchestrator fires once, and the continuous-cycle hook keeps queueing
      // the next orchestrator after each CFO close. Without this the workers
      // would spawn and immediately go idle, which reads as "nothing works".
      await api.setSecret("autonomous_loops_enabled", "true").catch(() => {});
      await api.start();
      setAllStop(false);
    }
    const after = await api.status();
    setStatus(after);
    setSupervisorRunning(!!after?.running);
  };

  return (
    <>
      <div className="float-row float-row-left">
      <div className="float-brand" aria-label="agent-factory" title="agent-factory">
        <div className="brand-mark" aria-hidden="true" />
        <span className="float-brand-text">AF</span>
      </div>

      <div className="mode-cluster">
        <button
          type="button"
          className={`mode-toggle is-${modeKey}`}
          onClick={() => setSandbox(!sandbox)}
          title={modeTooltip}
        >
          <span className="mode-toggle-dot" />
          <span className="mode-toggle-label">{modeText}</span>
        </button>
      </div>
      </div>

      <div className="float-row float-row-center">
      <div className={`topbar-pill topbar-rev-net${budgetUsd > 0 ? (netUsd >= 0 ? " is-gain" : " is-loss") : ""}`}>
        <span className="topbar-pill-label">Revenue</span>
        <span className="topbar-pill-value">${revenueUsd.toFixed(2)}</span>
        <span className="topbar-rev-sep">·</span>
        <span className="topbar-pill-label">Net</span>
        <span className="topbar-pill-value topbar-net-value">
          {budgetUsd > 0
            ? `${netUsd >= 0 ? "+" : ""}$${netUsd.toFixed(2)}`
            : "—"}
        </span>
      </div>
      </div>

      <div className="float-row float-row-right">
      <button
        className="topbar-icon"
        onClick={onSettingsClick}
        title="Settings"
        aria-label="Open settings"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
        className={`all-stop ${status?.running ? "is-stop" : "is-start"}`}
        onClick={onStartStop}
        title={status?.running ? "Halt all agents" : "Start supervisor"}
      >
        <span className="stop-glyph" />
        {status?.running ? "All Stop" : "Start"}
      </button>
      </div>
    </>
  );
}
