// Phase 1 client mode: helpers to talk to a remote agent-factory mini.
//
// The mini exposes /healthz, /api/status, /api/events at a configurable URL.
// Bearer-token auth on everything except /healthz. We persist the URL +
// token in localStorage so they survive reloads.

const STORAGE_KEY = "agent_factory_remote";

export type RemoteConfig = {
  url: string; // e.g. "http://100.110.160.8:7420"
  token: string; // 64-char hex
};

export function getRemoteConfig(): RemoteConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemoteConfig;
    if (!parsed?.url || !parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setRemoteConfig(cfg: RemoteConfig | null): void {
  if (cfg === null) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function isRemoteMode(): boolean {
  return getRemoteConfig() !== null;
}

/**
 * Fetch a JSON endpoint on the remote mini with bearer-token auth.
 * Throws on non-2xx or transport errors.
 */
export async function remoteFetch<T>(path: string): Promise<T> {
  const cfg = getRemoteConfig();
  if (!cfg) throw new Error("remoteFetch called without remote config");
  const url = cfg.url.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    throw new Error(`remote ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Open a server-sent events stream from /api/events on the remote mini.
 * Returns a teardown function. The handler receives parsed JSON objects
 * matching the supervisor's event shape.
 *
 * EventSource doesn't support custom headers (no way to set Authorization),
 * so we pass the token as a query parameter. The server accepts both forms.
 * NOTE: server currently only accepts Authorization header — we'll widen
 * it server-side in a follow-up. For now we use fetch + ReadableStream.
 */
export function subscribeRemoteEvents(
  onEvent: (evt: unknown) => void,
  onError?: (err: unknown) => void
): () => void {
  const cfg = getRemoteConfig();
  if (!cfg) {
    throw new Error("subscribeRemoteEvents called without remote config");
  }
  const ctrl = new AbortController();
  const url = cfg.url.replace(/\/+$/, "") + "/api/events";
  (async () => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!ctrl.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // SSE messages are separated by double newlines.
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // Lines starting with "data: " are payload; ignore others (id:,
          // event:, retry:, :keep-alive comments).
          const dataLines = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (!dataLines.length) continue;
          const payload = dataLines.join("\n");
          try {
            onEvent(JSON.parse(payload));
          } catch {
            // Non-JSON SSE payload — keep stream alive.
          }
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted && onError) onError(err);
    }
  })();
  return () => ctrl.abort();
}

/**
 * Health check — useful for the Settings UI "Test connection" button.
 * Hits /healthz (no auth). Returns true iff the server responded "ok".
 */
export async function remoteHealthCheck(): Promise<boolean> {
  const cfg = getRemoteConfig();
  if (!cfg) return false;
  try {
    const res = await fetch(cfg.url.replace(/\/+$/, "") + "/healthz");
    if (!res.ok) return false;
    return (await res.text()).trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * Expose the remote helpers on `window.__af_remote` so the user can wire up
 * client mode from the devtools console before a settings UI exists:
 *
 *   __af_remote.set({ url: "http://100.110.160.8:7420", token: "..." })
 *   await __af_remote.status()
 *   __af_remote.tail((evt) => console.log(evt))
 */
declare global {
  interface Window {
    __af_remote?: {
      get: typeof getRemoteConfig;
      set: typeof setRemoteConfig;
      isOn: typeof isRemoteMode;
      health: typeof remoteHealthCheck;
      status: () => Promise<unknown>;
      tail: (onEvent: (evt: unknown) => void) => () => void;
    };
  }
}

export function installWindowGlobals(): void {
  if (typeof window === "undefined") return;
  window.__af_remote = {
    get: getRemoteConfig,
    set: setRemoteConfig,
    isOn: isRemoteMode,
    health: remoteHealthCheck,
    status: () => remoteFetch<unknown>("/api/status"),
    tail: (onEvent) =>
      subscribeRemoteEvents(onEvent, (err) =>
        // eslint-disable-next-line no-console
        console.warn("[remote] SSE error", err)
      ),
  };
}
