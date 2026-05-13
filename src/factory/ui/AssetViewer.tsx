import { useEffect, useMemo, useState } from "react";
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
    return (
      <div className={`asset-viewer asset-viewer--3d${compact ? " is-compact" : ""}`}>
        {glbDataUrl ? (
          // model-viewer is a custom element — TS needs the cast.
          // @ts-expect-error custom-element JSX
          <model-viewer
            src={glbDataUrl}
            alt="3D asset preview"
            camera-controls
            auto-rotate
            camera-orbit="0deg 75deg 105%"
            shadow-intensity="1"
            exposure="1.0"
            interaction-prompt="none"
            style={{
              width: "100%",
              height: `${height}px`,
              background: "#1a1d23",
              display: "block",
            }}
          />
        ) : pngDataUrl ? (
          <img
            src={pngDataUrl}
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
          {glbDataUrl && (
            <a
              href={glbDataUrl}
              download={`asset-${jobId}.glb`}
              className="asset-viewer-dl"
            >
              ↓ GLB
            </a>
          )}
          {pngDataUrl && (
            <a
              href={pngDataUrl}
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

  if (info.kind === "png" && pngDataUrl) {
    return (
      <div className={`asset-viewer asset-viewer--png${compact ? " is-compact" : ""}`}>
        <img
          src={pngDataUrl}
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
