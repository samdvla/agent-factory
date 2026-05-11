import { create } from "zustand";
import { FactoryStore } from "./types";
import {
  INITIAL_AGENTS, ROLES as FOUNDING_ROLES, ROOMS as FOUNDING_ROOMS,
} from "./fixtures";
import {
  fireHireEvent as fireHireEventImpl,
  dissolveAgent as dissolveAgentImpl,
  idleDissolveTick as idleDissolveTickImpl,
} from "./hireResolver";

export type { FactoryStore };

export const useFactoryStore = create<FactoryStore>((set, get) => ({
  roles: { ...FOUNDING_ROLES },
  rooms: { ...FOUNDING_ROOMS },
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
  budgetCapped: false,
  revenueTodayUsd: 0,
  revenueByRole: {},
  handoffs: [],
  lastActivityAt: 0,
  realActivityAt: {},
  agentTravel: {},
  agentLastIdleAt: {},
  agentCreatedAt: {},
  recentCycles: [],
  wealthByRole: {},
  etsyPublishesRev: 0,
  etsyRecentReceipts: [],
  etsyRecentMessages: [],
  etsyKilled: false,

  setAgentState: (role, state) => set((s) => ({
    agents: { ...s.agents, [role]: { ...s.agents[role], state } },
    lastActivityAt: Date.now(),
    agentLastIdleAt: state === "idle"
      ? { ...s.agentLastIdleAt, [role]: Date.now() }
      : { ...s.agentLastIdleAt, [role]: 0 },
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
  setBudgetCapped: (v) => set({ budgetCapped: v }),
  pushHandoff: (h) => set((s) => ({ handoffs: [...s.handoffs, h], lastActivityAt: Date.now() })),
  expireHandoffs: (now) => set((s) => {
    const live = s.handoffs.filter((h) => now - h.startedAt < h.durationMs + 200);
    return live.length === s.handoffs.length ? s : { handoffs: live };
  }),
  bumpActivity: () => set({ lastActivityAt: Date.now() }),
  setAgentTravel: (roleId, target) => set((s) => {
    const next = { ...s.agentTravel };
    if (target) next[roleId] = target; else delete next[roleId];
    return { agentTravel: next, lastActivityAt: Date.now() };
  }),
  markRealActivity: (roleId) => set((s) => ({
    realActivityAt: { ...s.realActivityAt, [roleId]: Date.now() },
  })),
  bumpEtsyPublishesRev: () => set((s) => ({ etsyPublishesRev: s.etsyPublishesRev + 1 })),
  pushEtsyReceipt: (r) => set((s) => ({
    etsyRecentReceipts: [r, ...s.etsyRecentReceipts].slice(0, 5),
  })),
  pushEtsyMessage: (m) => set((s) => ({
    etsyRecentMessages: [m, ...s.etsyRecentMessages].slice(0, 5),
  })),
  setEtsyKilled: (v) => set({ etsyKilled: v }),

  addRevenue: (roleId, usd) => set((s) => ({
    revenueTodayUsd: s.revenueTodayUsd + usd,
    revenueByRole: {
      ...s.revenueByRole,
      [roleId]: (s.revenueByRole[roleId] ?? 0) + usd,
    },
    lastActivityAt: Date.now(),
  })),

  fireHireEvent: (e) => fireHireEventImpl(set, get, e),
  dissolveAgent: (roleId) => dissolveAgentImpl(set, get, roleId),
  idleDissolveTick: (now, idleThresholdMs) => idleDissolveTickImpl(set, get, now, idleThresholdMs),

  setRecentCycles: (cycles) => set({ recentCycles: cycles }),
  setWealthByRole: (m) => set({ wealthByRole: m }),
}));
