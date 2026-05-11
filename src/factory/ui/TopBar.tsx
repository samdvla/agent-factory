import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, StatusReport, EtsyStatus } from "../../api";
import { useFactoryStore } from "../state/factoryStore";

export default function TopBar({
  onAlertClick,
  onSettingsClick,
}: {
  onAlertClick: () => void;
  onSettingsClick: () => void;
}) {
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [etsy, setEtsy] = useState<EtsyStatus | null>(null);
  const [etsyBusy, setEtsyBusy] = useState(false);
  const [etsyError, setEtsyError] = useState<string | null>(null);
  const [etsyDetailsOpen, setEtsyDetailsOpen] = useState(false);
  const [etsyAuthUrl, setEtsyAuthUrl] = useState<string | null>(null);
  const [etsyCopied, setEtsyCopied] = useState(false);
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
    const refresh = async () => {
      try {
        const s = await api.etsyStatus();
        if (cancelled) return;
        setEtsy(s);
        if (s.connected) {
          setEtsyError(null);
        } else {
          const err = await api.etsyLastError().catch(() => null);
          if (!cancelled) setEtsyError(err && err.length > 0 ? err : null);
        }
      } catch {}
    };
    refresh();
    const id = setInterval(refresh, 5000);
    let unC: UnlistenFn | undefined;
    let unE: UnlistenFn | undefined;
    (async () => {
      unC = await listen("etsy_connected", () => {
        setEtsyError(null);
        setEtsyAuthUrl(null);
        setEtsyDetailsOpen(false);
        refresh();
      });
      unE = await listen<string>("etsy_oauth_error", (evt) => {
        setEtsyError(evt.payload || "OAuth failed");
        setEtsyBusy(false);
        refresh();
      });
    })();
    return () => { cancelled = true; clearInterval(id); unC?.(); unE?.(); };
  }, []);

  const onEtsyClick = async () => {
    // If there's a stored error and not connected, expand the details popover.
    if (!etsy?.connected && etsyError) {
      setEtsyDetailsOpen((v) => !v);
      return;
    }
    if (etsy?.connected && etsy.shop_name) {
      await openUrl(`https://www.etsy.com/shop/${encodeURIComponent(etsy.shop_name)}`);
      return;
    }
    await startEtsyOAuth();
  };

  const startEtsyOAuth = async () => {
    if (etsyBusy) return;
    setEtsyBusy(true);
    setEtsyError(null);
    setEtsyCopied(false);
    try {
      await api.etsyClearLastError().catch(() => {});
      const { authorize_url } = await api.etsyStartOAuth();
      setEtsyAuthUrl(authorize_url);
      setEtsyDetailsOpen(true);
      await openUrl(authorize_url);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setEtsyError(msg);
      setEtsyDetailsOpen(true);
    } finally {
      setEtsyBusy(false);
    }
  };

  const copyAuthUrl = async () => {
    if (!etsyAuthUrl) return;
    try {
      await navigator.clipboard.writeText(etsyAuthUrl);
      setEtsyCopied(true);
      setTimeout(() => setEtsyCopied(false), 1800);
    } catch {}
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
        <svg
          className="caret"
          width="10" height="10" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
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

      <div className="etsy-status-wrap">
        <button
          type="button"
          className={`etsy-status ${etsy?.connected ? "is-connected" : etsyError ? "is-error" : "is-disconnected"}${etsyBusy ? " is-busy" : ""}`}
          onClick={onEtsyClick}
          title={
            etsy?.connected
              ? `Connected to ${etsy.shop_name ?? "Etsy"} — click to open shop`
              : etsyError
                ? "OAuth error — click for details"
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
                  : etsyError
                    ? "Error — click for details"
                    : "Not connected"}
            </span>
          </span>
        </button>
        {etsyDetailsOpen && !etsy?.connected && (
          <div className="etsy-status-popover" role="dialog">
            <div className="etsy-popover-header">
              <span>{etsyAuthUrl ? "Complete Etsy authorization" : "Last OAuth error"}</span>
              <button
                type="button"
                className="etsy-popover-close"
                onClick={() => setEtsyDetailsOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {etsyAuthUrl && (
              <>
                <p className="etsy-popover-hint">
                  Authorization page opened in your browser. If you didn't see a tab, copy or open the URL below.
                </p>
                <div className="etsy-popover-url">
                  <span className="etsy-popover-url-text" title={etsyAuthUrl}>{etsyAuthUrl}</span>
                </div>
                <div className="etsy-popover-actions">
                  <button type="button" className="modal-btn" onClick={copyAuthUrl}>
                    {etsyCopied ? "Copied" : "Copy URL"}
                  </button>
                  <button
                    type="button"
                    className="modal-btn approve"
                    onClick={() => etsyAuthUrl && openUrl(etsyAuthUrl)}
                  >
                    Open in browser
                  </button>
                </div>
                <p className="etsy-popover-hint" style={{ marginTop: 10 }}>
                  After you click <strong>Allow</strong> on Etsy, you should land on{" "}
                  <code>http://localhost:7330/callback</code>. If you land somewhere else, your Etsy app's Callback URL is misconfigured —
                  it must be exactly that, no <code>https</code>, no trailing slash.
                </p>
              </>
            )}

            {etsyError && (
              <>
                <div className="etsy-popover-section-label">Last error</div>
                <pre className="etsy-popover-body">{etsyError}</pre>
                <div className="etsy-popover-actions">
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={async () => {
                      await api.etsyClearLastError().catch(() => {});
                      setEtsyError(null);
                      setEtsyAuthUrl(null);
                      setEtsyDetailsOpen(false);
                    }}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    className="modal-btn approve"
                    onClick={startEtsyOAuth}
                    disabled={etsyBusy}
                  >
                    {etsyBusy ? "Retrying…" : "Retry"}
                  </button>
                </div>
              </>
            )}

            {!etsyAuthUrl && !etsyError && (
              <p className="etsy-popover-hint">No active OAuth session.</p>
            )}
          </div>
        )}
      </div>

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
