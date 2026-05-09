export type AgentVisualState =
  | "idle" | "working" | "walking" | "awaiting"
  | "paused" | "crashed" | "killed" | "quarantined";

export type Role = {
  id: string; name: string; title: string; hex: string;
  archetype: "authoritative" | "slim" | "relaxed" | "office" | "friendly" | "formal" | "lab";
  portrait: string; room: string;
};

export type Room = {
  id: string; name: string; occupant: string;
  col: number; row: number;
  kind: "bridge" | "analyst" | "fab" | "dispatch" | "comms" | "control" | "rd";
};

export type AgentEntry = {
  role: string; name: string; state: AgentVisualState;
  task: string; model: "Haiku" | "Sonnet" | "Opus";
  tokensToday: number; currentJobId: number | null;
  restartIn?: number; walkTarget?: string;
};

export type TickerEntry = { ts: number; source: string; text: string };

export type AlertItem = {
  kind: "warn" | "err"; title: string; sub: string; ts: number; agent?: string;
};

export type GateRequest = {
  agent: string; actionClass: string; title: string;
  rationale: string; payload: Record<string, unknown>;
};
