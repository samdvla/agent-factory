import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type EtsyPublishRow, type EtsyStatus } from "../../api";
import { useFactoryStore } from "../state/factoryStore";
import ListingReviewModal from "./ListingReviewModal";

/**
 * HUD pill for Etsy connectivity. When disconnected, shows a "Connect Etsy"
 * button that kicks off the OAuth flow (Rust opens a local server on :7330,
 * we open the authorize URL in the system browser, and the Rust side emits
 * `etsy_connected` once tokens are persisted). When connected, also surfaces
 * the real-publish toggle, daily cap input, and a recent publishes list with
 * a manual Activate button per draft.
 */
export default function EtsyPanel({ alwaysOpen = false }: { alwaysOpen?: boolean }) {
  const [status, setStatus] = useState<EtsyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const isPanelOpen = alwaysOpen || showPanel;
  const [enabled, setEnabled] = useState(false);
  const [cap, setCap] = useState(3);
  const [capDraft, setCapDraft] = useState("3");
  const [publishes, setPublishes] = useState<EtsyPublishRow[]>([]);
  const [activating, setActivating] = useState<number | null>(null);
  const [showReceipts, setShowReceipts] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [reviewing, setReviewing] = useState<EtsyPublishRow | null>(null);
  // Hide pre-pivot drafts (and other long-stale rows) by default — the user
  // got tired of seeing the ADHD-planner 2D drafts in the panel. The toggle
  // flips on demand for cleanup / archaeology. 24h is a sensible default
  // since the orchestrator fires every ~20s when autonomous loops are on.
  const [recentOnly, setRecentOnly] = useState(true);
  const RECENT_HOURS = 24;
  const [smokeRunning, setSmokeRunning] = useState(false);
  const [smokeSteps, setSmokeSteps] = useState({
    research: false, asset: false, listing: false, draft: false,
  });
  const [smokeListingId, setSmokeListingId] = useState<number | null>(null);
  const [smokeDone, setSmokeDone] = useState(false);
  const [smokeError, setSmokeError] = useState<string | null>(null);
  const etsyPublishesRev = useFactoryStore((s) => s.etsyPublishesRev);
  const recentReceipts = useFactoryStore((s) => s.etsyRecentReceipts);
  const recentMessages = useFactoryStore((s) => s.etsyRecentMessages);
  const etsyKilled = useFactoryStore((s) => s.etsyKilled);

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

  useEffect(() => {
    let unlisten: import("@tauri-apps/api/event").UnlistenFn | undefined;
    listen<Record<string, unknown>>("supervisor:event", (e) => {
      const evt = e.payload;
      switch (evt.kind) {
        case "job_completed":
          if (evt.role === "research") {
            setSmokeSteps((s) => ({ ...s, research: true }));
          } else if (evt.role === "listing") {
            setSmokeSteps((s) => ({ ...s, listing: true }));
          }
          break;
        case "asset_rasterized":
          setSmokeSteps((s) => ({ ...s, asset: true }));
          break;
        case "etsy_listing_published":
          setSmokeSteps((s) => ({ ...s, draft: true }));
          if (typeof evt.local_listing_id === "number") {
            setSmokeListingId(evt.local_listing_id as number);
          }
          break;
        case "smoke_test_cycle_complete":
          setSmokeRunning(false);
          setSmokeDone(true);
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const startSmoke = async () => {
    setSmokeError(null);
    setSmokeRunning(true);
    setSmokeSteps({ research: false, asset: false, listing: false, draft: false });
    setSmokeListingId(null);
    setSmokeDone(false);
    try {
      await api.startSmokeTest();
    } catch (e: any) {
      setSmokeError(e?.message || String(e));
      setSmokeRunning(false);
    }
  };

  const resumeSmoke = async () => {
    try {
      await api.resumeFromSmokeTest();
    } finally {
      setSmokeRunning(false);
      setSmokeDone(false);
    }
  };

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

  const onKill = async () => {
    const confirmed = window.confirm(
      "Stop all Etsy publishing? You can re-enable in settings."
    );
    if (!confirmed) return;
    try {
      await api.etsyKillSwitch();
      setEnabled(false);
    } catch (e) {
      console.warn("etsy kill switch failed", e);
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

  const onReviewClick = (row: EtsyPublishRow) => {
    setReviewing(row);
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
      {isPanelOpen && (
        <div className="etsy-panel" role="dialog">
          {etsyKilled && (
            <div className="etsy-killed-banner">
              KILL SWITCH active — real publishing halted
            </div>
          )}
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
          <div className="etsy-panel-row">
            <button
              type="button"
              className="etsy-kill-button"
              onClick={onKill}
              title="Halt all real Etsy publishing immediately"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
              </svg>
              KILL
            </button>
          </div>
          <div className="etsy-panel-section">
            <button
              type="button"
              className="etsy-section-toggle"
              onClick={() => setShowReceipts((v) => !v)}
            >
              <span className="etsy-panel-label">
                Last 5 receipts
                {recentReceipts.length > 0 && ` (${recentReceipts.length})`}
              </span>
              <svg
                className={`etsy-section-caret${showReceipts ? " is-open" : ""}`}
                width="10" height="10" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
            {showReceipts && (
              <div className="etsy-mini-list">
                {recentReceipts.length === 0 ? (
                  <div className="etsy-panel-empty">no receipts yet</div>
                ) : (
                  recentReceipts.map((r) => (
                    <div key={r.receipt_id} className="etsy-mini-row">
                      <span className="etsy-mini-id">#{r.receipt_id}</span>
                      <span className="etsy-mini-meta">
                        {r.txns} txn{r.txns === 1 ? "" : "s"}
                      </span>
                      <span className="etsy-mini-rev">
                        ${r.revenue_usd.toFixed(2)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="etsy-panel-section">
            <button
              type="button"
              className="etsy-section-toggle"
              onClick={() => setShowMessages((v) => !v)}
            >
              <span className="etsy-panel-label">
                Last 5 buyer DMs
                {recentMessages.length > 0 && ` (${recentMessages.length})`}
              </span>
              <svg
                className={`etsy-section-caret${showMessages ? " is-open" : ""}`}
                width="10" height="10" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
            {showMessages && (
              <div className="etsy-mini-list">
                {recentMessages.length === 0 ? (
                  <div className="etsy-panel-empty">no DMs yet</div>
                ) : (
                  recentMessages.map((m, i) => (
                    <div key={`${m.conversation_id}-${i}`} className="etsy-mini-row">
                      <span className="etsy-mini-id">#{m.conversation_id}</span>
                      <span className="etsy-mini-snippet" title={m.snippet}>
                        {m.snippet}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          {(() => {
            const nowSec = Math.floor(Date.now() / 1000);
            const cutoff = nowSec - RECENT_HOURS * 3600;
            const visible = recentOnly
              ? publishes.filter((p) => (p.published_at ?? 0) >= cutoff)
              : publishes;
            const olderCount = publishes.length - visible.length;
            return (
              <>
                <div
                  className="etsy-panel-row"
                  style={{ paddingTop: 2, paddingBottom: 2 }}
                >
                  <span className="etsy-panel-label">
                    Drafts
                    {recentOnly
                      ? ` (last ${RECENT_HOURS}h)`
                      : ` (all ${publishes.length})`}
                  </span>
                  <button
                    type="button"
                    className={`etsy-toggle${recentOnly ? " is-on" : ""}`}
                    onClick={() => setRecentOnly((v) => !v)}
                    title={
                      recentOnly
                        ? `Show all ${publishes.length} including older drafts`
                        : `Hide drafts older than ${RECENT_HOURS}h`
                    }
                  >
                    {recentOnly ? "RECENT" : "ALL"}
                  </button>
                </div>
                {recentOnly && olderCount > 0 && (
                  <div
                    className="etsy-panel-empty"
                    style={{ fontSize: 10, padding: "2px 6px" }}
                  >
                    {olderCount} older draft{olderCount === 1 ? "" : "s"} hidden
                  </div>
                )}
                <div className="etsy-panel-list">
                  {visible.length === 0 ? (
                    <div className="etsy-panel-empty">
                      {recentOnly && publishes.length > 0
                        ? `no drafts in the last ${RECENT_HOURS}h`
                        : "no publishes yet"}
                    </div>
                  ) : (
                    visible.slice(0, 8).map((p) => (
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
                      onClick={() => onReviewClick(p)}
                      disabled={activating === p.local_listing_id}
                      title="Review listing before activating"
                    >
                      {activating === p.local_listing_id ? "…" : "Review"}
                    </button>
                  )}
                </div>
              ))
            )}
                </div>
              </>
            );
          })()}
          <div className="smoke-test">
            <button
              className="modal-btn approve"
              disabled={smokeRunning || !status.connected}
              onClick={startSmoke}
            >
              {smokeRunning ? "Smoke test running…" : "Run smoke-test cycle"}
            </button>
            {smokeRunning && (
              <ul className="smoke-steps">
                <li className={smokeSteps.research ? "ok" : ""}>Research</li>
                <li className={smokeSteps.asset    ? "ok" : ""}>Asset</li>
                <li className={smokeSteps.listing  ? "ok" : ""}>Listing</li>
                <li className={smokeSteps.draft    ? "ok" : ""}>Draft published</li>
              </ul>
            )}
            {smokeDone && (
              <>
                <div className="ck ok">
                  Draft posted{smokeListingId ? ` (listing id ${smokeListingId})` : ""}. Review on Etsy, then resume.
                </div>
                <button className="modal-btn" onClick={resumeSmoke}>Resume loops</button>
              </>
            )}
            {smokeError && <div className="ck err">{smokeError}</div>}
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
      {reviewing && (
        <ListingReviewModal
          localListingId={reviewing.local_listing_id}
          fallbackTitle={reviewing.title}
          onClose={() => setReviewing(null)}
          onActivate={async (id) => {
            await onActivate(id);
          }}
        />
      )}
    </div>
  );
}
