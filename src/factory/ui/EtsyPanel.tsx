import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type EtsyStatus } from "../../api";

/**
 * HUD pill for Etsy connectivity. When disconnected, shows a "Connect Etsy"
 * button that kicks off the OAuth flow (Rust opens a local server on :7330,
 * we open the authorize URL in the system browser, and the Rust side emits
 * `etsy_connected` once tokens are persisted). When connected, shows the
 * shop name + a disconnect action.
 */
export default function EtsyPanel() {
  const [status, setStatus] = useState<EtsyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.etsyStatus();
      setStatus(s);
    } catch (e) {
      // Keep the pill rendered even if the call fails (e.g. dev without backend)
      console.warn("etsy status load failed", e);
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
    <div
      className="etsy-pill is-connected"
      title={`Etsy shop ${status.shop_id ?? ""}`}
    >
      <span className="etsy-dot" />
      <span className="etsy-pill-label">Etsy</span>
      <div className="etsy-pill-stack">
        <span className="etsy-pill-value">{status.shop_name ?? "Connected"}</span>
        {status.shop_id !== null && (
          <span className="etsy-pill-sub">#{status.shop_id}</span>
        )}
      </div>
      <button
        className="etsy-action"
        onClick={onDisconnect}
        title="Disconnect Etsy"
      >
        Disconnect
      </button>
    </div>
  );
}
