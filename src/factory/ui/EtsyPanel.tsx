import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type EtsyPublishRow, type EtsyStatus } from "../../api";
import { useFactoryStore } from "../state/factoryStore";

/**
 * HUD pill for Etsy connectivity. When disconnected, shows a "Connect Etsy"
 * button that kicks off the OAuth flow (Rust opens a local server on :7330,
 * we open the authorize URL in the system browser, and the Rust side emits
 * `etsy_connected` once tokens are persisted). When connected, also surfaces
 * the real-publish toggle, daily cap input, and a recent publishes list with
 * a manual Activate button per draft.
 */
export default function EtsyPanel() {
  const [status, setStatus] = useState<EtsyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [cap, setCap] = useState(3);
  const [capDraft, setCapDraft] = useState("3");
  const [publishes, setPublishes] = useState<EtsyPublishRow[]>([]);
  const [activating, setActivating] = useState<number | null>(null);
  const etsyPublishesRev = useFactoryStore((s) => s.etsyPublishesRev);

  const refresh = useCallback(async () => {
    try {
      const s = await api.etsyStatus();
      setStatus(s);
    } catch (e) {
      console.warn("etsy status load failed", e);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const [en, c] = await Promise.all([
        api.etsyGetEnabled(),
        api.etsyGetListingCap(),
      ]);
      setEnabled(en);
      setCap(c);
      setCapDraft(String(c));
    } catch (e) {
      console.warn("etsy settings load failed", e);
    }
  }, []);

  const refreshPublishes = useCallback(async () => {
    try {
      const rows = await api.etsyListPublishes();
      setPublishes(rows);
    } catch (e) {
      console.warn("etsy publishes load failed", e);
    }
  }, []);

  useEffect(() => {
    refresh();
    let unlistenConnected: UnlistenFn | undefined;
    let unlistenErr: UnlistenFn | undefined;
    (async () => {
      unlistenConnected = await listen("etsy_connected", () => {
        setError(null);
        refresh();
      });
      unlistenErr = await listen<string>("etsy_oauth_error", (evt) => {
        setError(evt.payload || "OAuth failed");
        setBusy(false);
      });
    })();
    return () => {
      unlistenConnected?.();
      unlistenErr?.();
    };
  }, [refresh]);

  // Once connected, load settings + publishes; refresh publishes on bump.
  useEffect(() => {
    if (status?.connected) {
      refreshSettings();
      refreshPublishes();
    }
  }, [status?.connected, refreshSettings, refreshPublishes]);

  useEffect(() => {
    if (status?.connected) refreshPublishes();
  }, [etsyPublishesRev, status?.connected, refreshPublishes]);

  const onConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      const { authorize_url } = await api.etsyStartOAuth();
      await openUrl(authorize_url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    try {
      await api.etsyDisconnect();
      await refresh();
    } catch (e) {
      console.warn("etsy disconnect failed", e);
    }
  };

  const onToggleEnabled = async () => {
    const next = !enabled;
    try {
      await api.etsySetEnabled(next);
      setEnabled(next);
    } catch (e) {
      console.warn("etsy set enabled failed", e);
    }
  };

  const onCapBlur = async () => {
    const n = parseInt(capDraft, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setCapDraft(String(cap));
      return;
    }
    try {
      await api.etsySetListingCap(n);
      setCap(n);
    } catch (e) {
      console.warn("etsy set cap failed", e);
      setCapDraft(String(cap));
    }
  };

  const onActivate = async (localId: number) => {
    setActivating(localId);
    try {
      const r = await api.etsyActivateListing(localId);
      // Optimistic local update; bump from event reducer also refreshes.
      setPublishes((rows) =>
        rows.map((row) =>
          row.local_listing_id === localId
            ? { ...row, state: "active", activated_at: Math.floor(Date.now() / 1000) }
            : row
        )
      );
      if (r.url) {
        await openUrl(r.url);
      }
    } catch (e) {
      console.warn("activate failed", e);
    } finally {
      setActivating(null);
    }
  };

  if (!status) {
    return (
      <div className="etsy-pill" title="Etsy">
        <span className="etsy-pill-label">Etsy</span>
        <span className="etsy-pill-value">…</span>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <button
        className="etsy-pill is-disconnected"
        onClick={onConnect}
        disabled={busy}
        title={error ?? "Connect your Etsy shop"}
      >
        <span className="etsy-dot" />
        <span className="etsy-pill-label">Etsy</span>
        <span className="etsy-pill-value">
          {busy ? "Connecting…" : "Connect"}
        </span>
      </button>
    );
  }

  return (
    <div className="etsy-pill-wrap">
      <button
        type="button"
        className={`etsy-pill is-connected${enabled ? " is-live" : ""}`}
        onClick={() => setShowPanel((v) => !v)}
        title={`Etsy shop ${status.shop_id ?? ""} — click to open controls`}
      >
        <span className="etsy-dot" />
        <span className="etsy-pill-label">Etsy</span>
        <div className="etsy-pill-stack">
          <span className="etsy-pill-value">
            {status.shop_name ?? "Connected"}
          </span>
          {status.shop_id !== null && (
            <span className="etsy-pill-sub">#{status.shop_id}</span>
          )}
        </div>
        {enabled && <span className="etsy-live-badge">LIVE</span>}
      </button>
      {showPanel && (
        <div className="etsy-panel" role="dialog">
          <div className="etsy-panel-row">
            <span className="etsy-panel-label">Real publishing</span>
            <button
              type="button"
              className={`etsy-toggle${enabled ? " is-on" : ""}`}
              onClick={onToggleEnabled}
            >
              {enabled ? "ON" : "OFF"}
            </button>
          </div>
          <div className="etsy-panel-row">
            <span className="etsy-panel-label">Daily cap</span>
            <input
              type="number"
              className="etsy-cap-input"
              value={capDraft}
              min={0}
              max={100}
              onChange={(e) => setCapDraft(e.target.value)}
              onBlur={onCapBlur}
            />
          </div>
          <div className="etsy-panel-list">
            {publishes.length === 0 ? (
              <div className="etsy-panel-empty">no publishes yet</div>
            ) : (
              publishes.slice(0, 8).map((p) => (
                <div key={p.id} className="etsy-publish-row">
                  <span
                    className={`etsy-state-badge state-${p.state}`}
                    title={`Etsy state: ${p.state}`}
                  >
                    {p.state}
                  </span>
                  <span className="etsy-publish-title" title={p.title}>
                    {p.title.length > 36
                      ? p.title.slice(0, 33) + "…"
                      : p.title}
                  </span>
                  {p.url && (
                    <button
                      type="button"
                      className="etsy-publish-link"
                      onClick={() => p.url && openUrl(p.url)}
                      title="Open on Etsy"
                    >
                      ↗
                    </button>
                  )}
                  {p.state === "draft" && (
                    <button
                      type="button"
                      className="etsy-publish-activate"
                      onClick={() => onActivate(p.local_listing_id)}
                      disabled={activating === p.local_listing_id}
                    >
                      {activating === p.local_listing_id ? "…" : "Activate"}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="etsy-panel-footer">
            <button
              type="button"
              className="etsy-action"
              onClick={onDisconnect}
              title="Disconnect Etsy"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
