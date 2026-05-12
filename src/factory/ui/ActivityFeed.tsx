import { memo, useCallback, useEffect, useMemo, useRef, useState, createContext, useContext } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type JobRow } from "../../api";

/** Context so deeply-nested role renderers can pop the SVG lightbox without prop drilling. */
const SvgLightboxCtx = createContext<((svg: string, label: string) => void) | null>(null);
function useOpenSvgLightbox() {
  return useContext(SvgLightboxCtx);
}

/**
 * Activity feed — every completed job, in reverse chronological order, with
 * the actual artifact each agent produced and a thumbs up/down rating that
 * persists to `job_feedback`. Designed so a non-technical operator (or
 * future boss-agent) can review what the factory is making and signal which
 * outputs are good. Ratings + notes are training data.
 *
 * SVGs come from an LLM, so we render them through an `<img>` data-URI
 * sandbox — that path disables script execution even if the model ever
 * emits a `<script>` or `onload` attribute. Never use
 * `dangerouslySetInnerHTML` for model-generated markup here.
 */

type RatingFilter = "all" | "up" | "down" | "unrated";

const ROLE_FILTERS: Array<{ id: string | null; label: string }> = [
  { id: null, label: "All" },
  { id: "research", label: "Research" },
  { id: "designer", label: "Designer" },
  { id: "listing", label: "Listing" },
  { id: "publisher", label: "Publisher" },
  { id: "cs", label: "CS" },
  { id: "cfo", label: "CFO" },
  { id: "orchestrator", label: "Strategy" },
  { id: "si", label: "Tuner" },
];

const RATING_FILTERS: Array<{ id: RatingFilter; label: string }> = [
  { id: "all", label: "All ratings" },
  { id: "up", label: "Thumbs up" },
  { id: "down", label: "Thumbs down" },
  { id: "unrated", label: "Unrated" },
];

const ROLE_COLORS: Record<string, string> = {
  research: "#5fd4f0",
  designer: "#b393f5",
  listing: "#e8d77b",
  publisher: "#f5a623",
  cs: "#9be0b3",
  cfo: "#ff8a93",
  orchestrator: "#5fd4f0",
  si: "#9b8cff",
};

function roleColor(role: string): string {
  return ROLE_COLORS[role] ?? "#7a8898";
}

