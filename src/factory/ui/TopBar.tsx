import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, StatusReport, EtsyStatus } from "../../api";
import { useFactoryStore } from "../state/factoryStore";

export default function TopBar({ onAlertClick }: { onAlertClick: () => void }) {
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [etsy, setEtsy] = useState<EtsyStatus | null>(null);
  const [etsyBusy, setEtsyBusy] = useState(false);
  const sandbox = useFactoryStore((s) => s.sandbox);
  const setSandbox = useFactoryStore((s) => s.setSandbox);
  const budgetUsd = useFactoryStore((s) => s.budgetTodayUsd);
  const revenueUsd = useFactoryStore((s) => s.revenueTodayUsd);
  const alerts = useFactoryStore((s) => s.alerts);
  const setAllStop = useFactoryStore((s) => s.setAllStop);

  useEffect(() => {
    const refresh = async () => setStatus(await api.status());
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      api.etsyStatus().then((s) => { if (!cancelled) setEtsy(s); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 5000);
    let unC: UnlistenFn | undefined;
    let unE: UnlistenFn | undefined;
    (async () => {
      unC = await listen("etsy_connected", () => refresh());
      unE = await listen("etsy_oauth_error", () => refresh());
    })();
    return () => { cancelled = true; clearInterval(id); unC?.(); unE?.(); };
  }, []);

  const onEtsyClick = async () => {
    if (etsy?.connected && etsy.shop_name) {
      await openUrl(`https://www.etsy.com/shop/${encodeURIComponent(etsy.shop_name)}`);
      return;
    }
    if (etsyBusy) return;
    setEtsyBusy(true);
    try {
      const { authorize_url } = await api.etsyStartOAuth();
      await openUrl(authorize_url);
    } catch {
      // error surfaces via etsy_oauth_error event listener
    } finally {
      setEtsyBusy(false);
    }
  };

  const netUsd = revenueUsd - budgetUsd;

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

      <button
        type="button"
        className={`project-select mode-toggle ${sandbox ? "is-sandbox" : "is-live"}`}
        onClick={() => setSandbox(!sandbox)}
        title={sandbox ? "Sandbox mode — click to switch to Live" : "Live mode — click to switch to Sandbox"}
      >
        <span className="dot" />
        <span className="name">{sandbox ? "Sandbox" : "Live"}</span>
        <span className="sub">mode</span>
        <span className="caret">▾</span>
      </button>

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

      <button
        type="button"
        className={`etsy-status ${etsy?.connected ? "is-connected" : "is-disconnected"}${etsyBusy ? " is-busy" : ""}`}
        onClick={onEtsyClick}
        title={
          etsy?.connected
            ? `Connected to ${etsy.shop_name ?? "Etsy"} — click to open shop`
            : "Etsy not connected — click to start OAuth"
        }
      >
        <span className="etsy-status-dot" />
        <span className="etsy-status-text">
          <span className="etsy-status-label">Etsy</span>
          <span className="etsy-status-sub">
            {etsyBusy
              ? "Opening browser…"
              : etsy?.connected
                ? (etsy.shop_name ?? "Connected")
                : "Not connected"}
          </span>
        </span>
      </button>

      <div className="topbar-spacer" />

      {/* Combined Revenue / Net pill */}
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
