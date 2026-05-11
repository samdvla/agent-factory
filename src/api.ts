import { invoke } from "@tauri-apps/api/core";

export type StatusReport = { running: boolean; project_id: number };

export type EtsyStatus = {
  connected: boolean;
  shop_id: number | null;
  shop_name: string | null;
  expires_at: number | null;
  needs_refresh: boolean;
};

export type OAuthInit = { authorize_url: string };

export const api = {
  status: () => invoke<StatusReport>("cmd_status"),
  start: () => invoke<void>("cmd_start_supervisor"),
  stop: () => invoke<void>("cmd_stop_supervisor"),
  setSecret: (key: string, value: string) =>
    invoke<void>("cmd_set_secret", { key, value }),
  getSecret: (key: string) =>
    invoke<string | null>("cmd_get_secret", { key }),
  enqueue: (agentRole: string, payload: unknown) =>
    invoke<number>("cmd_enqueue", { args: { agent_role: agentRole, payload } }),
  etsyStartOAuth: () => invoke<OAuthInit>("cmd_etsy_start_oauth"),
  etsyStatus: () => invoke<EtsyStatus>("cmd_etsy_status"),
  etsyDisconnect: () => invoke<void>("cmd_etsy_disconnect"),
};
