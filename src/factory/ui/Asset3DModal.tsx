import { useEffect, useMemo, useState, useCallback } from "react";
import { api, type JobAssetInfo } from "../../api";

interface Props {
  /** Job id to load the asset from. Closed (null) when not viewing anything. */
  jobId: number | null;
  /** Optional pre-fetched asset so we don't re-fetch on open. */
  preloaded?: JobAssetInfo | null;
  /** Optional title shown in the modal header. */
  title?: string;
  /** Optional extra preview PNGs (multi-angle renders) the modal can flip
   *  through alongside the live 3D model. Paths are filesystem paths; the
   *  modal converts them via cmd_read_job_asset's sibling-png field for the
   *  primary thumbnail, and uses asset host URLs for the extras when those
   *  are reachable. For the local-only assets we have today, only the
   *  primary png is available via the inline data URL — so the multi-angle
   *  list is shown as a thumbnail strip beneath the 3D viewer. */
  onClose: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Fullscreen modal that renders a job's 3D asset in an orbit-capable viewer.
 *
 * Why a dedicated modal instead of just expanding the inline viewer:
 *  - The compact card viewer is 200px — enough to confirm the model is
 *    there, not enough to actually inspect topology / proportions.
 *  - The user wants the "open .glb in a 3D viewer" feel: full-bleed canvas,
 *    proper orbit + zoom + reset, no surrounding card chrome.
 *  - Multi-angle PNGs (the 5 renders we already produce) deserve a place
 *    too — they're the static fallback when GLB inlining failed, and they
 *    double as quick angle-jump bookmarks when the model is loaded.
 *
 * Wiring:
 *  - Open with `<Asset3DModal jobId={42} onClose={...} />`
 *  - The modal fetches the asset itself if no `preloaded` is passed,
 *    matching AssetViewer's behavior so callers can pick the cheaper path.
 *  - ESC + click-on-backdrop both close.
 */
export default function Asset3DModal({ jobId, preloaded, title, onClose }: Props) {
  const [info, setInfo] = useState<JobAssetInfo | null>(preloaded ?? null);
  const [loading, setLoading] = useState(jobId !== null && !preloaded);
  const [err, setErr] = useState<string | null>(null);

  // Fetch the asset whenever jobId flips. Cancel-safe on unmount so the
  // modal can be opened/closed rapidly without leaked state writes.
  useEffect(() => {
    if (jobId === null) return;
    if (preloaded) {
      setInfo(preloaded);
      setLoading(false);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .readJobAsset(jobId)
      .then((v) => {
        if (!cancelled) {
          setInfo(v);
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, preloaded]);

  // ESC closes — standard modal contract. Also prevents scroll bleed-through
  // on the body while the modal is open.
  useEffect(() => {
    if (jobId === null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [jobId, onClose]);

  const glbDataUrl = useMemo(() => {
    if (!info) return null;
    const b = info.kind === "glb" ? info.data_base64 : info.glb_data_base64;
    return b ? `data:model/gltf-binary;base64,${b}` : null;
  }, [info]);

  const stlDataUrl = useMemo(() => {
    if (!info || info.kind !== "stl" || !info.data_base64) return null;
    return `data:model/stl;base64,${info.data_base64}`;
  }, [info]);

  const pngDataUrl = useMemo(() => {
    if (!info) return null;
    const b = info.kind === "png" ? info.data_base64 : info.png_data_base64;
    return b ? `data:image/png;base64,${b}` : null;
  }, [info]);

  // The model-viewer custom element exposes imperative camera controls via
  // a ref. We use it to expose preset angles + a "reset" button so users
  // can snap back to the canonical view without dragging.
  const setCameraOrbit = useCallback((orbit: string) => {
    const el = document.querySelector<HTMLElement & { cameraOrbit?: string }>(
      "#asset-3d-modal-viewer",
    );
    if (el) {
      // model-viewer reads the attribute; set both DOM attr and JS prop so
      // it reacts whether or not it's hydrated.
      el.setAttribute("camera-orbit", orbit);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).cameraOrbit = orbit;
    }
  }, []);

  if (jobId === null) return null;

  return (
    <div
      className="asset-3d-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Inspect 3D asset"
    >
      <div className="asset-3d-modal">
        <header className="asset-3d-modal-header">
          <div className="asset-3d-modal-title">
            {title ?? `Job #${jobId} — 3D asset`}
          </div>
          <button
            type="button"
            className="asset-3d-modal-close"
            onClick={onClose}
            aria-label="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div className="asset-3d-modal-body">
          {loading && <div className="asset-3d-modal-status">Loading model…</div>}
          {err && <div className="asset-3d-modal-status is-error">{err}</div>}

          {!loading && !err && info && (
            <>
              {glbDataUrl ? (
                // @ts-expect-error custom element JSX
                <model-viewer
                  id="asset-3d-modal-viewer"
                  src={glbDataUrl}
                  alt="3D asset full inspection"
                  camera-controls
                  // No auto-rotate in the modal — the user came here to
                  // inspect, not to watch it spin. They can grab + drag.
                  shadow-intensity="1.4"
                  exposure="1.0"
                  environment-image="neutral"
                  interaction-prompt="auto"
                  interaction-prompt-style="basic"
                  min-camera-orbit="auto auto 5%"
                  max-camera-orbit="auto auto 400%"
                  className="asset-3d-modal-viewer"
                />
              ) : pngDataUrl ? (
                <div className="asset-3d-modal-fallback">
                  <img
                    src={pngDataUrl}
                    alt="3D asset thumbnail (no GLB available)"
                    className="asset-3d-modal-fallback-img"
                  />
                  <div className="asset-3d-modal-fallback-note">
                    Live 3D preview unavailable — file is{" "}
                    {fmtBytes(info.bytes)} (over the 50 MB inline cap) or no
                    sibling GLB was produced. Static thumbnail shown.
                  </div>
                </div>
              ) : (
                <div className="asset-3d-modal-status is-error">
                  No renderable preview ({fmtBytes(info.bytes)},{" "}
                  {info.kind.toUpperCase()}).
                </div>
              )}
            </>
          )}
        </div>

        {!loading && !err && info && glbDataUrl && (
          <div className="asset-3d-modal-controls">
            <div className="asset-3d-modal-control-group">
              <span className="asset-3d-modal-control-label">Snap to</span>
              <button
                type="button"
                className="asset-3d-modal-angle-btn"
                onClick={() => setCameraOrbit("0deg 80deg auto")}
              >
                Front
              </button>
              <button
                type="button"
                className="asset-3d-modal-angle-btn"
                onClick={() => setCameraOrbit("-45deg 75deg auto")}
              >
                ¾ Right
              </button>
              <button
                type="button"
                className="asset-3d-modal-angle-btn"
                onClick={() => setCameraOrbit("-90deg 90deg auto")}
              >
                Side
              </button>
              <button
                type="button"
                className="asset-3d-modal-angle-btn"
                onClick={() => setCameraOrbit("180deg 80deg auto")}
              >
                Back
              </button>
              <button
                type="button"
                className="asset-3d-modal-angle-btn"
                onClick={() => setCameraOrbit("0deg 0deg auto")}
              >
                Top
              </button>
              <button
                type="button"
                className="asset-3d-modal-angle-btn is-primary"
                onClick={() => setCameraOrbit("0deg 75deg 105%")}
              >
                Reset
              </button>
            </div>

            <div className="asset-3d-modal-control-group">
              <span className="asset-3d-modal-meta">
                {info.kind.toUpperCase()} · {fmtBytes(info.bytes)}
              </span>
              {stlDataUrl && (
                <a
                  href={stlDataUrl}
                  download={`asset-${jobId}.stl`}
                  className="asset-3d-modal-dl"
                >
                  ↓ STL
                </a>
              )}
              {glbDataUrl && (
                <a
                  href={glbDataUrl}
                  download={`asset-${jobId}.glb`}
                  className="asset-3d-modal-dl"
                >
                  ↓ GLB
                </a>
              )}
              {pngDataUrl && (
                <a
                  href={pngDataUrl}
                  download={`asset-${jobId}.png`}
                  className="asset-3d-modal-dl"
                >
                  ↓ PNG
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
