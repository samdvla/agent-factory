import { useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useFactoryStore } from "../factory/state/factoryStore";
import {
  applySupervisorEvent,
  SupervisorEvent,
} from "../factory/state/eventReducer";

export function useSupervisorEventsToStore() {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<SupervisorEvent>("supervisor.event", (e) => {
      applySupervisorEvent(useFactoryStore.getState(), e.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);
}

// Backwards compat stub for existing code (e.g., LogsView from P0).
// LogsView will be removed in T11, but keeping this stub allows the build to pass.
export function useSupervisorEvents(_maxRows?: number) {
  return [] as { ts: number; evt: SupervisorEvent }[];
}
