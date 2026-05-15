import { memo, useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type CycleSummary } from "../../api";
import { useFactoryStore } from "../state/factoryStore";

/**
 * Lazy SVG thumbnail for a cycle. Uses IntersectionObserver so we don't
 * fan out 20 IPC calls on mount — assets fetch only when the row scrolls
 * into view. Falls back to a placeholder div when the listing has no
 * recorded asset (early cycles, fallback runs).
 */
function CycleThumb({ listingId }: { listingId: number | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!listingId) return;
    const node = ref.current;
    if (!node) return;
    // Bail if IntersectionObserver isn't available (older jsdom / non-browser).
    if (typeof IntersectionObserver === "undefined") {
      (async () => {
        try {
          const s = await api.readAssetSvg(listingId);
          setSvg(s);
        } catch {
          setSvg(null);
        }
      })();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (async () => {
              try {
                const s = await api.readAssetSvg(listingId);
                setSvg(s);
              } catch {
                setSvg(null);
              }
            })();
            io.disconnect();
          }
        }
      },
      { rootMargin: "100px" }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [listingId]);

  if (!listingId) {
    return <div ref={ref} className="analytics-thumb is-empty">—</div>;
  }
  if (svg == null) {
    return <div ref={ref} className="analytics-thumb is-empty">—</div>;
  }
  const src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return (
    <div ref={ref} className="analytics-thumb">
      <img src={src} alt="" width={48} height={48} />
    </div>
  );
}

/**
 * Collapsible HUD pill that surfaces the last N closed P&L cycles. Mount
 * fetches from `cmd_list_recent_cycles(20)`; subsequent refreshes are driven
 * by `pnl_cycle_closed` events (push-refreshed, no polling). Cycles also flow
 * into the store via the eventReducer so re-mounts don't have to re-fetch.
 */
function AnalyticsPanelImpl({ alwaysOpen = false }: { alwaysOpen?: boolean }) {
  const recentCycles = useFactoryStore((s) => s.recentCycles);
  const setRecentCycles = useFactoryStore((s) => s.setRecentCycles);
  const [open, setOpen] = useState(false);
  const isOpen = alwaysOpen || open;

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listRecentCycles(20);
      setRecentCycles(rows);
    } catch (e) {
      // Non-Tauri / boot-time: silently no-op; eventReducer will push later.
      console.warn("analytics: listRecentCycles failed", e);
    }
  }, [setRecentCycles]);

  useEffect(() => {
    refresh();
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        unlisten = await listen("pnl_cycle_closed", () => {
          refresh();
        });
      } catch {
        // listen() throws under jsdom — fine, mount-fetch above is enough.
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  const count = recentCycles.length;

  return (
    <div className="analytics-panel-wrap">
      <button
        type="button"
        className="analytics-pill"
        onClick={() => setOpen((v) => !v)}
        title={`${count} recent cycle${count === 1 ? "" : "s"}`}
      >
        <span className="analytics-pill-label">Cycles</span>
        <span className="analytics-pill-value">{count}</span>
        <svg
          className={`analytics-pill-caret${isOpen ? " is-open" : ""}`}
          width="10" height="10" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {isOpen && (
        <div className="analytics-panel" role="dialog">
          <div className="analytics-panel-header">
            <span className="analytics-panel-title">Recent cycles</span>
            <span className="analytics-panel-sub">last {count}</span>
          </div>
          <div className="analytics-panel-list">
            {count === 0 ? (
              <div className="analytics-panel-empty">no cycles yet</div>
            ) : (
              recentCycles.map((c: CycleSummary) => {
                const net = c.net_usd;
                const netCls = net >= 0 ? "is-gain" : "is-loss";
                const nicheRaw = c.niche ?? "—";
                return (
                  <div
                    key={c.cycle_id}
                    className="analytics-row"
                    title={`${c.cycle_id}\nrev $${c.revenue_usd.toFixed(2)} · cost $${c.total_cost_usd.toFixed(2)}\n${c.contributor_count} contributor${c.contributor_count === 1 ? "" : "s"}`}
                  >
                    <CycleThumb listingId={c.local_listing_id} />
                    <div className="analytics-niche-stack">
                      <span className="analytics-niche" title={c.niche ?? ""}>
                        {nicheRaw}
                      </span>
                      <span className="analytics-cid">
                        {c.cycle_id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="analytics-money-stack">
                      <span className={`analytics-net ${netCls}`}>
                        {net >= 0 ? "+" : ""}${net.toFixed(2)}
                      </span>
                      <span className="analytics-num">
                        ${c.revenue_usd.toFixed(2)} · ${c.total_cost_usd.toFixed(2)}
                      </span>
                    </div>
                    <span
                      className="analytics-contrib"
                      title={`${c.contributor_count} contributor${
                        c.contributor_count === 1 ? "" : "s"
                      }`}
                    >
                      {c.contributor_count}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const AnalyticsPanel = memo(AnalyticsPanelImpl);
export default AnalyticsPanel;
