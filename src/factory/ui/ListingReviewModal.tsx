import { memo, useEffect, useState } from "react";
import { api, type ListingReviewInfo } from "../../api";

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
type Props = {
  localListingId: number;
  fallbackTitle?: string;
  onClose: () => void;
  onActivate: (localListingId: number) => Promise<void>;
};

function ListingReviewModalImpl({
  localListingId,
  fallbackTitle,
  onClose,
  onActivate,
}: Props) {
  const [info, setInfo] = useState<ListingReviewInfo | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [working, setWorking] = useState<"activate" | "discard" | null>(null);

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
        const s = await api.readAssetSvg(localListingId);
        if (!cancelled) setSvg(s);
      } catch (e) {
        console.warn("read-asset-svg failed", e);
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
  const onDiscardClick = async () => {
    if (!window.confirm("Discard this draft and request a fresh cycle?"))
      return;
    setWorking("discard");
    try {
      await api.etsyDiscardDraft(localListingId);
      onClose();
    } catch (e) {
      console.warn("discard draft failed", e);
    } finally {
      setWorking(null);
    }
  };

  const svgSrc = svg
    ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    : null;

  return (
    <div className="review-modal-overlay" role="dialog" aria-modal="true">
      <div className="review-modal">
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
            {svgSrc ? (
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
            <div className="review-modal-meta">
              <div className="review-meta-row">
                <span className="review-meta-label">Niche</span>
                <span className="review-meta-value">{info?.niche || "—"}</span>
              </div>
              <div className="review-meta-row">
                <span className="review-meta-label">Cost</span>
                <span className="review-meta-value">
                  {info?.total_cost_usd != null
                    ? `$${info.total_cost_usd.toFixed(2)}`
                    : "—"}
                </span>
              </div>
              <div className="review-meta-row">
                <span className="review-meta-label">Est. revenue</span>
                <span className="review-meta-value">
                  {info?.estimated_revenue_usd != null
                    ? `$${info.estimated_revenue_usd.toFixed(2)}`
                    : "—"}
                </span>
              </div>
              <div className="review-meta-row">
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
          <button
            type="button"
            className="review-btn is-regen"
            onClick={onDiscardClick}
            disabled={working !== null}
            title="Discard this draft and enqueue a fresh cycle"
          >
            {working === "discard" ? "…" : "Regenerate"}
          </button>
          <button
            type="button"
            className="review-btn is-skip"
            onClick={onClose}
            disabled={working !== null}
          >
            Skip
          </button>
          <button
            type="button"
            className="review-btn is-activate"
            onClick={onActivateClick}
            disabled={working !== null}
          >
            {working === "activate" ? "…" : "Activate"}
          </button>
        </footer>
      </div>
    </div>
  );
}

const ListingReviewModal = memo(ListingReviewModalImpl);
export default ListingReviewModal;
