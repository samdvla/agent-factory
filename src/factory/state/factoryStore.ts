import { create } from "zustand";
import {
  AgentEntry,
  AgentVisualState,
  AlertItem,
  GateRequest,
  Handoff,
  TickerEntry,
} from "./types";
import { INITIAL_AGENTS } from "./fixtures";

export type FactoryStore = {
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
  handoffs: Handoff[];
  lastActivityAt: number;
  agentTravel: Record<
    string,
    {
      roomId: string;
      stationIdx: number;
      waypoints?: Array<{ x: number; y: number }>;
      startedAt?: number;
      durationPerSegmentMs?: number;
    } | undefined
  >;

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
  setAgentTravel: (
    roleId: string,
    target:
      | {
          roomId: string;
          stationIdx: number;
          waypoints?: Array<{ x: number; y: number }>;
          startedAt?: number;
          durationPerSegmentMs?: number;
        }
      | null,
  ) => void;
};

export const useFactoryStore = create<FactoryStore>((set) => ({
  agents: INITIAL_AGENTS,
  ticker: [],
  alerts: [],
  pendingGate: null,
  selectedAgent: null,
  drawerOpen: false,
  sandbox: true,
  allStop: false,
  budgetTodayUsd: 0,
  budgetCapUsd: 10.0,
  handoffs: [],
  lastActivityAt: 0,
  agentTravel: {},

  setAgentState: (role, state) => set((s) => ({
    agents: { ...s.agents, [role]: { ...s.agents[role], state } },
    lastActivityAt: Date.now(),
  })),
  setAgentJob: (role, jobId) => set((s) => ({
    agents: { ...s.agents, [role]: { ...s.agents[role], currentJobId: jobId } },
  })),
  setAgentTask: (role, task) => set((s) => ({
    agents: { ...s.agents, [role]: { ...s.agents[role], task } },
  })),
  walkAgent: (role, target) => set((s) => ({
    agents: { ...s.agents, [role]: {
      ...s.agents[role],
      walkTarget: target ?? undefined,
      state: target ? "walking" : "idle",
    }},
    lastActivityAt: Date.now(),
  })),
  pushTicker: (entry) => set((s) => ({ ticker: [entry, ...s.ticker].slice(0, 200) })),
  pushAlert: (a) => set((s) => ({ alerts: [a, ...s.alerts].slice(0, 50) })),
  dismissAlert: (idx) => set((s) => ({ alerts: s.alerts.filter((_, i) => i !== idx) })),
  setPendingGate: (g) => set({ pendingGate: g }),
  selectAgent: (role) => set({ selectedAgent: role, drawerOpen: role !== null }),
  setSandbox: (v) => set({ sandbox: v }),
  setAllStop: (v) => set({ allStop: v }),
  setBudget: (usd) => set({ budgetTodayUsd: usd }),
  pushHandoff: (h) => set((s) => ({
    handoffs: [...s.handoffs, h],
    lastActivityAt: Date.now(),
  })),
  expireHandoffs: (now) => set((s) => {
    const live = s.handoffs.filter((h) => now - h.startedAt < h.durationMs + 200);
    return live.length === s.handoffs.length ? s : { handoffs: live };
  }),
  bumpActivity: () => set({ lastActivityAt: Date.now() }),
  setAgentTravel: (roleId, target) => set((s) => {
    const next = { ...s.agentTravel };
    if (target) next[roleId] = target;
    else delete next[roleId];
    return { agentTravel: next, lastActivityAt: Date.now() };
  }),
}));
