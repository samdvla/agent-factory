import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../../api";
import { useFactoryStore } from "../state/factoryStore";

/**
 * One row per role with lifetime_net_usd, sorted desc. Mount fetches from
 * `cmd_list_wealth`; refreshes on `pnl_cycle_closed`. Top earner gets a
 * "is-leader" class for the gold accent (no emoji — matches existing CSS-only
 * style of EtsyPanel).
 */
function WealthLeaderboardImpl() {
  const wealthByRole = useFactoryStore((s) => s.wealthByRole);
  const setWealthByRole = useFactoryStore((s) => s.setWealthByRole);
  const roles = useFactoryStore((s) => s.roles);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listWealth();
      const map: Record<string, typeof rows[number]> = {};
      for (const r of rows) map[r.role] = r;
      setWealthByRole(map);
    } catch (e) {
      console.warn("leaderboard: listWealth failed", e);
    }
  }, [setWealthByRole]);

  useEffect(() => {
    refresh();
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        unlisten = await listen("pnl_cycle_closed", () => {
          refresh();
        });
      } catch {
        // No Tauri runtime (tests) — fine.
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  const sorted = useMemo(() => {
    return Object.values(wealthByRole).sort(
      (a, b) => b.lifetime_net_usd - a.lifetime_net_usd,
    );
  }, [wealthByRole]);

  const count = sorted.length;

  return (
    <div className="wealth-panel-wrap">
      <button
        type="button"
        className="wealth-pill"
        onClick={() => setOpen((v) => !v)}
        title={`${count} role${count === 1 ? "" : "s"} on the books`}
      >
        <span className="wealth-pill-label">Wealth</span>
        <span className="wealth-pill-value">{count}</span>
        <span className="wealth-pill-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="wealth-panel" role="dialog">
          <div className="wealth-panel-header">
            <span className="wealth-panel-title">Leaderboard</span>
            <span className="wealth-panel-sub">lifetime net</span>
          </div>
          <div className="wealth-panel-list">
            {count === 0 ? (
              <div className="wealth-panel-empty">no wealth recorded yet</div>
            ) : (
              sorted.map((w, idx) => {
                const role = roles[w.role];
                const display = role ? role.title : w.role;
                const net = w.lifetime_net_usd;
                const netCls = net >= 0 ? "is-gain" : "is-loss";
                const isLeader = idx === 0 && net > 0;
                return (
                  <div
                    key={w.role}
                    className={`wealth-row${isLeader ? " is-leader" : ""}`}
                  >
                    <span className="wealth-rank">{idx + 1}</span>
                    <span className="wealth-role" title={role?.name ?? w.role}>
                      {display}
                    </span>
                    <span className={`wealth-net ${netCls}`}>
                      {net >= 0 ? "+" : ""}${net.toFixed(2)}
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

const WealthLeaderboard = memo(WealthLeaderboardImpl);
export default WealthLeaderboard;
