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

export type Handoff = {
  id: string;
  fromRoom: string;
  toRoom: string;
  color: string;
  label: string;
  startedAt: number;
  durationMs: number;
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

  markRealActivity: (roleId: string) => void;

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
  pushHandoff: (h: Handoff) => void;
  expireHandoffs: (now: number) => void;
  bumpActivity: () => void;
  setAgentTravel: (roleId: string, target: FactoryStore["agentTravel"][string] | null) => void;
  addRevenue: (roleId: string, usd: number) => void;

  fireHireEvent: (e: HireEvent) => void;
  dissolveAgent: (roleId: string) => void;
  idleDissolveTick: (now: number, idleThresholdMs?: number) => void;
};
