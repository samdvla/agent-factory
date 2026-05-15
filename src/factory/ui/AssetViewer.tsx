import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type JobAssetInfo } from "../../api";

interface Props {
  jobId: number;
  /** Optional explicit kind hint (used by callers that already know the file
   *  extension — saves a Tauri round-trip if `assetInfo` is also supplied). */
  kind?: string;
  /** Pre-fetched asset info to render without re-hitting the backend. */
  preloaded?: JobAssetInfo | null;
  /** Compact height for activity-feed cards; full size for review modal. */
  compact?: boolean;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Universal asset preview. Auto-routes by `info.kind`:
 *  - svg → inline SVG (existing behavior)
 *  - glb → <model-viewer> with the GLB inlined as a data URL
 *  - stl → <model-viewer> using the sibling GLB when available; PNG preview
 *          otherwise. STL itself is always offered as a download.
 *  - png → <img>
 *  - none → "no asset" placeholder
 */
export default function AssetViewer({ jobId, preloaded, compact }: Props) {
  const [info, setInfo] = useState<JobAssetInfo | null>(preloaded ?? null);
  const [loading, setLoading] = useState(!preloaded);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (preloaded !== undefined && preloaded !== null) return;
    let cancelled = false;
    setLoading(true);
    api
      .readJobAsset(jobId)
      .then((v) => {
        if (!cancelled) {
          setInfo(v);
          setErr(null);
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

  // Prefer streaming the GLB from disk via Tauri's asset protocol — this
  // is what makes the auto-rotating thumbnail work for jobs whose GLB is
  // over the 8 MB inline cap (90 MB+ Meshy outputs). Falls back to the
  // inline base64 only when no on-disk path was returned.
  const glbSrc = useMemo(() => {
    if (!info) return null;
    const path = info.kind === "glb" ? info.path : info.glb_path;
    if (path) return convertFileSrc(path);
    const b = info.kind === "glb" ? info.data_base64 : info.glb_data_base64;
    return b ? `data:model/gltf-binary;base64,${b}` : null;
  }, [info]);

  const stlDataUrl = useMemo(() => {
    if (!info || info.kind !== "stl" || !info.data_base64) return null;
    return `data:model/stl;base64,${info.data_base64}`;
  }, [info]);

  const pngSrc = useMemo(() => {
    if (!info) return null;
    if (info.kind === "png" && info.path) return convertFileSrc(info.path);
    const b = info.kind === "png" ? info.data_base64 : info.png_data_base64;
    return b ? `data:image/png;base64,${b}` : null;
  }, [info]);

  if (loading) {
    return <div className="asset-viewer asset-viewer--loading">Loading asset…</div>;
  }
  if (err) {
    return <div className="asset-viewer asset-viewer--error">Asset load failed: {err}</div>;
  }
  if (!info || info.kind === "none") {
    return <div className="asset-viewer asset-viewer--empty">No asset for this job</div>;
  }

  const height = compact ? 200 : 480;

  // GLB or STL — render via model-viewer. STL falls back to PNG when the
  // sibling GLB isn't available. Both compact and full mode enable
  // camera-controls so the user can drag-orbit even in the activity-feed
  // thumbnail; the wrapper (ActivityFeed.JobAssetPreview) tells a quick
  // tap from a drag and opens the fullscreen modal only on a tap.
  if (info.kind === "glb" || info.kind === "stl") {
    // Compact thumbnails (activity-feed cards) cheap out on shadow + use a
    // softer auto-rotate cadence so the small viewport stays smooth even on
    // a 90 MB GLB. Full-size review keeps the higher-quality settings.
    const shadow = compact ? "0" : "1";
    const exposure = compact ? "0.95" : "1.0";
    const rotateDelay = compact ? "0" : "3000";
    const rotateSpeed = compact ? "20deg" : "30deg";
    return (
      <div className={`asset-viewer asset-viewer--3d${compact ? " is-compact" : ""}`}>
        {glbSrc ? (
          <Glb3dThumb
            src={glbSrc}
            posterSrc={pngSrc}
            height={height}
            shadow={shadow}
            exposure={exposure}
            rotateDelay={rotateDelay}
            rotateSpeed={rotateSpeed}
            bytes={info.bytes}
            compact={!!compact}
          />
        ) : pngSrc ? (
          <img
            src={pngSrc}
            alt="3D asset thumbnail (no GLB available)"
            style={{
              width: "100%",
              height: `${height}px`,
              objectFit: "contain",
              background: "#1a1d23",
              display: "block",
            }}
          />
        ) : (
          <div className="asset-viewer--empty" style={{ height }}>
            No renderable preview (asset is {fmtBytes(info.bytes)}; over inline cap)
          </div>
        )}
        <div className="asset-viewer-meta">
          <span className="asset-viewer-kind">{info.kind.toUpperCase()}</span>
          <span className="asset-viewer-bytes">{fmtBytes(info.bytes)}</span>
          {info.path && (
            <span className="asset-viewer-path" title={info.path}>
              {info.path.split("/").slice(-2).join("/")}
            </span>
          )}
        </div>
        <div className="asset-viewer-downloads">
          {stlDataUrl && (
            <a
              href={stlDataUrl}
              download={`asset-${jobId}.stl`}
              className="asset-viewer-dl"
            >
              ↓ STL
            </a>
          )}
          {glbSrc && (
            <a
              href={glbSrc}
              download={`asset-${jobId}.glb`}
              className="asset-viewer-dl"
            >
              ↓ GLB
            </a>
          )}
          {pngSrc && (
            <a
              href={pngSrc}
              download={`asset-${jobId}.png`}
              className="asset-viewer-dl"
            >
              ↓ PNG
            </a>
          )}
        </div>
      </div>
    );
  }

  if (info.kind === "png" && pngSrc) {
    return (
      <div className={`asset-viewer asset-viewer--png${compact ? " is-compact" : ""}`}>
        <img
          src={pngSrc}
          alt="Asset preview"
          style={{ maxWidth: "100%", maxHeight: `${height}px`, objectFit: "contain" }}
        />
        <div className="asset-viewer-meta">
          <span className="asset-viewer-kind">PNG</span>
          <span className="asset-viewer-bytes">{fmtBytes(info.bytes)}</span>
        </div>
      </div>
    );
  }

  // SVG falls through to existing inline-svg renderers handled by the
  // caller (ActivityFeed already does it via cmd_read_job_svg); we just
  // render a small placeholder here for completeness.
  return (
    <div className="asset-viewer asset-viewer--svg">
      <span className="asset-viewer-kind">SVG</span>
      <span className="asset-viewer-bytes">{fmtBytes(info.bytes)}</span>
    </div>
  );
}

/**
 * GLB thumbnail with a progress overlay + fade-in. Avoids the visible
 * stutter where model-viewer reveals a half-loaded mesh frame-by-frame
 * over a 90 MB GLB streaming via the asset protocol. We listen to
 * model-viewer's native `progress` / `load` events and:
 *   - hide the canvas (opacity 0) until `load` fires,
 *   - show a thin gradient progress bar pinned to the bottom edge with
 *     the current % (so the user knows it's working, not broken),
 *   - keep the PNG poster (Meshy's preview render) visible behind so the
 *     tile never goes blank during the stream.
 */
function Glb3dThumb({
  src,
  posterSrc,
  height,
  shadow,
  exposure,
  rotateDelay,
  rotateSpeed,
  bytes,
  compact,
}: {
  src: string;
  posterSrc: string | null;
  height: number;
  shadow: string;
  exposure: string;
  rotateDelay: string;
  rotateSpeed: string;
  bytes: number;
  compact: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setProgress(0);
    setLoaded(false);
    setErrored(false);
  }, [src]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const mv = root.querySelector("model-viewer");
    if (!mv) return;
    const onProgress = (e: Event) => {
      const ce = e as CustomEvent<{ totalProgress?: number }>;
      const pct = ce.detail?.totalProgress;
      if (typeof pct === "number") setProgress(pct);
    };
    const onLoad = () => {
      setProgress(1);
      setLoaded(true);
    };
    const onError = () => setErrored(true);
    mv.addEventListener("progress", onProgress);
    mv.addEventListener("load", onLoad);
    mv.addEventListener("error", onError);
    return () => {
      mv.removeEventListener("progress", onProgress);
      mv.removeEventListener("load", onLoad);
      mv.removeEventListener("error", onError);
    };
  }, [src]);

  const showOverlay = !loaded && !errored;
  const pct = Math.max(2, Math.round(progress * 100));

  return (
    <div
      ref={containerRef}
      className={`asset-viewer-3d-stage${compact ? " is-compact" : ""}`}
      style={{ position: "relative", width: "100%", height: `${height}px` }}
    >
      {posterSrc && !loaded && (
        <img
          src={posterSrc}
          alt=""
          aria-hidden
          className="asset-viewer-3d-poster"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "#1a1d23",
            opacity: 0.55,
            filter: "blur(1px)",
            pointerEvents: "none",
          }}
        />
      )}
      {/* @ts-expect-error custom-element JSX */}
      <model-viewer
        src={src}
        alt="3D asset preview"
        camera-controls
        auto-rotate
        auto-rotate-delay={rotateDelay}
        rotation-per-second={rotateSpeed}
        camera-orbit="0deg 75deg 105%"
        shadow-intensity={shadow}
        exposure={exposure}
        interaction-prompt="none"
        reveal="auto"
        loading="eager"
        style={{
          width: "100%",
          height: "100%",
          background: posterSrc ? "transparent" : "#1a1d23",
          display: "block",
          opacity: loaded ? 1 : 0,
          transition: "opacity 220ms ease",
        }}
      />
      {showOverlay && (
        <div className="asset-viewer-3d-progress" aria-hidden>
          <div className="asset-viewer-3d-progress-label">
            Loading {fmtBytes(bytes)} · {pct}%
          </div>
          <div className="asset-viewer-3d-progress-track">
            <div
              className="asset-viewer-3d-progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {errored && (
        <div className="asset-viewer-3d-progress is-error" aria-hidden>
          <div className="asset-viewer-3d-progress-label">
            Preview failed — tap to inspect
          </div>
        </div>
      )}
    </div>
  );
}
