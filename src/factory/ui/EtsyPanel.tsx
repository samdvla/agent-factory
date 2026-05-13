import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type EtsyPublishRow, type EtsyStatus } from "../../api";
import { useFactoryStore } from "../state/factoryStore";
import ListingReviewModal from "./ListingReviewModal";

/**
 * Rail-mounted Etsy panel. Surfaces live state (connection, recent receipts,
 * buyer DMs) and the publish lists segmented by lifecycle stage.
 *
 * Settings/safety controls (real-publishing toggle, daily cap, kill switch,
 * smoke-test, disconnect) live in Settings → Etsy. Keep them off the rail so
 * this stays focused on review work.
 */
type ListTab = "drafts" | "queue" | "active" | "rejected";

const TAB_DEFS: { id: ListTab; label: string; emptyMsg: string }[] = [
  // Single-syllable verb-style labels so all 4 fit the narrow rail column
  // even when a 2-digit count badge is showing alongside.
  { id: "drafts",   label: "Draft",   emptyMsg: "No drafts yet" },
  { id: "queue",    label: "Queue",   emptyMsg: "Nothing queued for regeneration" },
  { id: "active",   label: "Active",  emptyMsg: "No active listings yet" },
  { id: "rejected", label: "Reject",  emptyMsg: "Nothing rejected" },
];

function filterByTab(rows: EtsyPublishRow[], tab: ListTab): EtsyPublishRow[] {
  switch (tab) {
    case "drafts":   return rows.filter((p) => p.state === "draft");
    case "queue":    return rows.filter((p) => p.state === "queued");
    case "active":   return rows.filter((p) => p.state === "active");
    case "rejected": return rows.filter((p) => p.state === "rejected");
  }
}

