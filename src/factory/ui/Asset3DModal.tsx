import { useEffect, useMemo, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type JobAssetInfo } from "../../api";

// Inspectable variants. STATIC is the printable mesh; rigged/walking/
// running/animated come from Meshy's auto-rig + animation pass (humanoid
// full-body characters); REFERENCE is the 2D nanobanana ref image we
// fed into Meshy's image-to-3D so the operator can compare "what we
// asked for" vs "what Meshy made of it". The toggle is hidden on jobs
// that only have the static GLB.
type Variant =
  | "static"
  | "rigged"
  | "walking"
  | "running"
  | "animated"
  | "reference";

const VARIANT_LABELS: Record<Variant, string> = {
  static: "Static",
  rigged: "Rigged",
  walking: "Walk",
  running: "Run",
  animated: "Animation",
  reference: "Reference",
};

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
 * Renders the full enriched prompt that Gemini received for the ref image
 * (designer's brief + studio-reference wrapping from ref_prompt.py).
 * Collapsed by default to keep the viewer's focus on the image; expand to
 * read the whole thing and copy it for tuning. The prompt is the single
 * highest-leverage knob on ref-image quality, so making it easy to read
 * here closes the iteration loop.
 */
function RefPromptBlock({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in some sandboxes; silently no-op rather
      // than throw — the prompt is still visible in the expanded block.
    }
  }, [prompt]);
  return (
    <div className="asset-3d-modal-refprompt">
      <button
        type="button"
        className="asset-3d-modal-refprompt-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Image-gen prompt ({prompt.length} chars)
      </button>
      {open && (
        <div className="asset-3d-modal-refprompt-body">
          <pre className="asset-3d-modal-refprompt-text">{prompt}</pre>
          <button
            type="button"
            className="asset-3d-modal-refprompt-copy"
            onClick={onCopy}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
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

  // Build a renderable URL per variant. Prefers Tauri's asset protocol
  // (file streamed directly from disk via convertFileSrc → tauri://
  // localhost/...) which is dramatically faster than base64-decoding a
  // 90 MB GLB through JSON IPC. Falls back to the inline data URL when
  // no path is available (e.g. a GLB job with kind="glb" + path lost).
  // Returns null only when neither a path nor base64 is present.
  const variantUrls = useMemo<Record<Variant, string | null>>(() => {
    if (!info) {
      return {
        static: null, rigged: null, walking: null, running: null,
        animated: null, reference: null,
      };
    }
    const fromPath = (path: string | null | undefined) =>
      path ? convertFileSrc(path) : null;
    const fromGlbB64 = (b64: string | null | undefined) =>
      b64 ? `data:model/gltf-binary;base64,${b64}` : null;
    const fromPngB64 = (b64: string | null | undefined) =>
      b64 ? `data:image/png;base64,${b64}` : null;
    // Static GLB sibling: for STL jobs the GLB is at glb_path; for GLB
    // jobs the primary path IS the GLB.
    const staticPath = info.kind === "glb" ? info.path : info.glb_path;
    const staticB64 = info.kind === "glb" ? info.data_base64 : info.glb_data_base64;
    return {
      static: fromPath(staticPath) ?? fromGlbB64(staticB64),
      rigged: fromPath(info.rigged_glb_path) ?? fromGlbB64(info.rigged_glb_data_base64),
      walking: fromPath(info.walking_glb_path) ?? fromGlbB64(info.walking_glb_data_base64),
      running: fromPath(info.running_glb_path) ?? fromGlbB64(info.running_glb_data_base64),
      animated: fromPath(info.animated_glb_path) ?? fromGlbB64(info.animated_glb_data_base64),
      reference: fromPath(info.ref_image_path) ?? fromPngB64(info.ref_image_data_base64),
    };
  }, [info]);

  // Which variants are actually available for this job (have a URL).
  // Static is always first when present; the rig variants ride alongside.
  const availableVariants = useMemo<Variant[]>(() => {
    return (Object.keys(variantUrls) as Variant[]).filter(
      (v) => variantUrls[v] !== null,
    );
  }, [variantUrls]);

  // Currently-selected variant. Defaults to static; resets when the job
  // changes so opening a fresh asset always starts on the printable mesh.
  const [variant, setVariant] = useState<Variant>("static");
  useEffect(() => {
    setVariant("static");
  }, [jobId]);

  // If the user landed on a variant that isn't available (e.g. jobId
  // changed mid-flight), fall back to the first one that IS.
  useEffect(() => {
    if (
      availableVariants.length > 0 &&
      !availableVariants.includes(variant)
    ) {
      setVariant(availableVariants[0]);
    }
  }, [availableVariants, variant]);

  // glbDataUrl is null when the active variant is "reference" (a PNG
  // doesn't go into model-viewer); refImageDataUrl mirrors it for the
  // image renderer below. Exactly one is non-null at a time.
  const glbDataUrl = variant === "reference" ? null : variantUrls[variant];
  const refImageDataUrl = variant === "reference" ? variantUrls.reference : null;

  // Resets when the active variant flips so the loading bar accurately
  // reflects "this variant's progress" not the cumulative across swaps.
  // model-viewer fires `progress` continuously while loading and `load`
  // once the GLB is fully parsed and renderable.
  const [loadProgress, setLoadProgress] = useState<number>(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    setLoadProgress(0);
    setLoadError(null);
  }, [variant, glbDataUrl]);
  useEffect(() => {
    if (!glbDataUrl) return;
    const el = document.querySelector<HTMLElement>("#asset-3d-modal-viewer");
    if (!el) return;
    const onProgress = (e: Event) => {
      const ce = e as CustomEvent<{ totalProgress?: number }>;
      const pct = ce.detail?.totalProgress;
      if (typeof pct === "number") setLoadProgress(pct);
    };
    const onLoad = () => setLoadProgress(1);
    const onError = (e: Event) => {
      const ce = e as CustomEvent<{ sourceError?: { message?: string } }>;
      setLoadError(ce.detail?.sourceError?.message ?? "model-viewer failed to load this GLB");
    };
    el.addEventListener("progress", onProgress);
    el.addEventListener("load", onLoad);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("load", onLoad);
      el.removeEventListener("error", onError);
    };
  }, [glbDataUrl, variant]);

  // STL + PNG download links also prefer file URLs (browser handles
  // `download` attr the same way as for data URLs, but without the 1.33×
  // base64 bloat in the DOM).
  const stlDataUrl = useMemo(() => {
    if (!info) return null;
    if (info.kind === "stl" && info.path) return convertFileSrc(info.path);
    if (info.kind === "stl" && info.data_base64) return `data:model/stl;base64,${info.data_base64}`;
    return null;
  }, [info]);

  const pngDataUrl = useMemo(() => {
    if (!info) return null;
    if (info.kind === "png" && info.path) return convertFileSrc(info.path);
    if (info.kind === "png" && info.data_base64) return `data:image/png;base64,${info.data_base64}`;
    if (info.png_data_base64) return `data:image/png;base64,${info.png_data_base64}`;
    return null;
  }, [info]);

  // True when the active variant carries a baked animation that should
  // autoplay on load. Static + rigged-only have no animation tracks; the
  // walking/running/animated GLBs each carry one looped action from
  // Meshy's rigging + Animation Library output.
  const variantIsAnimated = variant === "walking" || variant === "running" || variant === "animated";

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
              {refImageDataUrl ? (
                // Reference variant — render the nanobanana still that
                // Meshy turned into the 3D mesh. Inline <img>, not a
                // model-viewer; controls below stay (download link, etc.)
                // but Snap-to-angle is hidden in the controls block since
                // there's nothing to orbit.
                <div className="asset-3d-modal-fallback">
                  <img
                    src={refImageDataUrl}
                    alt="Nano Banana reference image (input to Meshy image-to-3D)"
                    className="asset-3d-modal-fallback-img"
                  />
                  <div className="asset-3d-modal-fallback-note">
                    Reference still — this is the image Nano Banana
                    rendered from the design brief, then handed to Meshy
                    image-to-3D. Switch to Static / Rigged / etc. to see
                    what Meshy made of it.
                  </div>
                  {info.ref_prompt && (
                    <RefPromptBlock prompt={info.ref_prompt} />
                  )}
                </div>
              ) : glbDataUrl ? (
                <>
                  {/* Progress overlay — model-viewer takes 3-15s on a
                      90 MB GLB even via the asset protocol. Without
                      this the user sees a blank canvas and assumes the
                      modal broke. The bar disappears on `load`. */}
                  {loadProgress < 1 && !loadError && (
                    <div className="asset-3d-modal-progress">
                      <div className="asset-3d-modal-progress-label">
                        Loading {fmtBytes(info.bytes)} model · {Math.round(loadProgress * 100)}%
                      </div>
                      <div className="asset-3d-modal-progress-track">
                        <div
                          className="asset-3d-modal-progress-fill"
                          style={{ width: `${Math.max(2, loadProgress * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {loadError && (
                    <div className="asset-3d-modal-status is-error">
                      {loadError}
                    </div>
                  )}
                  {/* @ts-expect-error custom element JSX */}
                  <model-viewer
                  // Force a remount when the variant changes — model-viewer
                  // has occasional stale-frame issues when the same element
                  // swaps src between an animated and a static GLB. Using a
                  // key per variant guarantees a clean teardown.
                  key={variant}
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
                  // Autoplay the embedded animation when viewing an animated
                  // variant. model-viewer auto-detects the first animation
                  // clip in the GLB; we don't pin a name because the rig +
                  // animation pass produces clip names like "Walking" /
                  // "Running" / "Animation_<Action>" that vary per Meshy
                  // job. autoplay + loop = the natural expectation here.
                  {...(variantIsAnimated
                    ? { autoplay: true, "animation-name": undefined }
                    : {})}
                  className="asset-3d-modal-viewer"
                />
                </>
              ) : pngDataUrl ? (
                <div className="asset-3d-modal-fallback">
                  <img
                    src={pngDataUrl}
                    alt="3D asset thumbnail (no GLB available)"
                    className="asset-3d-modal-fallback-img"
                  />
                  <div className="asset-3d-modal-fallback-note">
                    Live 3D preview unavailable — no sibling GLB was
                    produced for this {fmtBytes(info.bytes)} asset (or
                    the asset path is unreachable). Static thumbnail
                    shown.
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

        {!loading && !err && info && (glbDataUrl || refImageDataUrl) && (
          <div className="asset-3d-modal-controls">
            {/* Variant toggle — shown only when the cycle produced more
                than just the static mesh (i.e. Meshy's rig+anim pass
                fired OR a reference image is available). Single-artifact
                jobs hide the row entirely so the inspector stays clean. */}
            {availableVariants.length > 1 && (
              <div className="asset-3d-modal-control-group asset-3d-modal-variant-row">
                <span className="asset-3d-modal-control-label">Variant</span>
                {availableVariants.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`asset-3d-modal-variant-btn${variant === v ? " is-active" : ""}`}
                    onClick={() => setVariant(v)}
                    title={
                      v === "static"
                        ? "Printable static mesh — what buyers print on FDM/resin"
                        : v === "rigged"
                          ? "Rigged GLB — humanoid skeleton bound, no animation playing"
                          : v === "walking"
                            ? "Free walking loop bundled with Meshy's rigging task"
                            : v === "running"
                              ? "Free running loop bundled with Meshy's rigging task"
                              : v === "animated"
                                ? "One preset action from Meshy's Animation Library"
                                : "Nano Banana reference still — input to Meshy image-to-3D"
                    }
                  >
                    {VARIANT_LABELS[v]}
                  </button>
                ))}
                {variantIsAnimated && (
                  <span
                    className="asset-3d-modal-control-label asset-3d-modal-anim-hint"
                    aria-live="polite"
                  >
                    autoplaying
                  </span>
                )}
              </div>
            )}

            {/* Snap-to-angle is meaningless for the 2D reference image,
                so hide the whole orbit-control row when that variant is
                active. The variant-toggle row above is enough nav. */}
            {glbDataUrl && (
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
            )}

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
              {/* Rig + animation variant downloads. Only rendered when
                  the cycle produced them, so static-only listings stay
                  clean. Filenames embed the variant suffix so the buyer's
                  Downloads folder stays self-describing. */}
              {variantUrls.rigged && (
                <a
                  href={variantUrls.rigged}
                  download={`asset-${jobId}.rigged.glb`}
                  className="asset-3d-modal-dl"
                >
                  ↓ Rigged
                </a>
              )}
              {variantUrls.walking && (
                <a
                  href={variantUrls.walking}
                  download={`asset-${jobId}.walking.glb`}
                  className="asset-3d-modal-dl"
                >
                  ↓ Walk
                </a>
              )}
              {variantUrls.running && (
                <a
                  href={variantUrls.running}
                  download={`asset-${jobId}.running.glb`}
                  className="asset-3d-modal-dl"
                >
                  ↓ Run
                </a>
              )}
              {variantUrls.animated && (
                <a
                  href={variantUrls.animated}
                  download={`asset-${jobId}.animated.glb`}
                  className="asset-3d-modal-dl"
                >
                  ↓ Anim
                </a>
              )}
              {variantUrls.reference && (
                <a
                  href={variantUrls.reference}
                  download={`asset-${jobId}-ref.png`}
                  className="asset-3d-modal-dl"
                >
                  ↓ Ref
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
