import { useEffect, useRef, useState } from "react";
import { api, type BudgetStatus } from "../../api";
import EtsyPanel from "./EtsyPanel";
import AnalyticsPanel from "./AnalyticsPanel";
import PromptsPanel from "./PromptsPanel";
import WealthLeaderboard from "./WealthLeaderboard";
import { useFactoryStore } from "../state/factoryStore";

/* ─── Budget helpers ─────────────────────────────────────────────────── */
function fmt(v: number) {
  return `$${v.toFixed(2)}`;
}
function pct(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.min(100, (num / den) * 100);
}
function tone(num: number, den: number): "ok" | "warn" | "danger" {
  const p = pct(num, den);
  if (p < 60) return "ok";
  if (p < 90) return "warn";
  return "danger";
}

/* ─── BudgetCard ─────────────────────────────────────────────────────── */
function BudgetCard() {
  const [s, setS] = useState<BudgetStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .budgetStatus()
        .then((v) => {
          if (!cancelled) setS(v);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="rail-card">
      <div className="rail-card-header">Budget</div>
      {!s ? (
        <div className="rail-card-loading">loading…</div>
      ) : (
        <>
          <BudgetRow label="Hour" v={s.hour_usd} cap={s.hourly_cap_usd} />
          <BudgetRow label="Day" v={s.today_usd} cap={s.daily_cap_usd} />
          <BudgetRow label="Month" v={s.month_usd} cap={s.monthly_cap_usd} />
          <div className="rail-budget-burn">
            Burn&nbsp;&nbsp;{fmt(s.burn_per_hour_usd)}/hr
          </div>
        </>
      )}
    </div>
  );
}

function BudgetRow({
  label,
  v,
  cap,
}: {
  label: string;
  v: number;
  cap: number;
}) {
  const t = tone(v, cap);
  const p = pct(v, cap);
  return (
    <div className={`rail-budget-row ${t}`}>
      <span className="rail-budget-row-label">{label}</span>
      <div className="rail-budget-bar">
        <div className="rail-budget-bar-fill" style={{ width: `${p}%` }} />
      </div>
      <span className="rail-budget-row-num">
        {fmt(v)}/{fmt(cap)}
      </span>
    </div>
  );
}

/* ─── EtsyCard ───────────────────────────────────────────────────────── */
function EtsyCard() {
  return (
    <div className="rail-card rail-etsy-card">
      <div className="rail-card-header">Etsy</div>
      {/* Reuse the existing EtsyPanel component; its pill+popover will sit
          inside the rail card. The CSS overrides position it inline. */}
      <EtsyPanel />
    </div>
  );
}

/* ─── Rail row for Cycles / Prompts / Wealth ─────────────────────────── */
function PanelRow({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="rail-panel-row-wrap">
      <button
        type="button"
        className={`rail-panel-row${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rail-panel-row-label">{label}</span>
        <span className="rail-panel-row-count">{count}</span>
        <span className="rail-panel-row-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="rail-panel-row-popover">{children}</div>}
    </div>
  );
}

/* ─── Collapsed icon strip ───────────────────────────────────────────── */
function CollapsedStrip({
  onExpand,
}: {
  onExpand: () => void;
}) {
  return (
    <nav
      className="rail-collapsed-strip"
      aria-label="Command rail (collapsed)"
    >
      <button
        type="button"
        className="rail-strip-btn"
        onClick={onExpand}
        title="Expand command rail"
      >
        {/* Chevron-right icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <button
        type="button"
        className="rail-strip-btn"
        onClick={onExpand}
        title="Budget"
      >
        {/* Dollar icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
        </svg>
      </button>
      <button
        type="button"
        className="rail-strip-btn"
        onClick={onExpand}
        title="Etsy"
      >
        {/* Shop bag icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <path d="M16 10a4 4 0 01-8 0" />
        </svg>
      </button>
      <button
        type="button"
        className="rail-strip-btn"
        onClick={onExpand}
        title="Cycles"
      >
        {/* Refresh icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
      </button>
      <button
        type="button"
        className="rail-strip-btn"
        onClick={onExpand}
        title="Prompts"
      >
        {/* Edit icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
      <button
        type="button"
        className="rail-strip-btn"
        onClick={onExpand}
        title="Wealth"
      >
        {/* Trophy icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <polyline points="8 21 12 17 16 21" />
          <line x1="12" y1="17" x2="12" y2="12" />
          <path d="M6 9V3h12v6" />
          <path d="M6 9a6 6 0 0012 0" />
          <path d="M4 6H2v3a4 4 0 004 4" />
          <path d="M20 6h2v3a4 4 0 01-4 4" />
        </svg>
      </button>
    </nav>
  );
}

/* ─── Main CommandRail ───────────────────────────────────────────────── */

export interface CommandRailProps {
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
}

export default function CommandRail({ collapsed, onToggle }: CommandRailProps) {
  const recentCycles = useFactoryStore((s) => s.recentCycles);
  const wealthByRole = useFactoryStore((s) => s.wealthByRole);

  const cycleCount = recentCycles.length;
  const wealthCount = Object.keys(wealthByRole).length;

  if (collapsed) {
    return <CollapsedStrip onExpand={() => onToggle(false)} />;
  }

  return (
    <aside className="rail" aria-label="Command rail">
      {/* Header */}
      <div className="rail-header">
        <span className="rail-header-label">Command</span>
        <button
          type="button"
          className="rail-collapse-btn"
          onClick={() => onToggle(true)}
          title="Collapse rail"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      {/* Budget card */}
      <BudgetCard />

      {/* Etsy card */}
      <EtsyCard />

      {/* Cycles row */}
      <PanelRow label="Cycles" count={cycleCount}>
        <AnalyticsPanel alwaysOpen />
      </PanelRow>

      {/* Prompts row */}
      <PanelRow label="Prompts" count={0}>
        <PromptsPanel alwaysOpen />
      </PanelRow>

      {/* Wealth row */}
      <PanelRow label="Wealth" count={wealthCount}>
        <WealthLeaderboard alwaysOpen />
      </PanelRow>
    </aside>
  );
}
