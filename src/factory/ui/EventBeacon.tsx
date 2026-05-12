import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Floating diagnostic chip on the floor. Subscribes to "supervisor.event"
 * directly (independent of the store) and shows the most recent event so we
 * can see at a glance whether the IPC channel is actually delivering.
 *
 * If this stays "no events received" forever while the backend is producing
 * jobs (see the Activity rail count), the Rust→webview emit path is broken
 * (capability missing, window-not-found, etc.) — not the animation code.
 */
export default function EventBeacon() {
  const [last, setLast] = useState<{ kind: string; role?: string; ts: number } | null>(null);
  const [count, setCount] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ kind: string; role?: string }>("supervisor.event", (e) => {
      setLast({ kind: e.payload.kind, role: e.payload.role, ts: Date.now() });
      setCount((c) => c + 1);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Re-render every 1s so the "Xs ago" stays fresh.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;

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
    </div>
  );
}
