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

const SANDBOX_STORAGE_KEY = "agentFactory.mode.sandbox";
function readSandboxDefault(): boolean {
  try {
    const v = localStorage.getItem(SANDBOX_STORAGE_KEY);
    if (v === "true") return true;
    if (v === "false") return false;
  } catch {}
  return false; // default: Live mode
}

export const useFactoryStore = create<FactoryStore>((set, get) => ({
  roles: { ...FOUNDING_ROLES },
  rooms: { ...FOUNDING_ROOMS },
  agents: INITIAL_AGENTS,
  ticker: [],
  alerts: [],
  pendingGate: null,
  selectedAgent: null,
  drawerOpen: false,
  sandbox: readSandboxDefault(),
  allStop: false,
  budgetTodayUsd: 0,
  budgetCapUsd: 10.0,
  budgetCapped: false,
  revenueTodayUsd: 0,
  revenueByRole: {},
  rewardsByRole: {},
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
  addAgentTokens: (role, tokens) => set((s) => {
    const cur = s.agents[role];
    if (!cur || !Number.isFinite(tokens) || tokens <= 0) return {};
    return {
      agents: {
        ...s.agents,
        [role]: { ...cur, tokensToday: cur.tokensToday + tokens },
      },
    };
  }),
  incrementAgentCompleted: (role) => set((s) => {
    const cur = s.agents[role];
    if (!cur) return {};
    return {
      agents: {
        ...s.agents,
        [role]: { ...cur, completedToday: cur.completedToday + 1 },
      },
    };
  }),
  incrementAgentFailed: (role) => set((s) => {
    const cur = s.agents[role];
    if (!cur) return {};
    return {
      agents: {
        ...s.agents,
        [role]: { ...cur, failedToday: cur.failedToday + 1 },
      },
    };
  }),
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
  setSandbox: (v) => {
    try { localStorage.setItem(SANDBOX_STORAGE_KEY, String(v)); } catch {}
    // Mirror to backend secrets so the supervisor can apply safety checks.
    import("../../api").then(({ api }) => {
      api.setSecret("ui_sandbox_mode", String(v)).catch(() => {});
    });
    set({ sandbox: v });
  },
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

  awardProgress: (roleId, usd) => set((s) => {
    if (!roleId || !Number.isFinite(usd) || usd <= 0) return {};
    // Per-tier per-star dollar cost. Hard-coded scale: bronze stars are
    // cheap, diamond stars are expensive. Reaching the FIRST diamond
    // star costs ~$1,810 of contribution.
    //   bronze $1 → silver $5 → gold $25 → platinum $100 → diamond $500
    const TIER_STAR_USD = [1, 5, 25, 100, 500];
    const cur = s.rewardsByRole[roleId] ?? { stars: 0, tier: 0, progressUsd: 0 };
    let progress = cur.progressUsd + usd;
    let stars = cur.stars;
    let tier = cur.tier;
    while (true) {
      // 10 stars in this tier? Only advance if there's leftover progress
      // to apply at the next tier's price — otherwise sit at "10 stars in
      // tier T" until another reward arrives. Without this guard we'd
      // eagerly bump to tier T+1 with 0 stars the instant the 10th star
      // landed, which the boss would read as "they lost their tier."
      if (stars >= 10) {
        if (tier >= 4) {
          // Diamond cap: 10 stars is the max. Drain leftover progress so
          // it doesn't pool indefinitely.
          progress = 0;
          break;
        }
        if (progress <= 0) break;
        tier += 1;
        stars = 0;
        continue;
      }
      // Buy another star at the current tier's price if we can afford it.
      if (progress >= TIER_STAR_USD[tier]) {
        progress -= TIER_STAR_USD[tier];
        stars += 1;
      } else {
        break;
      }
    }
    return {
      rewardsByRole: {
        ...s.rewardsByRole,
        [roleId]: { stars, tier, progressUsd: progress },
      },
    };
  }),

  fireHireEvent: (e) => fireHireEventImpl(set, get, e),
  dissolveAgent: (roleId, opts) => dissolveAgentImpl(set, get, roleId, opts),
  idleDissolveTick: (now, idleThresholdMs) => idleDissolveTickImpl(set, get, now, idleThresholdMs),

  setRecentCycles: (cycles) => set({ recentCycles: cycles }),
  setWealthByRole: (m) => set({ wealthByRole: m }),
}));
