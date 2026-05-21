import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  type Cults3dPublishRow,
  type Cults3dStatus,
  type EtsyStatus,
  type GumroadPublishRow,
  type GumroadStatus,
  type MmfPublishRow,
  type MmfStatus,
  type PinterestPinRow,
  type PinterestStatus,
  type SketchfabPublishRow,
  type SketchfabStatus,
} from "../../api";
import EtsyPanel from "./EtsyPanel";

/**
 * MarketplacesCard
 * ----------------
 * Stacked accordion of every marketplace (sales + traffic) the factory
 * publishes to. Replaces the old single-marketplace ETSY card on the rail.
 *
 *   ● ETSY        SabiWabiGifts         ▾
 *     draft 13   queue 0   active 1
 *     [full Etsy panel — same as before]
 *
 *   ● CULTS3D                            ▸
 *     27 listings · 0 today
 *
 *   ● SKETCHFAB                          ▸
 *     ...
 *
 * Only one marketplace expanded at a time. The Etsy expansion keeps its
 * existing EtsyPanel so the Draft/Queue/Active/Rejected review flow is
 * unchanged. Other marketplaces get a simpler list view (no draft state
 * server-side — they're publish-and-go).
 */

type MarketplaceId =
  | "etsy"
  | "cults3d"
  | "sketchfab"
  | "mmf"
  | "gumroad"
  | "pinterest";

/** Dot color reflects the operational state at a glance. */
type DotTone = "connected" | "disabled" | "disconnected" | "error";

function dotClass(tone: DotTone): string {
  return `mp-dot mp-dot--${tone}`;
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={`mp-caret${open ? " is-open" : ""}`}
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
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  );
}

/**
 * One row in the accordion. Click to expand; clicks on the external-link
 * icon bubble-stop so they don't toggle the row.
 */
