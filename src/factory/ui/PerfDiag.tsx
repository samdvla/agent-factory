import { useEffect, useState } from "react";
import { initCollector, snapshot, type PerfSnapshot } from "../perf/collector";
import { usePerfSettings, PERF_TOGGLE_META } from "../perf/perfSettings";

// Live FPS / frame-cost overlay. Visibility + the bisection toggles are owned
// by the persisted perf-settings store (also surfaced in Settings >
// Performance), so this is a permanent, opt-in tool rather than a temp hack.
//
// Hotkeys (when the app window is focused):
//   h        show / hide this overlay
//   1-4      toggle each rendering cost (see PERF_TOGGLE_META)
//   0        re-enable everything (clear all toggles)
//
// The CSS that the toggles switch on lives in factory-floor.css under the
// `body.diag-*` selectors. The metrics come from perf/collector.ts.

function color(fps: number): string {
  return fps >= 55 ? "#5ed0a8" : fps >= 35 ? "#f5a623" : "#ff5d5d";
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color: warn ? "#ff5d5d" : "#dfe6ee" }}>{value}</span>
    </div>
  );
}

export default function PerfDiag() {
  const hudVisible = usePerfSettings((s) => s.hudVisible);
  const toggles = usePerfSettings((s) => s.toggles);
  const toggleKey = usePerfSettings((s) => s.toggleKey);
  const resetToggles = usePerfSettings((s) => s.resetToggles);
  const toggleHud = usePerfSettings((s) => s.toggleHud);
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);

  // Keyboard shortcuts are always live (even when the overlay is hidden) so
  // `h` can summon it. Other keys are no-ops while hidden would be confusing,
  // so they work regardless — they just change persisted settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "h") return toggleHud();
      if (e.key === "0") return resetToggles();
      const meta = PERF_TOGGLE_META.find((m) => m.hotkey === e.key);
      if (meta) toggleKey(meta.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleHud, resetToggles, toggleKey]);

  // Only run the collector + sampling loop while the overlay is shown, so the
  // instrumentation adds zero overhead during normal use.
  useEffect(() => {
    if (!hudVisible) return;
    initCollector();
    const id = setInterval(() => setSnap(snapshot()), 500);
    return () => clearInterval(id);
  }, [hudVisible]);

  if (!hudVisible) return null;

  const fps = snap ? Math.round(snap.fps) : 0;

  return (
    <div
      style={{
        position: "fixed",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 99999,
        width: 280,
        background: "rgba(10,12,16,0.94)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 8,
        padding: "8px 12px",
        font: "11px/1.6 JetBrains Mono, monospace",
        color: "#dfe6ee",
        pointerEvents: "none",
        boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, fontSize: 18, color: color(fps) }}>{fps} FPS</span>
        <span style={{ opacity: 0.6, fontSize: 10 }}>[h] hide</span>
      </div>

      {snap && (
        <div style={{ marginTop: 6, marginBottom: 6 }}>
          <Row label="frame avg" value={`${snap.frameAvgMs.toFixed(1)} ms`} warn={snap.frameAvgMs > 18} />
          <Row label="frame worst" value={`${snap.frameWorstMs.toFixed(0)} ms`} warn={snap.frameWorstMs > 33} />
          <Row label="dropped/s" value={`${snap.droppedFrames}`} warn={snap.droppedFrames > 5} />
          <Row label="long tasks" value={`${snap.longTaskCount}`} warn={snap.longTaskCount > 0} />
          <Row label="blocking/s" value={`${snap.blockingMsPerSec.toFixed(0)} ms`} warn={snap.blockingMsPerSec > 50} />
          <Row label="layout reads/s" value={`${Math.round(snap.layoutReadsPerSec)}`} warn={snap.layoutReadsPerSec > 300} />
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.12)", margin: "5px 0" }} />
          <div style={{ opacity: 0.7, marginBottom: 2 }}>React commits (ms/s · n/s)</div>
          {snap.renders.length === 0 && <div style={{ opacity: 0.5 }}>none</div>}
          {snap.renders.slice(0, 6).map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ opacity: 0.7 }}>{r.id}</span>
              <span style={{ color: r.msPerSec > 80 ? "#ff5d5d" : "#dfe6ee" }}>
                {r.msPerSec.toFixed(0)} · {Math.round(r.perSec)}
              </span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.12)", margin: "5px 0" }} />
          <Row label="DOM nodes" value={`${snap.domNodes}`} warn={snap.domNodes > 4000} />
          <Row label="SVG nodes" value={`${snap.svgNodes}`} warn={snap.svgNodes > 3000} />
          <Row label="avatars / rooms" value={`${snap.avatars} / ${snap.rooms}`} />
        </div>
      )}

      <div style={{ borderTop: "1px solid rgba(255,255,255,0.12)", margin: "5px 0" }} />
      {PERF_TOGGLE_META.map((m) => (
        <div key={m.key} style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ opacity: 0.7 }}>
            [{m.hotkey}] {m.label.replace(/^Disable /, "")}
          </span>
          <span style={{ color: toggles[m.key] ? "#ff5d5d" : "#5ed0a8" }}>
            {toggles[m.key] ? "OFF" : "on"}
          </span>
        </div>
      ))}
      <div style={{ opacity: 0.5 }}>[0] reset all toggles</div>
    </div>
  );
}
