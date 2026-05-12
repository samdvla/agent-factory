export type AgentVisualState =
  | "idle" | "working" | "walking" | "awaiting"
  | "paused" | "crashed" | "killed" | "quarantined"
  | "materializing" | "dissolving";

export type AvatarArchetype =
  | "authoritative" | "slim" | "relaxed" | "office"
  | "friendly" | "formal" | "lab";

export type RoomTag =
  | "bridge" | "analyst" | "creative" | "copy" | "comms"
  | "finance" | "rd" | "ops" | "legal" | "archive" | "dev";

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
  model: "Haiku" | "Sonnet" | "Opus";
  tokensToday: number;
  currentJobId: number | null;
  restartIn?: number;
  walkTarget?: string;
};

export type TickerEntry = { ts: number; source: string; text: string };

export type AlertItem = {
  kind: "warn" | "err"; title: string; sub: string; ts: number; agent?: string;
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
    model: "Haiku" | "Sonnet" | "Opus";
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
  budgetTodayUsd: number;
  budgetCapUsd: number;
  /** True once the supervisor has emitted budget_capped for today. */
  budgetCapped: boolean;
  revenueTodayUsd: number;
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
  /** Last 5 buyer DMs ingested via the real Etsy conversations poller. Newest first. */
  etsyRecentMessages: Array<{
    conversation_id: number;
    snippet: string;
    ts: number;
  }>;
  /** True once the kill-switch has fired this session. UI surfaces a banner. */
  etsyKilled: boolean;

  markRealActivity: (roleId: string) => void;
  bumpEtsyPublishesRev: () => void;
  pushEtsyReceipt: (r: { receipt_id: number; revenue_usd: number; txns: number; ts: number }) => void;
  pushEtsyMessage: (m: { conversation_id: number; snippet: string; ts: number }) => void;
  setEtsyKilled: (v: boolean) => void;

  setAgentState: (role: string, state: AgentVisualState) => void;
  setAgentJob: (role: string, jobId: number | null) => void;
  setAgentTask: (role: string, task: string) => void;
  walkAgent: (role: string, target: string | null) => void;
  pushTicker: (entry: TickerEntry) => void;
  pushAlert: (a: AlertItem) => void;
  dismissAlert: (idx: number) => void;
  setPendingGate: (g: GateRequest | null) => void;
  selectAgent: (role: string | null) => void;
  setSandbox: (v: boolean) => void;
  setAllStop: (v: boolean) => void;
  setBudget: (usd: number) => void;
  setBudgetCapped: (v: boolean) => void;
  pushHandoff: (h: Handoff) => void;
  expireHandoffs: (now: number) => void;
  bumpActivity: () => void;
  setAgentTravel: (roleId: string, target: FactoryStore["agentTravel"][string] | null) => void;
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
};