function MarketplaceRow({
  id: _id,
  label,
  tone,
  metaLine,
  externalUrl,
  expanded,
  onToggle,
  children,
}: {
  id: MarketplaceId;
  label: string;
  tone: DotTone;
  metaLine: string;
  /** Optional URL to open when the user clicks the row's external-link
   *  badge (e.g. the Etsy shop URL, Cults3D profile, Pinterest board). */
  externalUrl?: string | null;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  // Row head uses a div with role="button" rather than a real <button>
  // so we can safely nest a real <button> for the external-link action.
  // HTML disallows button-in-button, which would otherwise cause the
  // inner button to escape its parent at runtime.
  return (
    <div className={`mp-row${expanded ? " is-expanded" : ""}`}>
      <div
        className="mp-row-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={dotClass(tone)} aria-hidden="true" />
        <span className="mp-row-label">{label}</span>
        <span className="mp-row-meta">{metaLine}</span>
        {externalUrl && (
          <button
            type="button"
            className="mp-row-link"
            onClick={(e) => {
              e.stopPropagation();
              if (externalUrl) openUrl(externalUrl);
            }}
            title="Open in browser"
            aria-label={`Open ${label} externally`}
          >
            <ExternalLinkIcon />
          </button>
        )}
        <Caret open={expanded} />
      </div>
      {expanded && <div className="mp-row-body">{children}</div>}
    </div>
  );
}

/* ─── Shared "simple marketplace" panel ──────────────────────────────────
 * Uniform expanded body for every non-Etsy marketplace.
 *
 * Layout:
 *   today 5/10                              ← daily cap meter (only shown
 *                                              when creds are present)
 *   ───────────────────────────────────
 *   "Title…"        $4.99      ↗
 *   PENDING "Title…"  —        ↗           ← state badge only for
 *   ERROR  "Title…"   —        ⚠            non-active states; tooltip
 *                                              carries the error text
 *
 * Rationale: at-a-glance signal is the daily cap meter + which rows ARE
 * NOT in the happy path. Hiding the "ACTIVE" badge on every row reduces
 * noise so the eye lands on outliers immediately — same pattern as the
 * Etsy panel's tabs, just without the tab switcher.
 */

type SimpleRow = {
  id: number;
  title: string;
  state: string;
  url: string | null;
  error: string | null;
  /** Some marketplaces store warnings (publish succeeded but degraded —
   *  e.g. Sketchfab without the store add-on). Surfaced as a small dot. */
  warning?: string | null;
  /** USD price, when the marketplace stores it. Null hides the column. */
  price_usd?: number | null;
};

/** Tab definition for a marketplace panel. */
type TabDef = {
  id: string;
  label: string;
  match: (state: string) => boolean;
  emptyMsg: string;
};

/** Refresh icon used by both the Etsy panel and the new sync row. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={spinning ? "is-spinning" : ""}
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  );
}

/** "active" / "published" = happy path → no badge. Everything else gets a
 *  visible badge so it stands out in the list. */
function isHappyState(state: string): boolean {
  return state === "active" || state === "published";
}

/** Default tab sets, kept here so the marketplace adapters below stay
 *  short. Etsy has its own EtsyPanel and is NOT routed through this. */
const DEFAULT_PUBLISHED_TABS: TabDef[] = [
  {
    id: "active",
    label: "Active",
    match: (s) => s === "active" || s === "published",
    emptyMsg: "No active listings yet",
  },
  {
    id: "errored",
    label: "Errored",
    match: (s) => s === "errored" || s === "failed",
    emptyMsg: "Nothing errored",
  },
];

const PINTEREST_TABS: TabDef[] = [
  {
    id: "published",
    label: "Live",
    match: (s) => s === "published",
    emptyMsg: "No live pins yet",
  },
  {
    id: "errored",
    label: "Errored",
    match: (s) => s === "errored" || s === "failed",
    emptyMsg: "Nothing errored",
  },
];

/**
 * Uniform marketplace body — used by every non-Etsy marketplace. Layout
 * matches Etsy's panel one-for-one: today/cap meter → sync row → tab
 * strip → filtered list. Tab definitions vary by marketplace but the
 * shell is identical so the operator's eye lands in the same places
 * regardless of which channel they're looking at.
 */
function UniformMarketplaceBody({
  tabs,
  emptyMsgWhenDisconnected,
  rows,
  loading,
  todayCount,
  dailyCap,
  credsPresent,
}: {
  tabs: TabDef[];
  emptyMsgWhenDisconnected: string;
  rows: SimpleRow[];
  loading: boolean;
  todayCount: number | null;
  /** Optional listing/pin cap. Only Pinterest still carries a cap; the
   *  product marketplaces dropped theirs, so they omit this prop and the
   *  cap meter simply doesn't render for them. */
  dailyCap?: number | null;
  credsPresent: boolean;
}) {
  const [tab, setTab] = useState<string>(tabs[0]?.id ?? "active");

  if (loading) {
    return <div className="mp-empty">loading…</div>;
  }

  // Counts per tab — drives the badge on each tab pill.
  const counts: Record<string, number> = {};
  for (const t of tabs) counts[t.id] = 0;
  for (const r of rows) {
    for (const t of tabs) {
      if (t.match(r.state)) {
        counts[t.id] = (counts[t.id] || 0) + 1;
        break;
      }
    }
  }
  const activeTab = tabs.find((t) => t.id === tab) ?? tabs[0];
  const visible = rows.filter((r) => activeTab && activeTab.match(r.state));

  return (
    <>
      {credsPresent && todayCount !== null && dailyCap != null && (
        <div className="mp-today">
          <span className="mp-today-label">today</span>
          <span className="mp-today-count">
            <strong>{todayCount}</strong>
            <span className="mp-today-cap">/ {dailyCap}</span>
          </span>
          <span className="mp-today-bar" aria-hidden="true">
            <span
              className="mp-today-bar-fill"
              style={{
                width: `${
                  dailyCap > 0
                    ? Math.min(100, (todayCount / dailyCap) * 100)
                    : 0
                }%`,
              }}
            />
          </span>
        </div>
      )}

      {/* Tab strip — re-uses the Etsy panel's tab CSS so styling stays
          uniform across every marketplace. Two-tab default; Etsy has
          four in its own panel. */}
      {credsPresent && (
        <div className="etsy-rail-tabs" role="tablist">
          {tabs.map((t) => (
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
      )}

      {!credsPresent ? (
        <div className="mp-empty">{emptyMsgWhenDisconnected}</div>
      ) : visible.length === 0 ? (
        <div className="mp-empty">{activeTab?.emptyMsg ?? "Nothing here"}</div>
      ) : (
        <div className="mp-list">
          {visible.slice(0, 10).map((r) => {
            const happy = isHappyState(r.state);
            return (
              <div key={r.id} className={`mp-list-row state-${r.state}`}>
                {!happy && (
                  <span
                    className={`mp-list-state state-${r.state}`}
                    title={r.error ?? r.state}
                  >
                    {r.state}
                  </span>
                )}
                <span className="mp-list-title" title={r.error ?? r.title}>
                  {r.title.length > 34 ? r.title.slice(0, 32) + "…" : r.title}
                </span>
                {r.warning && (
                  <span
                    className="mp-list-warn"
                    title={r.warning}
                    aria-label="warning"
                  >
                    !
                  </span>
                )}
                <span className="mp-list-price">
                  {typeof r.price_usd === "number" && r.price_usd > 0
                    ? `$${r.price_usd.toFixed(2)}`
                    : ""}
                </span>
                {r.url && (
                  <button
                    type="button"
                    className="mp-list-link"
                    onClick={() => r.url && openUrl(r.url)}
                    title="Open externally"
                    aria-label="Open externally"
                  >
                    <ExternalLinkIcon />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ─── Cults3D ───────────────────────────────────────────────────────────── */

function useCults3d() {
  const [status, setStatus] = useState<Cults3dStatus | null>(null);
  const [rows, setRows] = useState<Cults3dPublishRow[] | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api.cults3dStatus(),
        api.cults3dListPublishes(25),
      ]);
      setStatus(s);
      setRows(r);
    } catch {
      /* boot */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  return { status, rows };
}

/* ─── Sketchfab ─────────────────────────────────────────────────────────── */

function useSketchfab() {
  const [status, setStatus] = useState<SketchfabStatus | null>(null);
  const [rows, setRows] = useState<SketchfabPublishRow[] | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api.sketchfabStatus(),
        api.sketchfabListPublishes(25),
      ]);
      setStatus(s);
      setRows(r);
    } catch {
      /* boot */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  return { status, rows };
}

/** Sketchfab → Fab pipeline action panel. Three operations:
 *  - Heal for Fab migration: re-asserts CC-BY / public / published /
 *    downloadable on every free Sketchfab upload so they show up in Fab's
 *    migration tool. Run before opening fab.com/portal/migration.
 *  - Export Fab pricing: dumps a CSV checklist (title, Sketchfab URL,
 *    suggested price from Cults3D) so the operator can power through
 *    fab.com/portal/listings setting prices on each migrated listing.
 *    Fab has no public seller API for pricing.
 *  - Revoke Sketchfab downloads post-migration: flips isDownloadable=false
 *    after Fab has crawled and migrated each model, so the free Sketchfab
 *    copy stops undercutting the paid Fab listing. Reversible. */
function SketchfabFabHealAction({ credsPresent }: { credsPresent: boolean }) {
  const [busy, setBusy] = useState<null | "heal" | "export" | "revoke">(null);
  const [summary, setSummary] = useState<string | null>(null);

  const runHeal = useCallback(async () => {
    setBusy("heal");
    setSummary(null);
    try {
      const r = await api.sketchfabHealForMigration();
      setSummary(
        `heal: ${r.checked} checked · ${r.already_ok} ok · ${r.healed} healed · ${r.errored} errored`,
      );
    } catch (e: unknown) {
      setSummary(`heal failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const runExport = useCallback(async () => {
    setBusy("export");
    setSummary(null);
    try {
      const rows = await api.sketchfabFabPricingExport();
      const header =
        "title,sketchfab_uid,sketchfab_url,cults3d_price_usd,sketchfab_price_usd,suggested_fab_price_usd";
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const body = rows
        .map((r) =>
          [
            esc(r.title),
            esc(r.sketchfab_uid),
            esc(r.sketchfab_url ?? ""),
            esc(r.cults3d_price_usd ?? ""),
            esc(r.sketchfab_price_usd ?? ""),
            esc(r.suggested_fab_price_usd ?? ""),
          ].join(","),
        )
        .join("\n");
      const csv = `${header}\n${body}\n`;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `fab-pricing-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSummary(`export: ${rows.length} rows · fab-pricing-${stamp}.csv`);
    } catch (e: unknown) {
      setSummary(`export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const runRevoke = useCallback(async () => {
    if (
      !confirm(
        "Flip all migrated Sketchfab models to view-only? Only run AFTER Fab migration has completed on fab.com/portal/migration. Reversible via Heal.",
      )
    ) {
      return;
    }
    setBusy("revoke");
    setSummary(null);
    try {
      const r = await api.sketchfabRevokeDownloadsPostMigration();
      setSummary(
        `revoke: ${r.checked} checked · ${r.revoked} revoked · ${r.errored} errored`,
      );
    } catch (e: unknown) {
      setSummary(`revoke failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  if (!credsPresent) return null;
  return (
    <div className="mp-extra-action">
      <button
        type="button"
        disabled={busy !== null}
        onClick={runHeal}
        className="mp-action-btn"
        title="Re-assert CC-BY / public / published / downloadable on every Sketchfab listing so they show up in fab.com/portal/migration."
      >
        {busy === "heal" ? "Healing…" : "Heal for Fab migration"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={runExport}
        className="mp-action-btn"
        title="Download CSV of migrated listings with suggested Fab prices. Fab has no public pricing API — use this as a manual checklist at fab.com/portal/listings."
      >
        {busy === "export" ? "Exporting…" : "Export Fab pricing CSV"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={runRevoke}
        className="mp-action-btn"
        title="After Fab migration completes, flip Sketchfab downloads off so the free copy stops undercutting the paid Fab listing."
      >
        {busy === "revoke" ? "Revoking…" : "Revoke Sketchfab downloads"}
      </button>
      {summary && <span className="mp-action-summary">{summary}</span>}
    </div>
  );
}

/* ─── MMF ───────────────────────────────────────────────────────────────── */

function useMmf() {
  const [status, setStatus] = useState<MmfStatus | null>(null);
  const [rows, setRows] = useState<MmfPublishRow[] | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api.mmfStatus(),
        api.mmfListPublishes(25),
      ]);
      setStatus(s);
      setRows(r);
    } catch {
      /* boot */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  return { status, rows };
}

/* ─── Gumroad ───────────────────────────────────────────────────────────── */

function useGumroad() {
  const [status, setStatus] = useState<GumroadStatus | null>(null);
  const [rows, setRows] = useState<GumroadPublishRow[] | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api.gumroadStatus(),
        api.gumroadListPublishes(25),
      ]);
      setStatus(s);
      setRows(r);
    } catch {
      /* boot */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  return { status, rows };
}

/* ─── Pinterest (traffic — pins, not products) ──────────────────────────── */

function usePinterest() {
  const [status, setStatus] = useState<PinterestStatus | null>(null);
  const [pins, setPins] = useState<PinterestPinRow[] | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        api.pinterestStatus(),
        api.pinterestListPins(25),
      ]);
      setStatus(s);
      setPins(p);
    } catch {
      /* boot */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  return { status, pins };
}

/* ─── Etsy (uses existing EtsyPanel) ────────────────────────────────────── */

function useEtsy() {
  const [status, setStatus] = useState<EtsyStatus | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await api.etsyStatus());
    } catch {
      /* boot */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);
  return status;
}

/* ─── Tone / meta-line helpers ──────────────────────────────────────────── */

function toneFor(creds: boolean, enabled: boolean): DotTone {
  if (!creds) return "disconnected";
  if (!enabled) return "disabled";
  return "connected";
}

/* ─── The card itself ───────────────────────────────────────────────────── */

export default function MarketplacesCard() {
  // Etsy is special-cased — it has its own OAuth UX inside EtsyPanel that
  // we don't want to duplicate. We only need its status here for the
  // collapsed-row meta line.
  const etsyStatus = useEtsy();
  const cults3d = useCults3d();
  const sketchfab = useSketchfab();
  const mmf = useMmf();
  const gumroad = useGumroad();
  const pinterest = usePinterest();

  // Etsy is the most-used so it expands by default. Persisting expand state
  // across reloads isn't worth the local-storage churn — one tap restores
  // whatever the operator wants.
  const [expanded, setExpanded] = useState<MarketplaceId>("etsy");
  const toggle = (id: MarketplaceId) =>
    setExpanded((cur) => (cur === id ? ("" as MarketplaceId) : id));

  // One sync button at the card header runs the full-fleet resync.
  // Icon-only: success leaves no toast, the panels just reflect updated
  // state on their next 15s poll (and the Etsy panel bumps explicitly
  // via the EtsyDraftRestored event the backend emits when Etsy changes).
  const [syncing, setSyncing] = useState(false);
  const onSyncAll = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncing) return;
    setSyncing(true);
    try {
      await api.resyncAllMarketplaces();
    } catch (err) {
      console.warn("resync-all failed", err);
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  // ── Etsy meta line: drafts / queue / active counts ────────────────────
  // We don't refetch publishes here — EtsyPanel owns that. The meta line
  // shows the shop name on collapse; counts appear inside the expanded
  // panel where they're already rendered.
  const etsyTone: DotTone = etsyStatus
    ? etsyStatus.connected
      ? "connected"
      : "disconnected"
    : "disconnected";
  const etsyMeta = etsyStatus
    ? etsyStatus.connected
      ? etsyStatus.shop_name ?? "connected"
      : "not connected"
    : "loading…";
  const etsyUrl =
    etsyStatus?.shop_name &&
    `https://www.etsy.com/shop/${encodeURIComponent(etsyStatus.shop_name)}`;

  // ── Cults3D ───────────────────────────────────────────────────────────
  const c3 = cults3d.status;
  const c3Tone: DotTone = c3
    ? toneFor(c3.creds_present && c3.asset_host_configured, c3.enabled)
    : "disconnected";
  const c3Meta = c3
    ? c3.creds_present
      ? `${cults3d.rows?.length ?? 0} recent · ${c3.today_count} today`
      : "not connected"
    : "loading…";

  // ── Sketchfab ─────────────────────────────────────────────────────────
  const sf = sketchfab.status;
  const sfTone: DotTone = sf
    ? toneFor(sf.creds_present, sf.enabled)
    : "disconnected";
  const sfMeta = sf
    ? sf.creds_present
      ? `${sketchfab.rows?.length ?? 0} recent · ${sf.today_count} today`
      : "not connected"
    : "loading…";

  // ── MMF ───────────────────────────────────────────────────────────────
  const mm = mmf.status;
  const mmTone: DotTone = mm
    ? toneFor(mm.creds_present, mm.enabled)
    : "disconnected";
  const mmMeta = mm
    ? mm.creds_present
      ? `${mmf.rows?.length ?? 0} recent · ${mm.today_count} today`
      : "not connected"
    : "loading…";

  // ── Gumroad ───────────────────────────────────────────────────────────
  const gm = gumroad.status;
  const gmTone: DotTone = gm
    ? toneFor(gm.creds_present, gm.enabled)
    : "disconnected";
  const gmMeta = gm
    ? gm.creds_present
      ? `${gumroad.rows?.length ?? 0} recent · ${gm.today_count} today`
      : "not connected"
    : "loading…";

  // ── Pinterest ─────────────────────────────────────────────────────────
  const pi = pinterest.status;
  const piTone: DotTone = pi
    ? toneFor(pi.creds_present, pi.enabled)
    : "disconnected";
  const piMeta = pi
    ? pi.creds_present
      ? `${pi.today_count}/${pi.daily_cap} pinned today`
      : "not connected"
    : "loading…";

  return (
    <div id="rail-etsy" className="rail-card rail-card--marketplaces">
      <div className="rail-card-header rail-card-header--marketplaces">
        <span className="rail-card-accent" style={{ background: "#f5a623" }} />
        <span>Marketplaces</span>
        <button
          type="button"
          className="mp-sync-all-btn"
          onClick={onSyncAll}
          disabled={syncing}
          aria-label="Sync all marketplaces"
          title="Sync all marketplaces — walks every listing, drops rows the marketplace no longer has."
        >
          <RefreshIcon spinning={syncing} />
        </button>
      </div>

      <div className="mp-accordion">
        <MarketplaceRow
          id="etsy"
          label="Etsy"
          tone={etsyTone}
          metaLine={etsyMeta}
          externalUrl={etsyUrl || null}
          expanded={expanded === "etsy"}
          onToggle={() => toggle("etsy")}
        >
          <EtsyPanel alwaysOpen />
        </MarketplaceRow>

        <MarketplaceRow
          id="cults3d"
          label="Cults3D"
          tone={c3Tone}
          metaLine={c3Meta}
          expanded={expanded === "cults3d"}
          onToggle={() => toggle("cults3d")}
        >
          <UniformMarketplaceBody
            tabs={DEFAULT_PUBLISHED_TABS}
            emptyMsgWhenDisconnected="Connect Cults3D in Settings → Cross-marketplace"
            rows={(cults3d.rows ?? []).map((r) => ({
              id: r.id,
              title: r.title,
              state: r.state,
              url: r.url,
              error: r.error,
              price_usd: r.price_usd,
            }))}
            loading={cults3d.rows === null}
            todayCount={c3?.today_count ?? null}
            credsPresent={c3?.creds_present ?? false}
          />
        </MarketplaceRow>

        <MarketplaceRow
          id="sketchfab"
          label="Sketchfab"
          tone={sfTone}
          metaLine={sfMeta}
          expanded={expanded === "sketchfab"}
          onToggle={() => toggle("sketchfab")}
        >
          <UniformMarketplaceBody
            tabs={DEFAULT_PUBLISHED_TABS}
            emptyMsgWhenDisconnected="Connect Sketchfab in Settings → Cross-marketplace"
            rows={(sketchfab.rows ?? []).map((r) => ({
              id: r.id,
              title: r.title,
              state: r.state,
              url: r.url,
              error: r.error,
              warning: r.warning,
              price_usd: r.price_usd,
            }))}
            loading={sketchfab.rows === null}
            todayCount={sf?.today_count ?? null}
            credsPresent={sf?.creds_present ?? false}
          />
          <SketchfabFabHealAction credsPresent={sf?.creds_present ?? false} />
        </MarketplaceRow>

        <MarketplaceRow
          id="mmf"
          label="MyMiniFactory"
          tone={mmTone}
          metaLine={mmMeta}
          expanded={expanded === "mmf"}
          onToggle={() => toggle("mmf")}
        >
          <UniformMarketplaceBody
            tabs={DEFAULT_PUBLISHED_TABS}
            emptyMsgWhenDisconnected="Connect MyMiniFactory in Settings → Cross-marketplace"
            rows={(mmf.rows ?? []).map((r) => ({
              id: r.id,
              title: r.title,
              state: r.state,
              url: r.url,
              error: r.error,
              warning: r.warning,
              price_usd: r.price_usd,
            }))}
            loading={mmf.rows === null}
            todayCount={mm?.today_count ?? null}
            credsPresent={mm?.creds_present ?? false}
          />
        </MarketplaceRow>

        <MarketplaceRow
          id="gumroad"
          label="Gumroad"
          tone={gmTone}
          metaLine={gmMeta}
          expanded={expanded === "gumroad"}
          onToggle={() => toggle("gumroad")}
        >
          <UniformMarketplaceBody
            tabs={DEFAULT_PUBLISHED_TABS}
            emptyMsgWhenDisconnected="Connect Gumroad in Settings → Cross-marketplace"
            rows={(gumroad.rows ?? []).map((r) => ({
              id: r.id,
              title: r.title,
              state: r.state,
              url: r.short_url,
              error: r.error,
              warning: r.warning,
              price_usd: r.price_usd,
            }))}
            loading={gumroad.rows === null}
            todayCount={gm?.today_count ?? null}
            credsPresent={gm?.creds_present ?? false}
          />
        </MarketplaceRow>

        {/* Pinterest is a TRAFFIC channel, not a product marketplace. Sits
            at the bottom under a visual separator so the distinction
            reads at a glance. */}
        <div className="mp-divider" aria-hidden="true">
          <span>Traffic</span>
        </div>

        <MarketplaceRow
          id="pinterest"
          label="Pinterest"
          tone={piTone}
          metaLine={piMeta}
          expanded={expanded === "pinterest"}
          onToggle={() => toggle("pinterest")}
        >
          <UniformMarketplaceBody
            tabs={PINTEREST_TABS}
            emptyMsgWhenDisconnected="Connect Pinterest in Settings → Cross-marketplace"
            rows={(pinterest.pins ?? []).map((p) => ({
              id: p.id,
              title: p.title,
              state: p.state,
              url: p.url,
              error: p.error,
            }))}
            loading={pinterest.pins === null}
            todayCount={pi?.today_count ?? null}
            dailyCap={pi?.daily_cap ?? null}
            credsPresent={pi?.creds_present ?? false}
          />
        </MarketplaceRow>
      </div>
    </div>
  );
}
