import { invoke } from "@tauri-apps/api/core";
import { isRemoteMode, remoteFetch } from "./remote";

/**
 * When the user has configured a remote mini (window.__af_remote.set or
 * Settings → Remote factory), read-only endpoints route through HTTP
 * instead of Tauri's local invoke. Mutating commands still invoke locally
 * for now — they ship in a later phase 1 slice once a UI confirmation
 * gate is in place so the laptop can't accidentally double-publish.
 */
function remoteOr<T>(path: string, local: () => Promise<T>): Promise<T> {
  return isRemoteMode() ? remoteFetch<T>(path) : local();
}

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
  state: string; // 'draft' | 'queued' | 'active' | 'rejected' | 'inactive' | 'expired'
  title: string;
  url: string | null;
  published_at: number;
  activated_at: number | null;
  parent_listing_id: number | null;
};

export type ListingRejectionRow = {
  id: number;
  local_listing_id: number;
  cycle_id: string | null;
  title: string;
  niche: string | null;
  tags_json: string;
  description: string;
  rejected_at: number;
  reason: string | null;
};

export type ActivateResult = {
  etsy_listing_id: number;
  url: string | null;
};

export type EtsyResyncResult = {
  checked: number;
  expired: number;
  updated_state: number;
  unchanged: number;
  errors: number;
};
export type MarketplaceResyncStats = EtsyResyncResult;
export type MarketplaceId =
  | "etsy"
  | "cults3d"
  | "sketchfab"
  | "mmf"
  | "gumroad"
  | "pinterest";
