import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type EmitProbeWindowAttempt = { label: string; ok: boolean; error: string | null };
type EmitProbeAttempt = {
  shape: string;
  app_emit_ok: boolean;
  app_emit_error: string | null;
  windows: EmitProbeWindowAttempt[];
};
type EmitProbeReport = { labels: string[]; attempts: EmitProbeAttempt[]; sent: number };

/**
 * Floating diagnostic chip on the floor. Subscribes to "supervisor.event"
 * directly (independent of the store) and shows the most recent event so we
 * can see at a glance whether the IPC channel is actually delivering.
 *
 * If this stays "no events received" forever while the backend is producing
 * jobs (see the Activity rail count), the Rust→webview emit path is broken
 * (capability missing, window-not-found, etc.) — not the animation code.
 *
 * The "Test" button invokes a backend command that synthesizes 3 supervisor
 * events from inside an invoke handler — that bypasses the spawned bus
 * forwarder so we can isolate whether listen() works at all.
 */
export default function EventBeacon() {
  const [last, setLast] = useState<{ kind: string; role?: string; ts: number } | null>(null);
  const [count, setCount] = useState(0);
  const [, setTick] = useState(0);
  const [probeReport, setProbeReport] = useState<string | null>(null);
  const [probeDetail, setProbeDetail] = useState<EmitProbeReport | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ kind: string; role?: string }>("supervisor.event", (e) => {
      setLast({ kind: e.payload.kind, role: e.payload.role, ts: Date.now() });
      setCount((c) => c + 1);
    })
      .then((fn) => {
        unlisten = fn;
        // Listener is now registered — fire a one-shot probe so we know
        // immediately whether the channel works. If counter doesn't reach 3
        // within a second, the IPC is dead.
        setTimeout(async () => {
          try {
            const rpt = await invoke<EmitProbeReport>("cmd_emit_test");
            setProbeDetail(rpt);
            setProbeReport(`probe: backend sent ${rpt.sent}/3 · labels=[${rpt.labels.join(",") || "(none)"}]`);
          } catch (e) {
            setProbeReport(`probe failed: ${String(e).slice(0, 80)}`);
          }
        }, 250);
      })
      .catch((e) => setProbeReport(`listen failed: ${String(e).slice(0, 80)}`));
    return () => {
      unlisten?.();
    };
  }, []);

  // Re-render every 1s so the "Xs ago" stays fresh.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const onProbe = async () => {
    setProbeReport("probing…");
    try {
      const rpt = await invoke<EmitProbeReport>("cmd_emit_test");
      setProbeDetail(rpt);
      setProbeReport(`probe: backend sent ${rpt.sent}/3 · labels=[${rpt.labels.join(",") || "(none)"}]`);
    } catch (e) {
      setProbeReport(`probe failed: ${String(e).slice(0, 80)}`);
    }
  };

  const status = last
    ? `${last.kind}${last.role ? ` · ${last.role}` : ""} · ${Math.max(0, Math.floor((Date.now() - last.ts) / 1000))}s ago`
    : "no events received yet";
  const fresh = last !== null && Date.now() - last.ts < 2000;

  return (
    <div className={`event-beacon${fresh ? " is-fresh" : ""}`} role="status" aria-live="polite">
      <span className="event-beacon-dot" aria-hidden />
      <span className="event-beacon-label">events</span>
      <span className="event-beacon-count">{count}</span>
      <span className="event-beacon-status">{status}</span>
      <button
        type="button"
        className="event-beacon-probe"
        onClick={onProbe}
        title="Fire 3 synthetic events from backend to verify IPC"
      >
        probe
      </button>
      {probeReport && (
        <span
          className="event-beacon-probe-report"
          title="Click for detail"
          onClick={() => setDetailOpen((v) => !v)}
          style={{ cursor: probeDetail ? "pointer" : "default" }}
        >
          {probeReport}
        </span>
      )}
      {detailOpen && probeDetail && (
        <div className="event-beacon-detail">
          {probeDetail.attempts.map((a) => (
            <div key={a.shape} className="event-beacon-detail-row">
              <strong>[{a.shape}]</strong>{" "}
              app.emit: {a.app_emit_ok ? "ok" : `ERR ${a.app_emit_error}`}
              {a.windows.map((w) => (
                <div key={w.label} className="event-beacon-detail-row" style={{ paddingLeft: 12 }}>
                  window({w.label}): {w.ok ? "ok" : `ERR ${w.error}`}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
