import { memo, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ListingReviewInfo, type JobAssetInfo } from "../../api";

/**
 * Pre-launch review modal — gates the Activate button for the first N
 * listings (configurable via the `first_listing_review_count` secret,
 * default 3). After N actives the modal still appears on click but the
 * headline switches from "First-listing review" to "Pre-publish review"
 * (informational, not blocking).
 *
 * Loads listing metadata + SVG asset + cycle financials in parallel on
 * mount. All fetch errors are non-fatal — the modal renders with whatever
 * fields resolved, missing values display as "—".
 */
export type ListingReviewMode = "drafts" | "queue" | "active" | "rejected";

type Props = {
  localListingId: number;
  fallbackTitle?: string;
  mode?: ListingReviewMode;
  onClose: () => void;
  onActivate: (localListingId: number) => Promise<void>;
};

type Working =
  | "activate"
  | "regenerate"
  | "reject"
  | "restore"
  | "cancel"
  | null;

function ListingReviewModalImpl({
  localListingId,
  fallbackTitle,
  mode = "drafts",
  onClose,
  onActivate,
}: Props) {
  const [info, setInfo] = useState<ListingReviewInfo | null>(null);
  const [asset, setAsset] = useState<JobAssetInfo | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [working, setWorking] = useState<Working>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const i = await api.etsyListingReviewInfo(localListingId);
        if (!cancelled) setInfo(i);
      } catch (e) {
        console.warn("review-info failed", e);
      }
      try {
        const a = await api.readListingAsset(localListingId);
        if (!cancelled) {
          setAsset(a);
          if (a.kind === "svg") {
            // Legacy path: only SVGs need raw markup for the inline render.
            try {
              const s = await api.readAssetSvg(localListingId);
              if (!cancelled) setSvg(s);
            } catch (e) {
              console.warn("read-asset-svg failed", e);
            }
          }
        }
      } catch (e) {
        console.warn("read-listing-asset failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localListingId]);

  const blocking =
    info !== null &&
    info.active_publish_count < info.first_listing_review_count;
  const headline = blocking ? "First-listing review" : "Pre-publish review";
  const sub = blocking
    ? `Listing ${info!.active_publish_count + 1} of ${info!.first_listing_review_count} pre-launch checks`
    : "Informational — additional review of an upcoming listing";

  const displayTitle = info?.title || fallbackTitle || "(no title)";
  const desc = info?.description || "";
  const tags = info?.tags ?? [];

  const onActivateClick = async () => {
    setWorking("activate");
    try {
      await onActivate(localListingId);
      onClose();
    } finally {
      setWorking(null);
    }
  };
  const onRegenerateClick = async () => {
    if (
      !window.confirm(
        "Queue this draft for regeneration? It moves to the Queue tab and a new draft will be produced.",
      )
    )
      return;
    setWorking("regenerate");
    try {
      await api.etsyRegenerateDraft(localListingId);
      onClose();
    } catch (e) {
      console.warn("regenerate draft failed", e);
    } finally {
      setWorking(null);
    }
  };
  const onRejectClick = async () => {
    if (
      !window.confirm(
        "Reject this idea? It moves to the Rejected tab and the orchestrator will steer away from similar niches.",
      )
    )
      return;
    setWorking("reject");
    try {
      await api.etsyRejectDraft(localListingId);
      onClose();
    } catch (e) {
      console.warn("reject draft failed", e);
    } finally {
      setWorking(null);
    }
  };
  const onRestoreClick = async () => {
    setWorking("restore");
    try {
      await api.etsyRestoreRejected(localListingId);
      onClose();
    } catch (e) {
      console.warn("restore rejected failed", e);
    } finally {
      setWorking(null);
    }
  };
  const onCancelRegenClick = async () => {
    if (
      !window.confirm(
        "Cancel this regeneration? The row moves to Rejected and the queued orchestrator job becomes a no-op.",
      )
    )
      return;
    setWorking("cancel");
    try {
      await api.etsyCancelRegeneration(localListingId);
      onClose();
    } catch (e) {
      console.warn("cancel regeneration failed", e);
    } finally {
      setWorking(null);
    }
  };

  const svgSrc = svg
    ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    : null;
  const is3d = asset?.kind === "glb" || asset?.kind === "stl";
  const glbDataUrl = useMemo(() => {
    if (!asset) return null;
    const b = asset.kind === "glb" ? asset.data_base64 : asset.glb_data_base64;
    return b ? `data:model/gltf-binary;base64,${b}` : null;
  }, [asset]);
  const pngDataUrl = useMemo(() => {
    if (!asset?.png_data_base64) return null;
    return `data:image/png;base64,${asset.png_data_base64}`;
  }, [asset]);
  const stlDataUrl = useMemo(() => {
    if (asset?.kind === "stl" && asset.data_base64)
      return `data:model/stl;base64,${asset.data_base64}`;
    return null;
  }, [asset]);

  return createPortal(
    <div className="review-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="review-modal" onClick={(e) => e.stopPropagation()}>
        <header className="review-modal-header">
          <div>
            <div className="review-modal-title">{headline}</div>
            <div className="review-modal-sub">{sub}</div>
          </div>
          <button
            type="button"
            className="review-modal-close"
            onClick={onClose}
            aria-label="Close review"
            title="Close"
          >
            ×
          </button>
        </header>

        <div className="review-modal-body">
          <div className="review-modal-left">
            {is3d ? (
              glbDataUrl ? (
                // @ts-expect-error custom-element JSX
                <model-viewer
                  src={glbDataUrl}
                  alt="3D listing asset preview"
                  camera-controls
                  auto-rotate
                  shadow-intensity="1"
                  className="review-modal-asset"
                  style={{
                    width: 320,
                    height: 320,
                    background: "#1a1d23",
                    borderRadius: 8,
                  }}
                />
              ) : pngDataUrl ? (
                <img
                  src={pngDataUrl}
                  alt="3D listing thumbnail"
                  className="review-modal-asset"
                  width={320}
                  height={320}
                />
              ) : (
                <div className="review-modal-asset-empty">3D asset (no preview)</div>
              )
            ) : svgSrc ? (
              <img
                src={svgSrc}
                alt="Listing asset preview"
                className="review-modal-asset"
                width={320}
                height={320}
              />
            ) : (
              <div className="review-modal-asset-empty">no asset</div>
            )}
            {is3d && (
              <div className="review-modal-3d-downloads">
                {stlDataUrl && (
                  <a
                    href={stlDataUrl}
                    download={`listing-${localListingId}.stl`}
                    className="asset-viewer-dl"
                  >
                    ↓ STL
                  </a>
                )}
                {glbDataUrl && (
                  <a
                    href={glbDataUrl}
                    download={`listing-${localListingId}.glb`}
                    className="asset-viewer-dl"
                  >
                    ↓ GLB
                  </a>
                )}
              </div>
            )}
            <div className="review-modal-meta">
              <div className="review-meta-row is-stacked" data-key="niche">
                <span className="review-meta-label">Niche</span>
                <span className="review-meta-value">{info?.niche || "—"}</span>
              </div>
              <div className="review-meta-row" data-key="cost">
                <span className="review-meta-label">Cost</span>
                <span className="review-meta-value">
                  {info?.total_cost_usd != null
                    ? `$${info.total_cost_usd.toFixed(2)}`
                    : "—"}
                </span>
              </div>
              <div className="review-meta-row" data-key="revenue">
                <span className="review-meta-label">Est. revenue</span>
                <span className="review-meta-value">
                  {info?.estimated_revenue_usd != null
                    ? `$${info.estimated_revenue_usd.toFixed(2)}`
                    : "—"}
                </span>
              </div>
              <div className="review-meta-row" data-key="net">
                <span className="review-meta-label">Projected net</span>
                <span
                  className={`review-meta-value${
                    info?.net_usd != null
                      ? info.net_usd >= 0
                        ? " is-gain"
                        : " is-loss"
                      : ""
                  }`}
                >
                  {info?.net_usd != null
                    ? `${info.net_usd >= 0 ? "+" : ""}$${info.net_usd.toFixed(2)}`
                    : "—"}
                </span>
              </div>
              {info?.cfo_rationale && (
                <div className="review-cfo">
                  <div className="review-meta-label">CFO rationale</div>
                  <div className="review-cfo-text">{info.cfo_rationale}</div>
                </div>
              )}
            </div>
          </div>

          <div className="review-modal-right">
            <div className="review-field">
              <div className="review-field-label">Title</div>
              <div className="review-field-title" title={displayTitle}>
                {displayTitle.length > 90
                  ? displayTitle.slice(0, 87) + "…"
                  : displayTitle}
              </div>
            </div>
            <div className="review-field">
              <div className="review-field-label">Description</div>
              <textarea
                className="review-field-desc"
                readOnly
                value={desc}
                placeholder="(no description recorded)"
              />
            </div>
            <div className="review-field">
              <div className="review-field-label">Tags</div>
              <div className="review-tags">
                {tags.length === 0 ? (
                  <span className="review-tag-empty">no tags</span>
                ) : (
                  tags.map((t, i) => (
                    <span key={`${t}-${i}`} className="review-tag">
                      {t}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <footer className="review-modal-footer">
          {mode === "drafts" && (
            <>
              <button
                type="button"
                className="review-btn is-regen"
                onClick={onRegenerateClick}
                disabled={working !== null}
                title="Queue this draft and enqueue a fresh cycle"
              >
                {working === "regenerate" ? "…" : "Regenerate"}
              </button>
              <button
                type="button"
                className="review-btn is-reject"
                onClick={onRejectClick}
                disabled={working !== null}
                title="Reject this idea — moves to Rejected tab and steers future cycles away"
              >
                {working === "reject" ? "…" : "Reject"}
              </button>
              <button
                type="button"
                className="review-btn is-activate"
                onClick={onActivateClick}
                disabled={working !== null}
              >
                {working === "activate" ? "…" : "Activate"}
              </button>
            </>
          )}
          {mode === "queue" && (
            <button
              type="button"
              className="review-btn is-reject"
              onClick={onCancelRegenClick}
              disabled={working !== null}
              title="Cancel this regeneration — moves row back to Rejected"
            >
              {working === "cancel" ? "…" : "Cancel regeneration"}
            </button>
          )}
          {mode === "rejected" && (
            <button
              type="button"
              className="review-btn is-activate"
              onClick={onRestoreClick}
              disabled={working !== null}
              title="Restore this listing to Drafts"
            >
              {working === "restore" ? "…" : "Restore to Drafts"}
            </button>
          )}
          {mode === "active" && (
            <button
              type="button"
              className="review-btn is-activate"
              onClick={onClose}
              disabled={working !== null}
              title="Close"
            >
              Close
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const ListingReviewModal = memo(ListingReviewModalImpl);
export default ListingReviewModal;