export type ResyncAllResult = {
  etsy: MarketplaceResyncStats;
  cults3d: MarketplaceResyncStats;
  sketchfab: MarketplaceResyncStats;
  mmf: MarketplaceResyncStats;
  gumroad: MarketplaceResyncStats;
  pinterest: MarketplaceResyncStats;
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

export interface AgentTodayStats {
  role: string;
  tokens_today: number;
  completed_today: number;
  failed_today: number;
}

export interface RevenueBySource {
  source: string;
  net_usd: number;
  sales_count: number;
}

export interface SpendByModel {
  model: string;
  usd: number;
  calls: number;
}

export interface TodayStats {
  budget_today_usd: number;
  revenue_today_usd: number;
  budget_lifetime_usd: number;
  revenue_lifetime_usd: number;
  revenue_by_source: RevenueBySource[];
  spend_by_model: SpendByModel[];
  per_agent: AgentTodayStats[];
}

export const api = {
  status: () =>
    remoteOr<StatusReport>("/api/status", () => invoke<StatusReport>("cmd_status")),
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
  etsyListPublishes: () =>
    remoteOr<EtsyPublishRow[]>("/api/etsy/publishes", () =>
      invoke<EtsyPublishRow[]>("cmd_etsy_list_publishes")
    ),
  etsyActivateListing: (localListingId: number) =>
    invoke<ActivateResult>("cmd_etsy_activate_listing", {
      localListingId,
    }),
  etsyKillSwitch: () => invoke<void>("cmd_etsy_kill_switch"),
  etsyResyncListings: () => invoke<EtsyResyncResult>("cmd_etsy_resync_listings"),
  resyncMarketplace: (marketplace: MarketplaceId): Promise<MarketplaceResyncStats> =>
    invoke("cmd_resync_marketplace", { marketplace }),
  resyncAllMarketplaces: (): Promise<ResyncAllResult> =>
    invoke("cmd_resync_all_marketplaces"),
  listRecentCycles: (limit?: number) =>
    remoteOr<CycleSummary[]>(
      `/api/recent_cycles${limit ? `?limit=${limit}` : ""}`,
      () => invoke<CycleSummary[]>("cmd_list_recent_cycles", { limit })
    ),
  listWealth: () =>
    remoteOr<AgentWealth[]>("/api/wealth", () =>
      invoke<AgentWealth[]>("cmd_list_wealth")
    ),
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
  etsyRegenerateDraft: (localListingId: number) =>
    invoke<void>("cmd_etsy_regenerate_draft", { localListingId }),
  etsyRejectDraft: (localListingId: number, reason?: string | null) =>
    invoke<void>("cmd_etsy_reject_draft", {
      localListingId,
      reason: reason ?? null,
    }),
  etsyRestoreRejected: (localListingId: number) =>
    invoke<void>("cmd_etsy_restore_rejected", { localListingId }),
  etsyCancelRegeneration: (localListingId: number) =>
    invoke<void>("cmd_etsy_cancel_regeneration", { localListingId }),
  etsyListRejections: (limit?: number) =>
    invoke<ListingRejectionRow[]>("cmd_etsy_list_rejections", { limit }),
  budgetStatus: (): Promise<BudgetStatus> =>
    remoteOr<BudgetStatus>("/api/budget", () => invoke("cmd_budget_status")),
  startSmokeTest: (): Promise<string> => invoke("cmd_start_smoke_test"),
  resumeFromSmokeTest: (): Promise<void> => invoke("cmd_resume_from_smoke_test"),
  listRecentJobs: (opts?: {
    limit?: number;
    offset?: number;
    role?: string | null;
    sinceUnix?: number | null;
  }): Promise<JobRow[]> =>
    invoke("cmd_list_recent_jobs", {
      limit: opts?.limit ?? 50,
      offset: opts?.offset ?? 0,
      role: opts?.role ?? null,
      sinceUnix: opts?.sinceUnix ?? null,
    }),
  countRecentJobs: (opts?: {
    role?: string | null;
    sinceUnix?: number | null;
  }): Promise<number> =>
    invoke("cmd_count_recent_jobs", {
      role: opts?.role ?? null,
      sinceUnix: opts?.sinceUnix ?? null,
    }),
  todayStats: (): Promise<TodayStats> =>
    remoteOr<TodayStats>("/api/today_stats", () => invoke("cmd_today_stats")),
  rateJob: (jobId: number, rating: "up" | "down" | null, note?: string | null) =>
    invoke<void>("cmd_rate_job", {
      args: { job_id: jobId, rating, note: note ?? null },
    }),
  readJobSvg: (jobId: number): Promise<string | null> =>
    invoke("cmd_read_job_svg", { jobId }),
  unratedJobCount: (sinceUnix: number): Promise<number> =>
    invoke("cmd_unrated_job_count", { sinceUnix }),
  printifyVerify: (apiKey: string): Promise<PrintifyVerifyOk> =>
    invoke("cmd_printify_verify", { apiKey }),
  printifyStatus: (): Promise<PrintifyStatus> => invoke("cmd_printify_status"),
  tripoVerify: (apiKey: string): Promise<TripoVerifyOk> =>
    invoke("cmd_tripo_verify", { apiKey }),
  tripoStatus: (): Promise<TripoStatus> => invoke("cmd_tripo_status"),
  meshyVerify: (apiKey: string): Promise<MeshyVerifyOk> =>
    invoke("cmd_meshy_verify", { apiKey }),
  meshyStatus: (): Promise<MeshyStatus> => invoke("cmd_meshy_status"),
  googleVerify: (apiKey: string): Promise<GoogleAiVerifyOk> =>
    invoke("cmd_google_verify", { apiKey }),
  googleStatus: (): Promise<GoogleAiStatus> => invoke("cmd_google_status"),
  cults3dVerify: (username: string, apiKey: string): Promise<Cults3dVerifyOk> =>
    invoke("cmd_cults3d_verify", { username, apiKey }),
  cults3dStatus: (): Promise<Cults3dStatus> => invoke("cmd_cults3d_status"),
  cults3dSetEnabled: (enabled: boolean): Promise<void> =>
    invoke("cmd_cults3d_set_enabled", { enabled }),
  cults3dSetDailyCap: (cap: number): Promise<void> =>
    invoke("cmd_cults3d_set_daily_cap", { cap }),
  cults3dListPublishes: (limit?: number): Promise<Cults3dPublishRow[]> =>
    invoke("cmd_cults3d_list_publishes", { limit }),
  pinterestVerify: (
    accessToken: string,
    boardId: string,
  ): Promise<PinterestVerifyOk> =>
    invoke("cmd_pinterest_verify", { accessToken, boardId }),
  pinterestStatus: (): Promise<PinterestStatus> => invoke("cmd_pinterest_status"),
  pinterestSetEnabled: (enabled: boolean): Promise<void> =>
    invoke("cmd_pinterest_set_enabled", { enabled }),
  pinterestSetDailyCap: (cap: number): Promise<void> =>
    invoke("cmd_pinterest_set_daily_cap", { cap }),
  pinterestDisconnect: (): Promise<void> => invoke("cmd_pinterest_disconnect"),
  pinterestListPins: (limit?: number): Promise<PinterestPinRow[]> =>
    invoke("cmd_pinterest_list_pins", { limit }),
  telegramStatus: (): Promise<TelegramStatus> => invoke("cmd_telegram_status"),
  telegramVerify: (botToken: string, chatId: number): Promise<TelegramVerifyOk> =>
    invoke("cmd_telegram_verify", { botToken, chatId }),
  telegramSetEnabled: (enabled: boolean): Promise<void> =>
    invoke("cmd_telegram_set_enabled", { enabled }),
  telegramDisconnect: (): Promise<void> => invoke("cmd_telegram_disconnect"),
  sketchfabVerify: (apiToken: string): Promise<SketchfabVerifyOk> =>
    invoke("cmd_sketchfab_verify", { apiToken }),
  sketchfabStatus: (): Promise<SketchfabStatus> => invoke("cmd_sketchfab_status"),
  sketchfabSetEnabled: (enabled: boolean): Promise<void> =>
    invoke("cmd_sketchfab_set_enabled", { enabled }),
  sketchfabSetSellOnStore: (sell: boolean): Promise<void> =>
    invoke("cmd_sketchfab_set_sell_on_store", { sell }),
  sketchfabSetDailyCap: (cap: number): Promise<void> =>
    invoke("cmd_sketchfab_set_daily_cap", { cap }),
  sketchfabListPublishes: (limit?: number): Promise<SketchfabPublishRow[]> =>
    invoke("cmd_sketchfab_list_publishes", { limit }),
  gumroadVerify: (accessToken: string): Promise<GumroadVerifyOk> =>
    invoke("cmd_gumroad_verify", { accessToken }),
  gumroadStatus: (): Promise<GumroadStatus> => invoke("cmd_gumroad_status"),
  gumroadSetEnabled: (enabled: boolean): Promise<void> =>
    invoke("cmd_gumroad_set_enabled", { enabled }),
  gumroadSetDailyCap: (cap: number): Promise<void> =>
    invoke("cmd_gumroad_set_daily_cap", { cap }),
  gumroadListPublishes: (limit?: number): Promise<GumroadPublishRow[]> =>
    invoke("cmd_gumroad_list_publishes", { limit }),
  mmfVerify: (apiKey: string): Promise<MmfVerifyOk> =>
    invoke("cmd_mmf_verify", { apiKey }),
  mmfStatus: (): Promise<MmfStatus> => invoke("cmd_mmf_status"),
  mmfStartOAuth: (clientId: string, clientSecret: string): Promise<OAuthInit> =>
    invoke("cmd_mmf_start_oauth", { clientId, clientSecret }),
  mmfDisconnect: (): Promise<void> => invoke("cmd_mmf_disconnect"),
  mmfLastOAuthError: (): Promise<string | null> =>
    invoke("cmd_mmf_last_oauth_error"),
  mmfSetEnabled: (enabled: boolean): Promise<void> =>
    invoke("cmd_mmf_set_enabled", { enabled }),
  mmfSetSellPaid: (sell: boolean): Promise<void> =>
    invoke("cmd_mmf_set_sell_paid", { sell }),
  mmfSetDailyCap: (cap: number): Promise<void> =>
    invoke("cmd_mmf_set_daily_cap", { cap }),
  mmfListPublishes: (limit?: number): Promise<MmfPublishRow[]> =>
    invoke("cmd_mmf_list_publishes", { limit }),
  youtubeVerify: (apiKey: string): Promise<YoutubeVerifyOk> =>
    invoke("cmd_youtube_verify", { apiKey }),
  youtubeStatus: (): Promise<YoutubeStatus> => invoke("cmd_youtube_status"),
  higgsfieldStatus: (): Promise<HiggsfieldStatus> => invoke("cmd_higgsfield_status"),
  higgsfieldSetEnabled: (enabled: boolean): Promise<void> =>
    invoke("cmd_higgsfield_set_enabled", { enabled }),
  githubAssetHostVerify: (
    repo: string,
    token: string,
  ): Promise<AssetHostVerifyOk> =>
    invoke("cmd_github_asset_host_verify", { repo, token }),
  readJobAsset: (jobId: number): Promise<JobAssetInfo> =>
    invoke("cmd_read_job_asset", { jobId }),
  readListingAsset: (listingId: number): Promise<JobAssetInfo> =>
    invoke("cmd_read_listing_asset", { listingId }),
  getShopFocus: (): Promise<{ value: string }> => invoke("cmd_get_shop_focus"),
  setShopFocus: (value: string): Promise<void> =>
    invoke("cmd_set_shop_focus", { value }),
  getCharacterPool: (): Promise<{ value: string }> =>
    invoke("cmd_get_character_pool"),
  setCharacterPool: (value: string): Promise<void> =>
    invoke("cmd_set_character_pool", { value }),
  getImageTo3dProvider: (): Promise<{ value: string }> =>
    invoke("cmd_get_image_to_3d_provider"),
  setImageTo3dProvider: (value: string): Promise<void> =>
    invoke("cmd_set_image_to_3d_provider", { value }),
  postAgentMessage: (msg: {
    from_role: string;
    to_role: string;
    topic?: string | null;
    content: string;
    importance?: AgentMessageImportance | null;
    job_id?: number | null;
  }): Promise<number> => invoke("cmd_post_agent_message", { args: msg }),
  listAgentMessages: (opts?: {
    limit?: number;
    role?: string | null;
  }): Promise<AgentMessageRow[]> =>
    invoke("cmd_list_agent_messages", {
      limit: opts?.limit ?? 100,
      role: opts?.role ?? null,
    }),
  agentMessagesSince: (sinceUnix: number): Promise<number> =>
    invoke("cmd_agent_messages_since", { sinceUnix }),
  chatWithAgent: (
    agentId: string,
    history: ChatTurn[],
    message: string,
  ): Promise<ChatReply> =>
    invoke("cmd_chat_with_agent", { agentId, history, message }),
  agentSteerRoles: (): Promise<string[]> => invoke("cmd_agent_steer_roles"),
  agentSteerAdd: (
    role: string,
    text: string,
    imagePaths: string[] = [],
  ): Promise<void> =>
    invoke("cmd_agent_steer_add", {
      args: { role, text, image_paths: imagePaths },
    }),
  agentSteerList: (role: string): Promise<SteerEntry[]> =>
    invoke("cmd_agent_steer_list", { role }),
  agentSteerClear: (role: string): Promise<void> =>
    invoke("cmd_agent_steer_clear", { role }),
  // Save image bytes to ~/.agent-factory/steer-assets/<role>/. Returns the
  // absolute path the caller passes back to agentSteerAdd via imagePaths.
  agentSteerSaveImage: (
    role: string,
    bytes: Uint8Array,
    ext: string,
  ): Promise<string> =>
    invoke("cmd_agent_steer_save_image", {
      args: { role, bytes: Array.from(bytes), ext },
    }),
};

export type SteerEntry = {
  text: string;
  image_paths: string[];
};

export type ChatTurn = { from: "user" | "agent"; text: string };
export type ChatReply = {
  text: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
};

export type AgentMessageImportance = "info" | "heads_up" | "critical";
export type AgentMessageRow = {
  id: number;
  from_role: string;
  to_role: string;
  topic: string | null;
  content: string;
  importance: AgentMessageImportance;
  job_id: number | null;
  ts: number;
};

export type PrintifyVerifyOk = {
  shop_id: number;
  shop_title: string;
  channel: string;
};
export type PrintifyStatus = {
  key_present: boolean;
  shop_id: number | null;
  pod_enabled: boolean;
};
export type TripoStatus = {
  key_present: boolean;
  balance: number | null;
};
export type TripoVerifyOk = {
  balance: number;
};
export type MeshyStatus = {
  key_present: boolean;
  balance: number | null;
};
export type MeshyVerifyOk = {
  balance: number;
};
export type GoogleAiStatus = {
  key_present: boolean;
};
export type GoogleAiVerifyOk = {
  model: string;
};
export type Cults3dStatus = {
  creds_present: boolean;
  asset_host_configured: boolean;
  enabled: boolean;
  daily_cap: number;
  today_count: number;
};
export type Cults3dVerifyOk = { username: string };
export type AssetHostVerifyOk = { repo: string; default_branch: string };
export type Cults3dPublishRow = {
  id: number;
  local_listing_id: number | null;
  cults3d_creation_id: string | null;
  title: string;
  url: string | null;
  file_url: string | null;
  image_url: string | null;
  price_usd: number | null;
  state: string;
  error: string | null;
  published_at: number;
};
export type PinterestStatus = {
  creds_present: boolean;
  board_name: string | null;
  enabled: boolean;
  daily_cap: number;
  today_count: number;
};
export type PinterestVerifyOk = { board_name: string };
export type TelegramStatus = {
  creds_present: boolean;
  bot_username: string | null;
  chat_id: number | null;
  enabled: boolean;
};
export type TelegramVerifyOk = { bot_username: string };
export type PinterestPinRow = {
  id: number;
  local_listing_id: number | null;
  pinterest_pin_id: string | null;
  title: string;
  url: string | null;
  etsy_url: string | null;
  state: string;
  error: string | null;
  published_at: number;
};
export type SketchfabStatus = {
  creds_present: boolean;
  enabled: boolean;
  sell_on_store: boolean;
  daily_cap: number;
  today_count: number;
};
export type SketchfabVerifyOk = { username: string };
export type SketchfabPublishRow = {
  id: number;
  local_listing_id: number | null;
  sketchfab_uid: string | null;
  store_product_id: string | null;
  title: string;
  url: string | null;
  price_usd: number | null;
  state: string;
  error: string | null;
  warning: string | null;
  published_at: number;
};
export type GumroadStatus = {
  creds_present: boolean;
  enabled: boolean;
  daily_cap: number;
  today_count: number;
};
export type GumroadVerifyOk = { account: string };
export type GumroadPublishRow = {
  id: number;
  local_listing_id: number | null;
  gumroad_product_id: string | null;
  title: string;
  short_url: string | null;
  edit_url: string | null;
  price_usd: number | null;
  state: string;
  error: string | null;
  warning: string | null;
  published_at: number;
};
export type MmfStatus = {
  creds_present: boolean;
  enabled: boolean;
  sell_paid: boolean;
  daily_cap: number;
  today_count: number;
  client_id: string | null;
  oauth_user_id: string | null;
};
export type MmfVerifyOk = { account: string };
export type MmfPublishRow = {
  id: number;
  local_listing_id: number | null;
  mmf_object_id: string | null;
  title: string;
  url: string | null;
  price_usd: number | null;
  state: string;
  error: string | null;
  warning: string | null;
  published_at: number;
};
export type YoutubeStatus = { key_present: boolean };
export type YoutubeVerifyOk = { sample_video_title: string };
export type HiggsfieldStatus = {
  cli_installed: boolean;
  cli_authed: boolean;
  enabled: boolean;
};
export type JobAssetInfo = {
  /** "svg" | "glb" | "stl" | "png" | "none" */
  kind: string;
  path: string | null;
  glb_path: string | null;
  bytes: number;
  data_base64: string;
  glb_data_base64: string | null;
  png_data_base64: string | null;
};
