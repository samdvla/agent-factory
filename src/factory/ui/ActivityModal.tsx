import { useEffect } from "react";
import ActivityFeed from "./ActivityFeed";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Full-screen modal wrapper around ActivityFeed. The rail item triggers this
 * instead of inline-expanding because the activity cards (SVG previews,
 * tag chips, descriptions) need real width to read well.
 */
export default function ActivityModal({ open, onClose }: Props) {
  // Esc to close, lock body scroll while open
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

  return (
    <div
      className="settings-back"
      role="dialog"
      aria-modal="true"
      aria-label="Activity — review agent outputs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="activity-modal">
        <div className="settings-modal-head">
          <div className="settings-modal-head-left">
            <span className="settings-modal-tag" style={{ color: "#b393f5", borderColor: "rgba(179, 147, 245, 0.3)", background: "rgba(179, 147, 245, 0.08)" }}>
              Review
            </span>
            <span className="settings-modal-title">Activity — every output, ratable for training</span>
          </div>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close activity"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="activity-modal-body">
          <ActivityFeed alwaysOpen wide />
        </div>
      </div>
    </div>
  );
}
