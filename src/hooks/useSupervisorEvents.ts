import { useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useFactoryStore } from "../factory/state/factoryStore";
import {
  applySupervisorEvent,
  SupervisorEvent,
} from "../factory/state/eventReducer";
import { isRemoteMode, subscribeRemoteEvents } from "../remote";

/**
 * Subscribes the factory store to supervisor events. Routes through:
 *   - Tauri's local event bus (`supervisor:event`) by default.
 *   - The remote mini's /api/events SSE stream when a remote server is
 *     configured in localStorage. Switches automatically — re-mount the
 *     hook (or reload) to pick up a config change.
 */
export function useSupervisorEventsToStore() {
  useEffect(() => {
    if (isRemoteMode()) {
      const stop = subscribeRemoteEvents(
        (evt) => {
          applySupervisorEvent(
            useFactoryStore.getState(),
            evt as SupervisorEvent
          );
        },
        (err) => {
          // eslint-disable-next-line no-console
          console.warn("[remote] supervisor SSE error", err);
        }
      );
      return () => stop();
    }
    let unlisten: UnlistenFn | undefined;
    listen<SupervisorEvent>("supervisor:event", (e) => {
      applySupervisorEvent(useFactoryStore.getState(), e.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);
}