export default function EtsyPanel({ alwaysOpen: _alwaysOpen = false }: { alwaysOpen?: boolean }) {
  const [status, setStatus] = useState<EtsyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishes, setPublishes] = useState<EtsyPublishRow[]>([]);
  const [activating, setActivating] = useState<number | null>(null);
  const [showReceipts, setShowReceipts] = useState(false);
  const [reviewing, setReviewing] = useState<EtsyPublishRow | null>(null);
  const [tab, setTab] = useState<ListTab>("drafts");
  const etsyPublishesRev = useFactoryStore((s) => s.etsyPublishesRev);
  const recentReceipts = useFactoryStore((s) => s.etsyRecentReceipts);
  const etsyKilled = useFactoryStore((s) => s.etsyKilled);

  const refresh = useCallback(async () => {
    try {
      const s = await api.etsyStatus();
      setStatus(s);
    } catch (e) {
      console.warn("etsy status load failed", e);
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

  useEffect(() => {
    if (status?.connected) refreshPublishes();
  }, [status?.connected, refreshPublishes]);

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
      // Re-throw so the caller (modal) can surface the error to the user.
      // The old console.warn-only behavior made activate appear to succeed
      // even when the Etsy API rejected it — modal would close silently
      // and the row would stay in draft with no operator feedback.
      console.warn("activate failed", e);
      throw e;
    } finally {
      setActivating(null);
    }
  };

  if (!status) {
    return <div className="etsy-rail-empty">connecting…</div>;
  }

  if (!status.connected) {
    return (
      <div className="etsy-rail-disconnected">
        <div className="etsy-rail-disconnected-msg">
          Etsy shop is not connected.
        </div>
        {error && <div className="etsy-rail-error">{error}</div>}
        <button
          type="button"
          className="etsy-rail-connect-btn"
          onClick={onConnect}
          disabled={busy}
        >
          {busy ? "Connecting…" : "Connect Etsy"}
        </button>
      </div>
    );
  }

  const visible = filterByTab(publishes, tab);
  const counts: Record<ListTab, number> = {
    drafts:   publishes.filter((p) => p.state === "draft").length,
    queue:    publishes.filter((p) => p.state === "queued").length,
    active:   publishes.filter((p) => p.state === "active").length,
    rejected: publishes.filter((p) => p.state === "rejected").length,
  };
  const activeTabDef = TAB_DEFS.find((t) => t.id === tab)!;

  return (
    <div className="etsy-rail" role="group" aria-label="Etsy">
      {etsyKilled && (
        <div className="etsy-rail-killed-banner">
          KILL SWITCH active — real publishing halted
        </div>
      )}

      {/* Status header — click to open the shop */}
      <button
        type="button"
        className="etsy-rail-status"
        onClick={() =>
          status.shop_name &&
          openUrl(`https://www.etsy.com/shop/${encodeURIComponent(status.shop_name)}`)
        }
        title={`Open ${status.shop_name ?? "shop"} on Etsy`}
      >
        <span className="etsy-rail-status-dot" />
        <div className="etsy-rail-status-text">
          <span className="etsy-rail-status-label">Shop</span>
          <span className="etsy-rail-status-name">
            {status.shop_name ?? "Connected"}
          </span>
        </div>
        <svg
          className="etsy-rail-status-icon"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M7 17L17 7M9 7h8v8" />
        </svg>
      </button>

      {/* Tab strip */}
      <div className="etsy-rail-tabs" role="tablist">
        {TAB_DEFS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`etsy-rail-tab${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
            title={`${t.label} · ${counts[t.id]}`}
          >
            <span className="etsy-rail-tab-label">{t.label}</span>
            {counts[t.id] > 0 && (
              <span className="etsy-rail-tab-count is-live">
                {counts[t.id] > 99 ? "99+" : counts[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List body */}
      <div className="etsy-rail-list">
        {visible.length === 0 ? (
          <div className="etsy-rail-empty">{activeTabDef.emptyMsg}</div>
        ) : (
          visible.slice(0, 12).map((p) => (
            <div key={p.id} className={`etsy-rail-row state-${p.state}`}>
              <span className={`etsy-rail-state state-${p.state}`}>{p.state}</span>
              <span className="etsy-rail-row-title" title={p.title}>
                {p.title.length > 32 ? p.title.slice(0, 30) + "…" : p.title}
              </span>
              {p.url && (
                <button
                  type="button"
                  className="etsy-rail-row-link"
                  onClick={() => p.url && openUrl(p.url)}
                  title="Open on Etsy"
                  aria-label="Open on Etsy"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M7 17L17 7M9 7h8v8" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="etsy-rail-row-review"
                onClick={() => setReviewing(p)}
                disabled={activating === p.local_listing_id}
                title="Review listing"
              >
                {activating === p.local_listing_id ? "…" : "Review"}
              </button>
            </div>
          ))
        )}
      </div>

      {/* Receipts accordion */}
      <button
        type="button"
        className={`etsy-rail-accordion${showReceipts ? " is-open" : ""}`}
        onClick={() => setShowReceipts((v) => !v)}
      >
        <span className="etsy-rail-accordion-label">
          Recent receipts
        </span>
        <span className={`etsy-rail-accordion-count${recentReceipts.length > 0 ? " is-live" : ""}`}>
          {recentReceipts.length}
        </span>
        <svg
          className="etsy-rail-accordion-caret"
          width="9" height="9" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {showReceipts && (
        <div className="etsy-rail-mini-list">
          {recentReceipts.length === 0 ? (
            <div className="etsy-rail-empty">no receipts yet</div>
          ) : (
            recentReceipts.map((r) => (
              <div key={r.receipt_id} className="etsy-rail-mini-row">
                <span className="etsy-rail-mini-id">#{r.receipt_id}</span>
                <span className="etsy-rail-mini-meta">
                  {r.txns} txn{r.txns === 1 ? "" : "s"}
                </span>
                <span className="etsy-rail-mini-rev">
                  ${r.revenue_usd.toFixed(2)}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {reviewing && (
        <ListingReviewModal
          localListingId={reviewing.local_listing_id}
          fallbackTitle={reviewing.title}
          mode={tab}
          onClose={() => {
            setReviewing(null);
            refreshPublishes();
          }}
          onActivate={async (id) => {
            await onActivate(id);
          }}
        />
      )}
    </div>
  );
}
