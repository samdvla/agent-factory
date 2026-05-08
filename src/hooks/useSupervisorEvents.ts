import { useEffect, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type SupervisorEvent = {
  kind: string;
  [k: string]: unknown;
};

export function useSupervisorEvents(maxRows = 500) {
  const [events, setEvents] = useState<{ ts: number; evt: SupervisorEvent }[]>([]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<SupervisorEvent>("supervisor.event", (e) => {
      setEvents((prev) => {
        const next = [...prev, { ts: Date.now(), evt: e.payload }];
        return next.slice(-maxRows);
      });
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [maxRows]);

  return events;
}
