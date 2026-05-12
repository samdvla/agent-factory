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

export type PromptRow = {
  default: string;
  override: string | null;
  last_tweak_ts: number | null;
  last_tweak_source: string | null;
  last_tweak_rationale: string | null;
};

export type PromptHistoryEntry = {
  ts: number;
  role_tweaked: string;
  prior_overrides?: unknown;
  rationale?: string | null;
  source?: string | null;
};

export type JobRow = {
  id: number;
  agent_role: string;
  status: "done" | "errored";
  payload_json: string;
  result_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  scheduled_at: string;
  rating: "up" | "down" | null;
  rating_note: string | null;
  rated_at: number | null;
};

export type ListingReviewInfo = {
  state: string;
  title: string;
  description: string;
  tags: string[];
  niche: string | null;
  price_usd: number | null;
  url: string | null;
  cycle_id: string | null;
  estimated_revenue_usd: number | null;
  total_cost_usd: number | null;
  net_usd: number | null;
  cfo_rationale: string | null;
  active_publish_count: number;
  first_listing_review_count: number;
};

export interface BudgetStatus {
  today_usd: number;
  hour_usd: number;
  month_usd: number;
  hourly_cap_usd: number;
  daily_cap_usd: number;
  monthly_cap_usd: number;
  burn_per_hour_usd: number;
}

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
  etsyLastError: () => invoke<string | null>("cmd_etsy_last_error"),
  etsyClearLastError: () => invoke<void>("cmd_etsy_clear_last_error"),
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
  listPrompts: () => invoke<Record<string, PromptRow>>("cmd_list_prompts"),
  setPromptOverride: (role: string, system: string) =>
    invoke<void>("cmd_set_prompt_override", { args: { role, system } }),
  clearPromptOverride: (role: string) =>
    invoke<void>("cmd_clear_prompt_override", { role }),
  promptHistory: (role: string, limit?: number) =>
    invoke<PromptHistoryEntry[]>("cmd_prompt_history", { role, limit }),
  readAssetSvg: (listingId: number) =>
    invoke<string | null>("cmd_read_asset_svg", { listingId }),
  etsyListingReviewInfo: (localListingId: number) =>
    invoke<ListingReviewInfo>("cmd_etsy_listing_review_info", {
      localListingId,
    }),
  etsyDiscardDraft: (localListingId: number) =>
    invoke<void>("cmd_etsy_discard_draft", { localListingId }),
  budgetStatus: (): Promise<BudgetStatus> => invoke("cmd_budget_status"),
  startSmokeTest: (): Promise<string> => invoke("cmd_start_smoke_test"),
  resumeFromSmokeTest: (): Promise<void> => invoke("cmd_resume_from_smoke_test"),
  listRecentJobs: (opts?: {
    limit?: number;
    role?: string | null;
    sinceUnix?: number | null;
  }): Promise<JobRow[]> =>
    invoke("cmd_list_recent_jobs", {
      limit: opts?.limit ?? 50,
      role: opts?.role ?? null,
      sinceUnix: opts?.sinceUnix ?? null,
    }),
  rateJob: (jobId: number, rating: "up" | "down" | null, note?: string | null) =>
    invoke<void>("cmd_rate_job", {
      args: { job_id: jobId, rating, note: note ?? null },
    }),
  readJobSvg: (jobId: number): Promise<string | null> =>
    invoke("cmd_read_job_svg", { jobId }),
  unratedJobCount: (): Promise<number> => invoke("cmd_unrated_job_count"),
};
