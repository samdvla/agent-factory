export type AgentVisualState =
  | "idle" | "working" | "walking" | "awaiting"
  | "paused" | "crashed" | "killed" | "quarantined"
  | "materializing" | "dissolving";

/** Iso room theme — controls floor/wall/glass palette across every room. */
export type IsoThemeName = "warm" | "clinic" | "night";

export type AvatarArchetype =
  | "authoritative" | "slim" | "relaxed" | "office"
  | "friendly" | "formal" | "lab"
  // Designer-wing specialists. Each maps to a distinct hair/hat
  // silhouette in Avatar.tsx so the small avatars stay readable.
  | "anime_spec" | "hero_spec" | "mecha_spec" | "chibi_spec"
  | "deity_spec" | "creature_spec" | "humanoid_spec";

export type RoomTag =
  | "bridge" | "analyst" | "creative" | "copy" | "comms"
  | "finance" | "rd" | "ops" | "legal" | "archive" | "dev"
  | "marketing"
  // Specialist rooms that work UNDER the lead designer. Smaller visual
  // footprint than founding rooms; each one is themed for one character
  // archetype the designer routes briefs to.
  | "anime_studio" | "hero_studio" | "mecha_bay" | "chibi_corner"
  | "deity_atelier" | "creature_den" | "humanoid_forge";

export type WallFeature =
  | "kanban" | "trends" | "moodboard" | "ledger" | "logwall"
  | "chatwall" | "warmap" | "datafeed" | "archive" | "docs";

export type StationLayout = "row" | "cluster" | "central" | "perimeter";

export type RoomFeature =
  | "bookshelf" | "binder-stack" | "color-rack" | "drafting" | "printer"
  | "safe" | "file-cabinet" | "conference-table" | "lab-bench" | "law-shelf"
  | "file-safe" | "terminal-rack" | "server-rack" | "phone-bank" | "headset"
  | "queue-board" | "archive-wall"
  | "kpi-panel" | "token-meter" | "carousel" | "cable-tray" | "doc-stamp";

export type RoomKit = {
  primaryTag: RoomTag;
  capacity: number;            // 1..6
  accent: string;
  stationLayout: StationLayout;
  wallFeature: WallFeature;
  features: RoomFeature[];
};

export type Role = {
  id: string;
  name: string;
  title: string;
  hex: string;
  archetype: AvatarArchetype;
  portrait: string;
  room: string;
  permanent?: boolean;          // founding=true; specialists=false/undefined
};

export type Room = {
  id: string;
  name: string;
  col: number;
  row: number;
  kit?: RoomKit;                // populated by hire resolver
  occupants?: string[];         // role ids occupying this room
  createdAt?: number;
  dissolving?: boolean;
};

export type AgentEntry = {
  role: string;
  name: string;
  state: AgentVisualState;
  task: string;
  /** Short label of the model the worker last reported (e.g. "Opus 4.7",
   *  "Sonnet 4.6", "Haiku 4.5"). Initially seeded from fixtures and updated
   *  on every `budget_spent` event so the drawer/queue reflects the real
   *  model in use right now, not a stale design-time guess. */
  model: string;
  /** Sum of input + output tokens charged to this agent since app start. */
  tokensToday: number;
  /** Count of job_completed events for this agent since app start. */
  completedToday: number;
  /** Count of job_failed events for this agent since app start. */
  failedToday: number;
  currentJobId: number | null;
  restartIn?: number;
  walkTarget?: string;
};

export type TickerEntry = { ts: number; source: string; text: string };

export type AlertItem = {
  kind: "warn" | "err"; title: string; sub: string; ts: number; agent?: string;
  /** Number of times this same alert has fired in quick succession. The
   *  store collapses identical alerts within a short window and bumps this
   *  counter instead of stacking duplicates. */
  count?: number;
};

export type GateRequest = {
  agent: string; actionClass: string; title: string;
  rationale: string; payload: Record<string, unknown>;
};

// Re-export the IPC shapes from api.ts so the store stays in lockstep with the
// Rust command schemas. Define once, use everywhere.
export type { CycleSummary, AgentWealth } from "../../api";
import type { CycleSummary, AgentWealth } from "../../api";