function safeParse<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ts = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(ts)) return iso;
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function durationStr(
  started: string | null | undefined,
  finished: string | null | undefined,
): string | null {
  if (!started || !finished) return null;
  const s = Date.parse(started.includes("T") ? started : started.replace(" ", "T") + "Z");
  const f = Date.parse(finished.includes("T") ? finished : finished.replace(" ", "T") + "Z");
  if (Number.isNaN(s) || Number.isNaN(f) || f < s) return null;
  const ms = f - s;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Build a same-origin-safe data URI for SVG markup. `<img>` mode disables
 *  script execution even if the SVG contains `<script>` tags. */
function svgDataUri(svg: string): string {
  // Strip any leading XML declaration and whitespace to keep the URI tight.
  const trimmed = svg.replace(/^<\?xml[^?]*\?>\s*/i, "").trim();
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(trimmed)))}`;
}

/* ───── Role renderers ───────────────────────────────────────────────── */

function ResearchOutput({ result }: { result: any }) {
  const brief = result?.brief ?? {};
  const niche = brief.niche ?? "—";
  const kws: string[] = Array.isArray(brief.keywords) ? brief.keywords : [];
  const band = brief.price_band_usd;
  const comp = brief.competition ?? "—";
  const rationale = brief.rationale ?? "";
  return (
    <div className="af-body">
      <div className="af-niche">{niche}</div>
      <div className="af-meta">
        <span>{comp} comp</span>
        {Array.isArray(band) && band.length === 2 && (
          <span>
            ${band[0]}–{band[1]}
          </span>
        )}
      </div>
      {kws.length > 0 && (
        <div className="af-chips">
          {kws.slice(0, 8).map((k, i) => (
            <span key={i} className="af-chip">
              {k}
            </span>
          ))}
          {kws.length > 8 && <span className="af-chip is-dim">+{kws.length - 8}</span>}
        </div>
      )}
      {rationale && <div className="af-rationale">{rationale}</div>}
    </div>
  );
}

function SvgLightbox({ svg, label, onClose }: { svg: string; label: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div
      className="svg-lightbox-back"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <button type="button" className="svg-lightbox-close" onClick={onClose} aria-label="Close">×</button>
      <div className="svg-lightbox-stage">
        <img className="svg-lightbox-img" src={svgDataUri(svg)} alt={label} />
        <div className="svg-lightbox-caption">{label}</div>
      </div>
    </div>
  );
}

function DesignerOutput({ result, jobId }: { result: any; jobId: number }) {
  const asset = result?.asset ?? {};
  const palette: string[] = Array.isArray(asset.palette) ? asset.palette : [];
  const dims = asset.dimensions ?? "";
  const style = asset.style ?? "";
  const briefForImage = asset.brief_for_image_gen ?? "";
  const hasAsset = typeof asset.asset_path === "string" && asset.asset_path.length > 0;
  const openLightbox = useOpenSvgLightbox();
  const [svg, setSvg] = useState<string | null>(null);
  const [svgLoaded, setSvgLoaded] = useState(false);
  useEffect(() => {
    if (!hasAsset) return;
    let cancelled = false;
    api
      .readJobSvg(jobId)
      .then((v) => {
        if (!cancelled) {
          setSvg(v);
          setSvgLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setSvgLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, hasAsset]);
  return (
    <div className="af-body af-body--designer">
      <div className="af-preview">
        {hasAsset ? (
          svg ? (
            <button
              type="button"
              className="af-svg-tile-btn"
              onClick={() => openLightbox?.(svg, `designer #${jobId} · ${dims || "preview"}`)}
              title="Click to enlarge"
            >
              <img
                className="af-svg-tile"
                src={svgDataUri(svg)}
                alt="Designer SVG preview"
              />
              <span className="af-svg-zoom-hint" aria-hidden>⤢</span>
            </button>
          ) : svgLoaded ? (
            <div className="af-svg-tile is-empty">file missing</div>
          ) : (
            <div className="af-svg-tile is-loading">…</div>
          )
        ) : (
          <div className="af-svg-tile is-empty" title="The designer's SVG step failed or was truncated; only the text brief was produced">
            no svg yet
          </div>
        )}
      </div>
      <div className="af-meta-block">
        {dims && <div className="af-meta">{dims}</div>}
        {style && <div className="af-style">{style}</div>}
        {palette.length > 0 && (
          <div className="af-palette" aria-label="Palette">
            {palette.map((p, i) => (
              <span
                key={i}
                className="af-swatch"
                style={{ background: p }}
                title={p}
              />
            ))}
          </div>
        )}
        {briefForImage && <div className="af-rationale">{briefForImage}</div>}
      </div>
    </div>
  );
}

