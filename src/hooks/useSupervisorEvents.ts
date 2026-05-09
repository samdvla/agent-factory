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
