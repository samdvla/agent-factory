import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BudgetStatus, type EtsyStatus, type PromptRow } from "../../api";
import EtsyPanel from "./EtsyPanel";
import AnalyticsPanel from "./AnalyticsPanel";
import PromptsPanel from "./PromptsPanel";
import WealthLeaderboard from "./WealthLeaderboard";
import ActivityModal from "./ActivityModal";
import ConversationsModal from "./ConversationsModal";
import ListingStatsPanel from "./ListingStatsPanel";
import { useFactoryStore } from "../state/factoryStore";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

/* ─── BudgetRing ─────────────────────────────────────────────────────── */
function BudgetRing({ p, t }: { p: number; t: "ok" | "warn" | "danger" }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const dash = (p / 100) * c;
  const color = t === "ok" ? "#9be0b3" : t === "warn" ? "#e8d77b" : "#ff8a93";
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 36 36"
      className="rail-budget-ring"
      aria-hidden="true"
    >
      <circle cx="18" cy="18" r={r} fill="none" stroke="#1f2a37" strokeWidth="2" />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={`${dash} ${c - dash}`}
        strokeLinecap="round"
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

/* ─── BudgetCard ─────────────────────────────────────────────────────── */
function BudgetCard({ budget }: { budget: BudgetStatus | null }) {
  return (
    <div id="rail-budget" className="rail-card rail-card--budget">
      <div className="rail-card-header">
        <span className="rail-card-accent" style={{ background: "#9be0b3" }} />
        Budget
      </div>
      {!budget ? (
        <div className="rail-card-loading">loading…</div>
      ) : (
        <>
          <BudgetRow label="Hour" v={budget.hour_usd} cap={budget.hourly_cap_usd} />
          <BudgetRow label="Day" v={budget.today_usd} cap={budget.daily_cap_usd} />
          <BudgetRow label="Month" v={budget.month_usd} cap={budget.monthly_cap_usd} />
          <div className="rail-budget-burn">
            Burn&nbsp;&nbsp;{fmt(budget.burn_per_hour_usd)}/hr
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
    <div id="rail-etsy" className="rail-card rail-etsy-card rail-card--etsy">
      <div className="rail-card-header">
        <span className="rail-card-accent" style={{ background: "#f5a623" }} />
        Etsy
      </div>
      {/* alwaysOpen keeps the panel body visible without needing to click
          the pill. The pill button is hidden via CSS since the card header
          already labels this section. */}
      <EtsyPanel alwaysOpen />
    </div>
  );
}

/* ─── Rail row for Cycles / Prompts / Wealth / Activity ──────────────── */
function PanelRow({
  id,
  label,
  count,
  accentColor,
  emptyMessage,
  alwaysRenderChildren,
  children,
}: {
  id: string;
  label: string;
  count: number;
  accentColor: string;
  emptyMessage: string;
  /** If true, always render `children` regardless of count. The badge still
   *  shows count, but the panel body uses the children's own empty state. */
  alwaysRenderChildren?: boolean;
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
    <div ref={wrapRef} id={id} className="rail-panel-row-wrap">
      <button
        type="button"
        className={`rail-panel-row${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rail-card-accent" style={{ background: accentColor }} />
        <span className="rail-panel-row-label">{label}</span>
        <span className={`rail-panel-row-count${count > 0 ? " is-live" : " is-zero"}`}>
          {count}
        </span>
        <svg
          className={`rail-panel-row-caret${open ? " is-open" : ""}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {open && (
        <div className="rail-panel-row-popover">
          {count === 0 && !alwaysRenderChildren ? (
            <div className="rail-panel-empty-state">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <circle cx="12" cy="16" r="0.5" fill="currentColor" strokeWidth="0" />
              </svg>
              <span>{emptyMessage}</span>
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Collapsed icon strip ───────────────────────────────────────────── */

type FocusTarget =
  | "budget"
  | "etsy"
  | "activity"
  | "conversations"
  | "cycles"
  | "prompts"
  | "wealth"
  | null;

interface CollapsedStripProps {
  onFocusExpand: (target: FocusTarget) => void;
  budget: BudgetStatus | null;
  etsyStatus: EtsyStatus | null;
  cycleCount: number;
  promptOverrideCount: number;
  wealthCount: number;
  unratedCount: number;
  conversationsUnread: number;
}

function CollapsedStrip({
  onFocusExpand,
  budget,
  etsyStatus,
  cycleCount,
  promptOverrideCount,
  wealthCount,
  unratedCount,
  conversationsUnread,
}: CollapsedStripProps) {
  const budgetTone = budget ? tone(budget.today_usd, budget.daily_cap_usd) : "ok";
  const budgetPct = budget ? pct(budget.today_usd, budget.daily_cap_usd) : 0;
  const budgetTip = budget
    ? `${fmt(budget.today_usd)} / ${fmt(budget.daily_cap_usd)} today`
    : "Budget loading…";
  const etsyConnected = etsyStatus?.connected ?? false;
  const etsyTip = etsyStatus
    ? etsyConnected
      ? `${etsyStatus.shop_name ?? "Connected"} — Etsy shop`
      : "Etsy not connected"
    : "Etsy loading…";

  return (
    <nav
      className="rail-collapsed-strip"
      aria-label="Command rail (collapsed)"
    >
      {/* Expand chevron */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand(null)}
        aria-label="Expand command rail"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="rail-tip">Expand rail</span>
      </button>

      {/* Budget — ring + $ icon */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand("budget")}
        aria-label="Budget"
      >
        <BudgetRing p={budgetPct} t={budgetTone} />
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="rail-strip-icon"
          aria-hidden="true"
        >
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
        </svg>
        <span className="rail-tip">{budgetTip}</span>
      </button>

      {/* Etsy — status dot */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand("etsy")}
        aria-label="Etsy"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <path d="M16 10a4 4 0 01-8 0" />
        </svg>
        <span
          className={`rail-etsy-dot${etsyConnected ? " is-connected" : " is-disconnected"}`}
          aria-hidden="true"
        />
        <span className="rail-tip">{etsyTip}</span>
      </button>

      {/* Activity — count badge for unrated outputs */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand("activity")}
        aria-label="Activity"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        {unratedCount > 0 && (
          <span className="rail-strip-badge" aria-label={`${unratedCount} unrated`}>
            {unratedCount > 99 ? "99+" : unratedCount}
          </span>
        )}
        <span className="rail-tip">
          {unratedCount > 0
            ? `${unratedCount} output${unratedCount === 1 ? "" : "s"} waiting for review`
            : "No new outputs to review"}
        </span>
      </button>

      {/* Conversations — agent-to-agent messages */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand("conversations")}
        aria-label="Conversations"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
        </svg>
        {conversationsUnread > 0 && (
          <span
            className="rail-strip-badge"
            aria-label={`${conversationsUnread} new`}
          >
            {conversationsUnread > 99 ? "99+" : conversationsUnread}
          </span>
        )}
        <span className="rail-tip">
          {conversationsUnread > 0
            ? `${conversationsUnread} new message${conversationsUnread === 1 ? "" : "s"} between agents`
            : "Agent conversation log"}
        </span>
      </button>

      {/* Cycles — count badge */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand("cycles")}
        aria-label="Cycles"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
        {cycleCount > 0 && (
          <span className="rail-strip-badge" aria-label={`${cycleCount} cycles`}>
            {cycleCount > 99 ? "99+" : cycleCount}
          </span>
        )}
        <span className="rail-tip">
          {cycleCount > 0 ? `${cycleCount} cycle${cycleCount === 1 ? "" : "s"}` : "No cycles yet"}
        </span>
      </button>

      {/* Prompts — count badge */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand("prompts")}
        aria-label="Prompts"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        {promptOverrideCount > 0 && (
          <span
            className="rail-strip-badge"
            aria-label={`${promptOverrideCount} overrides`}
          >
            {promptOverrideCount}
          </span>
        )}
        <span className="rail-tip">
          {promptOverrideCount > 0
            ? `${promptOverrideCount} override${promptOverrideCount === 1 ? "" : "s"} active`
            : "No prompt overrides"}
        </span>
      </button>

      {/* Wealth — count badge */}
      <button
        type="button"
        className="rail-strip-btn"
        onClick={() => onFocusExpand("wealth")}
        aria-label="Wealth"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <polyline points="8 21 12 17 16 21" />
          <line x1="12" y1="17" x2="12" y2="12" />
          <path d="M6 9V3h12v6" />
          <path d="M6 9a6 6 0 0012 0" />
          <path d="M4 6H2v3a4 4 0 004 4" />
          <path d="M20 6h2v3a4 4 0 01-4 4" />
        </svg>
        {wealthCount > 0 && (
          <span className="rail-strip-badge" aria-label={`${wealthCount} earners`}>
            {wealthCount}
          </span>
        )}
        <span className="rail-tip">
          {wealthCount > 0
            ? `${wealthCount} role${wealthCount === 1 ? "" : "s"} earning`
            : "No earnings yet"}
        </span>
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

  // Budget state — fetched here so collapsed strip can show the ring
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  // Etsy status — for collapsed strip dot
  const [etsyStatus, setEtsyStatus] = useState<EtsyStatus | null>(null);
  // Prompt override count
  const [promptOverrideCount, setPromptOverrideCount] = useState(0);
  // Unrated jobs in the last 24h — drives the Activity badge
  const [unratedCount, setUnratedCount] = useState(0);

  // ActivityModal open state
  const [activityOpen, setActivityOpen] = useState(false);
  // ConversationsModal open state + unread badge
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [conversationsUnread, setConversationsUnread] = useState(0);
  // Timestamp of last "open" — anything newer counts as unread.
  const lastConvSeenRef = useRef<number>(Math.floor(Date.now() / 1000));

  // Which card to scroll to after expanding
  const [pendingFocus, setPendingFocus] = useState<FocusTarget>(null);
  const railRef = useRef<HTMLElement>(null);

  // Poll budget every 5s
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .budgetStatus()
        .then((v) => { if (!cancelled) setBudget(v); })
        .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Fetch Etsy status once (refreshed by EtsyPanel internally, this is just
  // for the collapsed strip indicator)
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .etsyStatus()
        .then((v) => { if (!cancelled) setEtsyStatus(v); })
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Fetch prompt override count once; refresh every 15s
  const refreshPromptCount = useCallback(async () => {
    try {
      const rows = await api.listPrompts();
      const n = Object.values(rows).filter((r: PromptRow) => r.override).length;
      setPromptOverrideCount(n);
    } catch {
      // Silently ignore during boot / non-Tauri
    }
  }, []);

  useEffect(() => {
    refreshPromptCount();
    const id = setInterval(refreshPromptCount, 15000);
    return () => clearInterval(id);
  }, [refreshPromptCount]);

  // Unrated count: poll every 15s AND bump on job_completed/job_failed.
  const refreshUnratedCount = useCallback(async () => {
    try {
      const n = await api.unratedJobCount();
      setUnratedCount(n);
    } catch {
      // Silent during boot / non-Tauri
    }
  }, []);
  useEffect(() => {
    refreshUnratedCount();
    const id = setInterval(refreshUnratedCount, 15000);
    let unlisten: UnlistenFn | undefined;
    listen<{ kind: string }>("supervisor:event", (e) => {
      if (
        e.payload.kind === "job_completed" ||
        e.payload.kind === "job_failed"
      ) {
        refreshUnratedCount();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      clearInterval(id);
      unlisten?.();
    };
  }, [refreshUnratedCount]);

  // Conversations unread count — poll periodically AND react instantly when a
  // worker emits an agent_message notification.
  const refreshConvUnread = useCallback(async () => {
    try {
      const n = await api.agentMessagesSince(lastConvSeenRef.current);
      setConversationsUnread(n);
    } catch {
      // Silent during boot / non-Tauri
    }
  }, []);
  useEffect(() => {
    refreshConvUnread();
    const id = setInterval(refreshConvUnread, 12000);
    let unlisten: UnlistenFn | undefined;
    listen<{ method?: string }>("supervisor:event", (e) => {
      const p = e.payload as { method?: string };
      if (p.method === "agent_message") {
        refreshConvUnread();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      clearInterval(id);
      unlisten?.();
    };
  }, [refreshConvUnread]);

  // When the modal opens, treat everything currently in the log as "seen".
  const openConversations = useCallback(() => {
    lastConvSeenRef.current = Math.floor(Date.now() / 1000);
    setConversationsUnread(0);
    setConversationsOpen(true);
  }, []);

  // When pendingFocus is set and rail is expanded, scroll + flash the target
  useEffect(() => {
    if (!pendingFocus || collapsed) return;
    // Give React one frame to mount the expanded rail
    const raf = requestAnimationFrame(() => {
      const idMap: Record<string, string> = {
        budget: "rail-budget",
        etsy: "rail-etsy",
        activity: "rail-activity",
        cycles: "rail-cycles",
        prompts: "rail-prompts",
        wealth: "rail-wealth",
      };
      const targetId = idMap[pendingFocus];
      if (!targetId) return;
      const el = document.getElementById(targetId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("rail-flash");
      setTimeout(() => el.classList.remove("rail-flash"), 800);
      setPendingFocus(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingFocus, collapsed]);

  const handleFocusExpand = (target: FocusTarget) => {
    // Activity + Conversations are modals, not rail rows — open them directly
    // regardless of collapsed state.
    if (target === "activity") {
      setActivityOpen(true);
      return;
    }
    if (target === "conversations") {
      openConversations();
      return;
    }
    onToggle(false);
    if (target) {
      setPendingFocus(target);
    }
  };

  if (collapsed) {
    return (
      <>
        <CollapsedStrip
          onFocusExpand={handleFocusExpand}
          budget={budget}
          etsyStatus={etsyStatus}
          cycleCount={cycleCount}
          promptOverrideCount={promptOverrideCount}
          wealthCount={wealthCount}
          unratedCount={unratedCount}
          conversationsUnread={conversationsUnread}
        />
        <ActivityModal open={activityOpen} onClose={() => setActivityOpen(false)} />
        <ConversationsModal
          open={conversationsOpen}
          onClose={() => setConversationsOpen(false)}
        />
      </>
    );
  }

  return (
    <aside ref={railRef} className="rail" aria-label="Command rail">
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
      <BudgetCard budget={budget} />

      {/* Etsy card */}
      <EtsyCard />

      {/* Conversations row — opens a modal showing the agent message log */}
      <div id="rail-conversations" className="rail-panel-row-wrap">
        <button
          type="button"
          className="rail-panel-row"
          onClick={openConversations}
          title="Open the conversation log between agents"
        >
          <span className="rail-card-accent" style={{ background: "#9be0b3" }} />
          <span className="rail-panel-row-label">Conversations</span>
          <span
            className={`rail-panel-row-count${conversationsUnread > 0 ? " is-live" : " is-zero"}`}
          >
            {conversationsUnread > 99 ? "99+" : conversationsUnread}
          </span>
          <svg
            className="rail-panel-row-caret"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            aria-hidden="true"
          >
            <polyline points="7 17 17 7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </button>
      </div>

      {/* Activity row — opens a full modal so cards have room to breathe */}
      <div id="rail-activity" className="rail-panel-row-wrap">
        <button
          type="button"
          className="rail-panel-row"
          onClick={() => setActivityOpen(true)}
          title="Open the Activity review"
        >
          <span className="rail-card-accent" style={{ background: "#b393f5" }} />
          <span className="rail-panel-row-label">Activity</span>
          <span
            className={`rail-panel-row-count${unratedCount > 0 ? " is-live" : " is-zero"}`}
          >
            {unratedCount > 99 ? "99+" : unratedCount}
          </span>
          <svg
            className="rail-panel-row-caret"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            aria-hidden="true"
          >
            <polyline points="7 17 17 7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </button>
      </div>

      {/* Impressions row — listing-stats feedback loop */}
      <PanelRow
        id="rail-impressions"
        label="Impressions"
        count={0}
        accentColor="#f5a623"
        emptyMessage="No drafts polled yet — publish a listing to start."
        alwaysRenderChildren
      >
        <ListingStatsPanel alwaysOpen />
      </PanelRow>

      {/* Cycles row */}
      <PanelRow
        id="rail-cycles"
        label="Cycles"
        count={cycleCount}
        accentColor="#5fd4f0"
        emptyMessage="No cycles completed yet — start the supervisor to begin."
      >
        <AnalyticsPanel alwaysOpen />
      </PanelRow>

      {/* Prompts row */}
      <PanelRow
        id="rail-prompts"
        label="Prompts"
        count={promptOverrideCount}
        accentColor="#b393f5"
        emptyMessage="No overrides set — agents are using system defaults."
      >
        <PromptsPanel alwaysOpen />
      </PanelRow>

      {/* Wealth row */}
      <PanelRow
        id="rail-wealth"
        label="Wealth"
        count={wealthCount}
        accentColor="#f5a623"
        emptyMessage="No earnings tracked yet — wealth builds over time."
      >
        <WealthLeaderboard alwaysOpen />
      </PanelRow>

      <ActivityModal open={activityOpen} onClose={() => setActivityOpen(false)} />
      <ConversationsModal
        open={conversationsOpen}
        onClose={() => setConversationsOpen(false)}
      />
    </aside>
  );
}