export type Handoff = {
  id: string;
  fromRoom: string;
  toRoom: string;
  color: string;
  label: string;
  startedAt: number;
  durationMs: number;
};

export type EtsyStatus = {
  connected: boolean;
  shop_id: number | null;
  shop_name: string | null;
  expires_at: number | null;
  needs_refresh: boolean;
};

export type HireEvent = {
  id: string;
  ts: number;
  roleSpec: {
    name: string;
    title: string;
    primaryTag: RoomTag;
    archetype: AvatarArchetype;
    /** Short label of the worker's model (e.g. "Opus 4.7", "Sonnet 4.6"),
     *  matching AgentEntry.model so a hire event can pass the value through
     *  unchanged. */
    model: string;
    accent?: string;
    portrait?: string;
  };
  justification: {
    reason:
      | "queue_backlog" | "dispute_volume" | "niche_demand"
      | "translation_demand" | "tax_cycle" | "ops_load"
      | "founding";
    metric: string;
    expectedRoiUsd?: number;
  };
};

export type FactoryStore = {
  roles: Record<string, Role>;
  rooms: Record<string, Room>;
  agents: Record<string, AgentEntry>;
  ticker: TickerEntry[];
  alerts: AlertItem[];
  pendingGate: GateRequest | null;
  selectedAgent: string | null;
  drawerOpen: boolean;
  sandbox: boolean;
  allStop: boolean;
  /** True while the supervisor is currently running (driven by api.status
   *  polling from TopBar). The factory floor uses this to decide whether
   *  to drive agents through their walk → dwell cycle; when false they
   *  stand still at their home stations. */
  supervisorRunning: boolean;
  budgetTodayUsd: number;
  budgetCapUsd: number;
  /** True once the supervisor has emitted budget_capped for today. */
  budgetCapped: boolean;
  revenueTodayUsd: number;
  /** Lifetime spend across every provider (Claude, Tripo, Meshy, Gemini,
   *  Etsy listing fees, etc.). Single source of truth for the TopBar
   *  Net pill — daily figures are still tracked for cap enforcement but
   *  not surfaced to the user-facing Revenue/Net display. Hydrated from
   *  cmd_today_stats.budget_lifetime_usd on a 5s poll. */
  budgetLifetimeUsd: number;
  /** Lifetime net revenue across every marketplace (sum of
   *  revenue_ledger.net_usd). Surfaced as the TopBar Revenue value. */
  revenueLifetimeUsd: number;
  revenueByRole: Record<string, number>;
  handoffs: Handoff[];
  lastActivityAt: number;
  /** Tracks when a real (supervisor-backed) ticker last fired per role id. */
  realActivityAt: Record<string, number>;
  agentTravel: Record<string, {
    roomId: string;
    stationIdx: number;
    waypoints?: Array<{ x: number; y: number }>;
    startedAt?: number;
    durationPerSegmentMs?: number;
  } | undefined>;
  agentLastIdleAt: Record<string, number>;
  /** Wall-clock ms when each non-founding role was first created (used for the
   *  60s wealth-grace period in idle dissolution). */
  agentCreatedAt: Record<string, number>;
  /** Last 20 P&L cycles, populated from cmd_list_recent_cycles. */
  recentCycles: CycleSummary[];
  /** Lifetime wealth per role, populated from cmd_list_wealth. */
  wealthByRole: Record<string, AgentWealth>;
  /** Reward stars rendered on each avatar's chest. Stars go 1..10 in the
   *  current tier; reaching the 10-star threshold for that tier resets to
   *  1 star in the next tier's color. Tiers: 0 bronze → 1 silver → 2 gold
   *  → 3 platinum → 4 diamond. `progressUsd` accumulates sub-threshold
   *  progress between star awards — stars are only granted when progress
   *  crosses the per-tier dollar threshold (see TIER_STAR_USD in the
   *  store). Diamond stars cost $500 of contribution each, so making it
   *  to a single diamond star requires ≈ $1.8k of lifetime value. */
  rewardsByRole: Record<string, { stars: number; tier: number; progressUsd: number }>;
  /** Monotonic counter bumped whenever Etsy publish state changes, so panels can refetch. */
  etsyPublishesRev: number;
  /** Last 5 receipts ingested via the real Etsy receipts poller. Newest first. */
  etsyRecentReceipts: Array<{
    receipt_id: number;
    revenue_usd: number;
    txns: number;
    ts: number;
  }>;
  /** True once the kill-switch has fired this session. UI surfaces a banner. */
  etsyKilled: boolean;

  markRealActivity: (roleId: string) => void;
  bumpEtsyPublishesRev: () => void;
  pushEtsyReceipt: (r: { receipt_id: number; revenue_usd: number; txns: number; ts: number }) => void;
  setEtsyKilled: (v: boolean) => void;

  setAgentState: (role: string, state: AgentVisualState) => void;
  setAgentJob: (role: string, jobId: number | null) => void;
  setAgentTask: (role: string, task: string) => void;
  addAgentTokens: (role: string, tokens: number) => void;
  incrementAgentCompleted: (role: string) => void;
  incrementAgentFailed: (role: string) => void;
  walkAgent: (role: string, target: string | null) => void;
  pushTicker: (entry: TickerEntry) => void;
  pushAlert: (a: AlertItem) => void;
  dismissAlert: (idx: number) => void;
  setPendingGate: (g: GateRequest | null) => void;
  selectAgent: (role: string | null) => void;
  setSandbox: (v: boolean) => void;
  /** Active iso room theme (warm/clinic/night). Persisted to localStorage. */
  isoTheme: IsoThemeName;
  setIsoTheme: (v: IsoThemeName) => void;
  setAllStop: (v: boolean) => void;
  setSupervisorRunning: (v: boolean) => void;
  setBudget: (usd: number) => void;
  setBudgetCapped: (v: boolean) => void;
  /** Replace today's revenue total (used on cold-start hydration from DB).
   *  Distinct from `addRevenue` which accumulates from live events. */
  setRevenueToday: (usd: number) => void;
  /** Hydrate the lifetime Net pill from cmd_today_stats. Both fields
   *  refresh together because they're surfaced as one Revenue / Net pair. */
  setLifetimeTotals: (revenueUsd: number, budgetUsd: number) => void;
  /** Seed per-agent today counters from the DB on cold start. The counters
   *  are kept in memory and incremented by live events afterward — this
   *  function is the one-shot hydrator. Pass an empty array to reset. */
  hydratePerAgentTodayStats: (
    stats: { role: string; tokens_today: number; completed_today: number; failed_today: number }[],
  ) => void;
  pushHandoff: (h: Handoff) => void;
  expireHandoffs: (now: number) => void;
  bumpActivity: () => void;
  setAgentTravel: (roleId: string, target: FactoryStore["agentTravel"][string] | null) => void;
  /** Update an agent's displayed model label from a live `budget_spent`
   *  event. Pass the raw model id (e.g. "claude-opus-4-7") — the store
   *  normalizes to a short display label. */
  setAgentModel: (roleId: string, modelId: string) => void;
  addRevenue: (roleId: string, usd: number) => void;
  /** Add USD-denominated reward progress for a role. Stars are granted
   *  when accumulated progress crosses the current tier's per-star
   *  threshold; reaching 10 stars in a tier and crossing the next
   *  threshold advances to the next tier with stars reset to 1.
   *  Diamond tier (4) is the cap — overflow just keeps adding stars
   *  within the diamond tier up to 10 and then idles. */
  awardProgress: (roleId: string, usd: number) => void;

  fireHireEvent: (e: HireEvent) => void;
  dissolveAgent: (roleId: string, opts?: { force?: boolean }) => void;
  idleDissolveTick: (now: number, idleThresholdMs?: number) => void;

  setRecentCycles: (cycles: CycleSummary[]) => void;
  setWealthByRole: (m: Record<string, AgentWealth>) => void;
  /** Cold-start hydrator for avatar stars/tiers. Also persists the map to
   *  localStorage so subsequent restarts read it back without a backend
   *  round-trip. */
  setRewardsByRole: (m: Record<string, { stars: number; tier: number; progressUsd: number }>) => void;
  /** Cold-start hydrator for the in-memory per-role revenue map (used by
   *  the dissolve ticker). Lifetime values come from the DB via the
   *  `agent_wealth` table. */
  setRevenueByRole: (m: Record<string, number>) => void;
};
