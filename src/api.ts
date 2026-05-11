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

export type EtsyPublishRow = {
  id: number;
  local_listing_id: number;
  etsy_listing_id: number;
  state: string; // 'draft' | 'active' | 'inactive' | 'expired'
  title: string;
  url: string | null;
  published_at: number;
  activated_at: number | null;
};

export type ActivateResult = {
  etsy_listing_id: number;
  url: string | null;
};

export type CycleSummary = {
  cycle_id: string;
  niche: string | null;
  local_listing_id: number | null;
  revenue_usd: number;
  total_cost_usd: number;
  net_usd: number;
  contributor_count: number;
};

export type AgentWealth = {
  role: string;
  lifetime_revenue_usd: number;
  lifetime_cost_usd: number;
  lifetime_net_usd: number;
  cycles_count: number;
};

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
  etsySetEnabled: (enabled: boolean) =>
    invoke<void>("cmd_etsy_set_enabled", { enabled }),
  etsyGetEnabled: () => invoke<boolean>("cmd_etsy_get_enabled"),
  etsySetListingCap: (cap: number) =>
    invoke<void>("cmd_etsy_set_listing_cap", { cap }),
  etsyGetListingCap: () => invoke<number>("cmd_etsy_get_listing_cap"),
  etsyListPublishes: () => invoke<EtsyPublishRow[]>("cmd_etsy_list_publishes"),
  etsyActivateListing: (localListingId: number) =>
    invoke<ActivateResult>("cmd_etsy_activate_listing", {
      localListingId,
    }),
  etsyKillSwitch: () => invoke<void>("cmd_etsy_kill_switch"),
  listRecentCycles: (limit?: number) =>
    invoke<CycleSummary[]>("cmd_list_recent_cycles", { limit }),
  listWealth: () => invoke<AgentWealth[]>("cmd_list_wealth"),
};
