import { useEffect } from "react";
import { createPortal } from "react-dom";
import ActivityFeed from "./ActivityFeed";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Centered, portal-rendered Activity review surface. Uses the same overlay /
 * frame as ListingReviewModal so every modal in the app shares one design
 * language. The portal escape is load-bearing: the CommandRail has
 * backdrop-filter, which creates a containing block for fixed-position
 * descendants — rendering this inline would clip it to the rail's box.
 */
export default function ActivityModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="review-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Activity — review agent outputs"
      onClick={onClose}
    >
      <div
        className="review-modal review-modal--wide"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="review-modal-header">
          <div>
            <div className="review-modal-title">Activity</div>
            <div className="review-modal-sub">
              Every agent output — rate up/down to teach the strategist
            </div>
          </div>
          <button
            type="button"
            className="review-modal-close"
            onClick={onClose}
            aria-label="Close activity"
            title="Close"
          >
            ×
          </button>
        </header>
        <div className="review-modal-pane">
          <ActivityFeed alwaysOpen wide />
        </div>
      </div>
    </div>,
    document.body,
  );
}
