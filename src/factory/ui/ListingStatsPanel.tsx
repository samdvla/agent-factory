import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type ListingStatsSummary } from "../../api";

interface Props {
  alwaysOpen?: boolean;
}

function fmtAge(ts: number): string {
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/**
 * Listing-stats feed: views/favorites per published draft, sorted by views
 * desc. This is what tells the operator whether a niche is "boring concept
 * (no views)" vs "good concept, bad thumbnail (views but no favorites)" vs
 * "good thumbnail, conversion problem (favorites but no sales)".
 */
export default function ListingStatsPanel({ alwaysOpen }: Props) {
  const [rows, setRows] = useState<ListingStatsSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(!!alwaysOpen);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.listListingStats(100));
    } catch {
      /* boot or non-Tauri */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    let unlisten: UnlistenFn | undefined;
    listen<{ kind?: string }>("supervisor:event", (e) => {
      if (e.payload.kind === "etsy_listing_stats") load();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open, load]);

  if (!alwaysOpen && !open) {
    return (
      <button className="ls-toggle" onClick={() => setOpen(true)}>
        Listing stats
      </button>
    );
  }

  return (
    <div className="ls-panel">
      <div className="ls-panel-head">
        <span className="ls-panel-title">Listing impressions</span>
        <button
          className="ls-refresh"
          onClick={load}
          disabled={loading}
          aria-label="Refresh listing stats"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="ls-empty">
          {loading
            ? "Loading…"
            : "No listing stats yet. Stats poll every 15 min after a draft is published."}
        </div>
      ) : (
        <table className="ls-table">
          <thead>
            <tr>
              <th className="ls-col-title">Listing</th>
              <th className="ls-col-num">Views</th>
              <th className="ls-col-num">Favs</th>
              <th className="ls-col-num">Sold</th>
              <th className="ls-col-age">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const diagnosis =
                r.total_orders > 0
                  ? "selling"
                  : r.favorites > 0
                    ? "favs · no sale"
                    : r.views > 5
                      ? "views · no fav"
                      : r.views > 0
                        ? "low traffic"
                        : "no views";
              return (
                <tr key={r.etsy_listing_id}>
                  <td className="ls-cell-title" title={r.title}>
                    <span className="ls-title-text">
                      {r.title || `listing #${r.etsy_listing_id}`}
                    </span>
                    <span
                      className={`ls-diag ls-diag--${diagnosis.split(" ")[0]}`}
                    >
                      {diagnosis}
                    </span>
                  </td>
                  <td className="ls-cell-num">{r.views}</td>
                  <td className="ls-cell-num">{r.favorites}</td>
                  <td className="ls-cell-num">{r.total_orders}</td>
                  <td className="ls-cell-age">{fmtAge(r.last_polled_ts)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