function ListingOutput({ result }: { result: any }) {
  const listing = result?.listing ?? {};
  const title = listing.title ?? "—";
  const desc = listing.description ?? "";
  const tags: string[] = Array.isArray(listing.tags) ? listing.tags : [];
  const price = listing.price_usd;
  return (
    <div className="af-body">
      <div className="af-title">{title}</div>
      <div className="af-meta">
        {typeof price === "number" && <span>${price.toFixed(2)}</span>}
      </div>
      {desc && <div className="af-desc">{desc}</div>}
      {tags.length > 0 && (
        <div className="af-chips">
          {tags.map((t, i) => (
            <span key={i} className="af-chip">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PublisherOutput({ result, jobId }: { result: any; jobId: number }) {
  const listingId = result?.listing_id ?? "—";
  const title = result?.title ?? "";
  const price = result?.price_usd;
  const tags: string[] = Array.isArray(result?.tags) ? result.tags : [];
  const niche = typeof result?.niche === "string" ? result.niche : null;
  const description = typeof result?.description === "string" ? result.description : "";
  const hasAsset = typeof result?.asset_path === "string" && result.asset_path.length > 0;
  const openLightbox = useOpenSvgLightbox();
  const [svg, setSvg] = useState<string | null>(null);
  const [svgLoaded, setSvgLoaded] = useState(false);
  useEffect(() => {
    if (!hasAsset) return;
    let cancelled = false;
    api
      .readJobSvg(jobId)
      .then((v) => {
        if (!cancelled) {
          setSvg(v);
          setSvgLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setSvgLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, hasAsset]);
  return (
    <div className="af-body af-body--designer">
      <div className="af-preview">
        {hasAsset ? (
          svg ? (
            <button
              type="button"
              className="af-svg-tile-btn"
              onClick={() => openLightbox?.(svg, `publisher #${jobId} · ${title || `Listing #${listingId}`}`)}
              title="Click to enlarge"
            >
              <img
                className="af-svg-tile"
                src={svgDataUri(svg)}
                alt="Final product preview"
              />
              <span className="af-svg-zoom-hint" aria-hidden>⤢</span>
            </button>
          ) : svgLoaded ? (
            <div className="af-svg-tile is-empty">file missing</div>
          ) : (
            <div className="af-svg-tile is-loading">…</div>
          )
        ) : (
          <div className="af-svg-tile is-empty" title="Listing published without an SVG asset (text-only listing)">
            no svg
          </div>
        )}
      </div>
      <div className="af-meta-block">
        <div className="af-title">{title || `Listing #${listingId}`}</div>
        <div className="af-meta">
          <span>local #{listingId}</span>
          {typeof price === "number" && <span>${price.toFixed(2)}</span>}
          {niche && <span>{niche}</span>}
        </div>
        {description && <div className="af-desc">{description}</div>}
        {tags.length > 0 && (
          <div className="af-chips">
            {tags.slice(0, 8).map((t, i) => (
              <span key={i} className="af-chip">
                {t}
              </span>
            ))}
            {tags.length > 8 && (
              <span className="af-chip is-dim">+{tags.length - 8}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CsOutput({ result }: { result: any }) {
  const reply = result?.reply ?? "";
  const conv = result?.conversation_id;
  const esc = result?.escalate === true;
  return (
    <div className="af-body">
      <div className="af-meta">
        {typeof conv === "number" && <span>conv #{conv}</span>}
        {esc && <span className="af-tag-escalate">escalated</span>}
      </div>
      {reply && <div className="af-desc">{reply}</div>}
    </div>
  );
}

function CfoOutput({ result }: { result: any }) {
  const cycle = (result?.cycle_id ?? "").toString().slice(0, 8);
  const rev = result?.gross_usd ?? result?.revenue_usd;
  const cost = result?.total_cost_usd;
  const net = result?.net_usd;
  const rationale = result?.rationale ?? "";
  return (
    <div className="af-body">
      <div className="af-meta">
        {cycle && <span>cycle {cycle}</span>}
        {typeof rev === "number" && <span>rev ${rev.toFixed(2)}</span>}
        {typeof cost === "number" && <span>cost ${cost.toFixed(2)}</span>}
        {typeof net === "number" && (
          <span className={net >= 0 ? "af-net-pos" : "af-net-neg"}>
            net {net >= 0 ? "+" : ""}${net.toFixed(2)}
          </span>
        )}
      </div>
      {rationale && <div className="af-rationale">{rationale}</div>}
    </div>
  );
}

function OrchestratorOutput({ result }: { result: any }) {
  const niche = result?.niche_seed ?? result?.niche ?? "—";
  const rationale = result?.rationale ?? "";
  return (
    <div className="af-body">
      <div className="af-niche">{niche}</div>
      {rationale && <div className="af-rationale">{rationale}</div>}
    </div>
  );
}

function SiOutput({ result }: { result: any }) {
  const role = result?.role_tweaked ?? result?.target_role ?? "—";
  const rationale = result?.rationale ?? "";
  return (
    <div className="af-body">
      <div className="af-meta">
        <span>tweaked {role}</span>
      </div>
      {rationale && <div className="af-rationale">{rationale}</div>}
    </div>
  );
}

function FallbackOutput({ result }: { result: any }) {
  if (!result) return <div className="af-body is-empty">no result</div>;
  const ticker = typeof result.ticker_text === "string" ? result.ticker_text : null;
  return (
    <div className="af-body">
      {ticker && <div className="af-rationale">{ticker}</div>}
      <pre className="af-json">{JSON.stringify(result, null, 2).slice(0, 400)}</pre>
    </div>
  );
}

function ErrorOutput({ row }: { row: JobRow }) {
  const result = safeParse<any>(row.result_json);
  const msg = row.error ?? (result?.error as string | undefined) ?? "unknown error";
  return (
    <div className="af-body">
      <div className="af-error">{msg}</div>
    </div>
  );
}

/* ───── Card ─────────────────────────────────────────────────────────── */

function JobCard({
  row,
  onRate,
  onOpenEtsy,
}: {
  row: JobRow;
  onRate: (jobId: number, rating: "up" | "down" | null, note?: string | null) => Promise<void>;
  onOpenEtsy: (url: string) => void;
}) {
  const result = safeParse<any>(row.result_json);
  const dur = durationStr(row.started_at, row.finished_at);
  const finished = row.finished_at ?? row.scheduled_at;
  const errored = row.status === "errored" || (result && result.ok === false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(row.rating_note ?? "");
  useEffect(() => {
    setNoteDraft(row.rating_note ?? "");
  }, [row.rating_note]);
  const [busy, setBusy] = useState<"up" | "down" | "clear" | null>(null);

  const flip = useCallback(
    async (next: "up" | "down") => {
      const target = row.rating === next ? null : next;
      setBusy(target ?? "clear");
      try {
        await onRate(row.id, target, noteDraft || null);
      } finally {
        setBusy(null);
      }
    },
    [row.id, row.rating, noteDraft, onRate],
  );

  const saveNote = useCallback(async () => {
    if (!row.rating) return; // nothing to attach the note to yet
    setBusy("clear");
    try {
      await onRate(row.id, row.rating, noteDraft || null);
    } finally {
      setBusy(null);
    }
  }, [row.id, row.rating, noteDraft, onRate]);

  const etsyUrl: string | undefined =
    row.agent_role === "publisher"
      ? typeof result?.url === "string"
        ? result.url
        : undefined
      : undefined;

  return (
    <article
      className={`af-card${errored ? " is-errored" : ""}${
        row.rating ? ` is-rated-${row.rating}` : ""
      }`}
      style={{ "--role-color": roleColor(row.agent_role) } as React.CSSProperties}
    >
      <header className="af-head">
        <span className="af-role-pill">{row.agent_role}</span>
        <span className="af-job-id">#{row.id}</span>
        <span className="af-rel">{relTime(finished)}</span>
        {dur && <span className="af-dur">{dur}</span>}
        {etsyUrl && (
          <button
            type="button"
            className="af-etsy-link"
            onClick={() => onOpenEtsy(etsyUrl)}
            title="Open on Etsy"
          >
            View on Etsy ↗
          </button>
        )}
      </header>

      {errored ? (
        <ErrorOutput row={row} />
      ) : row.agent_role === "research" ? (
        <ResearchOutput result={result} />
      ) : row.agent_role === "designer" ? (
        <DesignerOutput result={result} jobId={row.id} />
      ) : row.agent_role === "listing" ? (
        <ListingOutput result={result} />
      ) : row.agent_role === "publisher" ? (
        <PublisherOutput result={result} jobId={row.id} />
      ) : row.agent_role === "cs" ? (
        <CsOutput result={result} />
      ) : row.agent_role === "cfo" ? (
        <CfoOutput result={result} />
      ) : row.agent_role === "orchestrator" ? (
        <OrchestratorOutput result={result} />
      ) : row.agent_role === "si" ? (
        <SiOutput result={result} />
      ) : (
        <FallbackOutput result={result} />
      )}

      <footer className="af-foot">
        <button
          type="button"
          className={`af-rate af-rate--up${row.rating === "up" ? " is-active" : ""}`}
          onClick={() => flip("up")}
          disabled={busy !== null}
          title="Good output"
          aria-pressed={row.rating === "up"}
        >
          <span className="af-rate-glyph" aria-hidden="true">
            ▲
          </span>
          <span>good</span>
        </button>
        <button
          type="button"
          className={`af-rate af-rate--down${row.rating === "down" ? " is-active" : ""}`}
          onClick={() => flip("down")}
          disabled={busy !== null}
          title="Needs work"
          aria-pressed={row.rating === "down"}
        >
          <span className="af-rate-glyph" aria-hidden="true">
            ▼
          </span>
          <span>needs work</span>
        </button>
        <button
          type="button"
          className={`af-note-toggle${noteOpen ? " is-open" : ""}`}
          onClick={() => setNoteOpen((v) => !v)}
          title={row.rating_note ? "Edit note" : "Add note"}
        >
          {row.rating_note ? "edit note" : "+ note"}
        </button>
        {row.rating_note && !noteOpen && (
          <span className="af-note-preview" title={row.rating_note}>
            {row.rating_note}
          </span>
        )}
      </footer>

      {noteOpen && (
        <div className="af-note-row">
          <textarea
            className="af-note-input"
            placeholder={
              row.rating
                ? "Why? (helps training)"
                : "Rate first, then add a note"
            }
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={2}
          />
          <button
            type="button"
            className="af-note-save"
            onClick={async () => {
              await saveNote();
              setNoteOpen(false);
            }}
            disabled={!row.rating || busy !== null}
          >
            save
          </button>
        </div>
      )}
    </article>
  );
}

const JobCardMemo = memo(JobCard);

/* ───── Main ─────────────────────────────────────────────────────────── */

export interface ActivityFeedProps {
  alwaysOpen?: boolean;
  /** Use the wide modal layout (bigger SVG tiles, larger type, more breathing room). */
  wide?: boolean;
}

export default function ActivityFeed({ alwaysOpen, wide }: ActivityFeedProps) {
  const [rows, setRows] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [lightbox, setLightbox] = useState<{ svg: string; label: string } | null>(null);
  const openLightbox = useCallback((svg: string, label: string) => setLightbox({ svg, label }), []);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listRecentJobs({ limit: 100 });
      setRows(data);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch on JobCompleted/JobFailed so new outputs surface immediately.
  // Debounce to avoid hammering the DB during smoke bursts.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    const schedule = () => {
      if (refreshTimer.current !== null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        refresh();
      }, 600);
    };
    listen<{ kind: string }>("supervisor:event", (e) => {
      if (
        e.payload.kind === "job_completed" ||
        e.payload.kind === "job_failed"
      ) {
        schedule();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refresh]);

  const rate = useCallback(
    async (jobId: number, rating: "up" | "down" | null, note?: string | null) => {
      // Optimistic update: patch the row, then call backend, then refetch.
      setRows((prev) =>
        prev.map((r) =>
          r.id === jobId
            ? {
                ...r,
                rating,
                rating_note: note ?? r.rating_note ?? null,
                rated_at: Math.floor(Date.now() / 1000),
              }
            : r,
        ),
      );
      try {
        await api.rateJob(jobId, rating, note ?? null);
      } catch (e) {
        console.warn("rate_job failed; refetching", e);
        refresh();
      }
    },
    [refresh],
  );

  const openEtsy = useCallback((url: string) => {
    openUrl(url).catch((e) => console.warn("openUrl failed", e));
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (roleFilter && r.agent_role !== roleFilter) return false;
      switch (ratingFilter) {
        case "up":
          return r.rating === "up";
        case "down":
          return r.rating === "down";
        case "unrated":
          return r.rating === null;
        default:
          return true;
      }
    });
  }, [rows, roleFilter, ratingFilter]);

  const counts = useMemo(() => {
    const c = { up: 0, down: 0, unrated: 0, total: rows.length };
    for (const r of rows) {
      if (r.rating === "up") c.up += 1;
      else if (r.rating === "down") c.down += 1;
      else c.unrated += 1;
    }
    return c;
  }, [rows]);

  return (
    <SvgLightboxCtx.Provider value={openLightbox}>
    <div className={`af-panel${alwaysOpen ? " is-always-open" : ""}${wide ? " is-wide" : ""}`}>
      <div className="af-controls">
        <div className="af-chip-row">
          {ROLE_FILTERS.map((f) => (
            <button
              key={f.id ?? "all"}
              type="button"
              className={`af-filter${roleFilter === f.id ? " is-active" : ""}`}
              onClick={() => setRoleFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="af-chip-row">
          {RATING_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`af-filter af-filter--rating${
                ratingFilter === f.id ? " is-active" : ""
              }`}
              onClick={() => setRatingFilter(f.id)}
            >
              {f.label}
              {f.id !== "all" && (
                <span className="af-filter-count">
                  {f.id === "up"
                    ? counts.up
                    : f.id === "down"
                      ? counts.down
                      : counts.unrated}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="af-refresh"
            onClick={refresh}
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {error && <div className="af-error-banner">{error}</div>}

      {loading ? (
        <div className="af-empty">loading…</div>
      ) : filtered.length === 0 ? (
        <div className="af-empty">
          {rows.length === 0
            ? "No completed jobs yet — start the supervisor or run a smoke-test cycle."
            : "No jobs match the current filters."}
        </div>
      ) : (
        <div className="af-list">
          {filtered.map((r) => (
            <JobCardMemo
              key={r.id}
              row={r}
              onRate={rate}
              onOpenEtsy={openEtsy}
            />
          ))}
        </div>
      )}
      {lightbox && (
        <SvgLightbox svg={lightbox.svg} label={lightbox.label} onClose={() => setLightbox(null)} />
      )}
    </div>
    </SvgLightboxCtx.Provider>
  );
}
