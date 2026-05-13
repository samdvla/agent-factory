import { create } from "zustand";
import { AgentEntry, FactoryStore, IsoThemeName } from "./types";
import {
  INITIAL_AGENTS, ROLES as FOUNDING_ROLES, ROOMS as FOUNDING_ROOMS,
} from "./fixtures";

/**
 * Build a full AgentEntry on the fly when the supervisor emits an event for
 * a role we don't have a fixtures entry for (e.g. a worker added in Python
 * but not yet in INITIAL_AGENTS). Prevents spread-from-undefined producing
 * a half-shape entry that then crashes SideDrawer's `.toLocaleString()`.
 */
function ensureAgent(
  agents: Record<string, AgentEntry>,
  role: string,
): AgentEntry {
  const existing = agents[role];
  if (existing) return existing;
  return {
    role,
    name: role.charAt(0).toUpperCase() + role.slice(1),
    state: "idle",
    task: "",
    model: "Haiku",
    tokensToday: 0,
    completedToday: 0,
    failedToday: 0,
    currentJobId: null,
  };
}
import {
  fireHireEvent as fireHireEventImpl,
  dissolveAgent as dissolveAgentImpl,
  idleDissolveTick as idleDissolveTickImpl,
} from "./hireResolver";

/** Map a raw Anthropic model id ("claude-opus-4-7", "claude-sonnet-4-6-20251001")
 *  to the short display label the drawer/queue render. Returns null when the
 *  id doesn't resemble a recognized family — caller leaves the badge alone. */
function shortModelLabel(modelId: string | null | undefined): string | null {
  if (!modelId || typeof modelId !== "string") return null;
  const s = modelId.toLowerCase();
  // Pull out a version token after the family name (e.g. "4-7" → "4.7").
  const versionMatch = s.match(/(?:opus|sonnet|haiku)-(\d+[-.]\d+)/);
  const version = versionMatch ? versionMatch[1].replace("-", ".") : "";
  if (s.includes("opus")) return version ? `Opus ${version}` : "Opus";
  if (s.includes("sonnet")) return version ? `Sonnet ${version}` : "Sonnet";
  if (s.includes("haiku")) return version ? `Haiku ${version}` : "Haiku";
  return null;
}

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

const ISO_THEME_STORAGE_KEY = "agentFactory.isoTheme";
function readIsoThemeDefault(): IsoThemeName {
  try {
    const v = localStorage.getItem(ISO_THEME_STORAGE_KEY);
    if (v === "warm" || v === "clinic" || v === "night") return v;
  } catch {}
  return "warm";
}

// Avatar star/tier progress persists to localStorage so restarting the app
// doesn't wipe every agent back to zero stars. The map is small (≤10 roles
// × 3 fields) so writing on every awardProgress is cheap. Backfill from
// lifetime revenue (via agent_wealth) happens on cold start in App.tsx
// when localStorage is empty.
const REWARDS_STORAGE_KEY = "agentFactory.rewardsByRole";
type RewardEntry = { stars: number; tier: number; progressUsd: number };
function readRewardsDefault(): Record<string, RewardEntry> {
  try {
    const v = localStorage.getItem(REWARDS_STORAGE_KEY);
    if (!v) return {};
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Light validation: drop anything that isn't shape-compatible so a
      // corrupted entry can't crash the SVG floor.
      const clean: Record<string, RewardEntry> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (
          v &&
          typeof v === "object" &&
          typeof (v as RewardEntry).stars === "number" &&
          typeof (v as RewardEntry).tier === "number" &&
          typeof (v as RewardEntry).progressUsd === "number"
        ) {
          clean[k] = v as RewardEntry;
        }
      }
      return clean;
    }
  } catch {}
  return {};
}
function persistRewards(m: Record<string, RewardEntry>): void {
  try {
    localStorage.setItem(REWARDS_STORAGE_KEY, JSON.stringify(m));
  } catch {}
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
  isoTheme: readIsoThemeDefault(),
  allStop: false,
  supervisorRunning: false,
  budgetTodayUsd: 0,
  budgetCapUsd: 10.0,
  budgetCapped: false,
  revenueTodayUsd: 0,
  budgetLifetimeUsd: 0,
  revenueLifetimeUsd: 0,
  revenueByRole: {},
  rewardsByRole: readRewardsDefault(),
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
  etsyKilled: false,

  setAgentState: (role, state) => set((s) => ({
    agents: { ...s.agents, [role]: { ...ensureAgent(s.agents, role), state } },
    lastActivityAt: Date.now(),
    agentLastIdleAt: state === "idle"
      ? { ...s.agentLastIdleAt, [role]: Date.now() }
      : { ...s.agentLastIdleAt, [role]: 0 },
  })),
  setAgentJob: (role, jobId) => set((s) => ({
    agents: { ...s.agents, [role]: { ...ensureAgent(s.agents, role), currentJobId: jobId } },
  })),
  setAgentTask: (role, task) => set((s) => ({
    agents: { ...s.agents, [role]: { ...ensureAgent(s.agents, role), task } },
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
      ...ensureAgent(s.agents, role),
      walkTarget: target ?? undefined,
      state: target ? "walking" : "idle",
    }},
    lastActivityAt: Date.now(),
  })),
  pushTicker: (entry) => set((s) => ({ ticker: [entry, ...s.ticker].slice(0, 200) })),
  pushAlert: (a) => set((s) => {
    // Dedupe: if the same title + sub fired in the last 30 seconds, just
    // bump the counter on the existing alert and refresh its timestamp.
    // Stops the alert tray from filling up with "Etsy publish failed × 4"
    // when one bad GLB or stuck Tripo task fires the same error repeatedly.
    const DEDUPE_WINDOW_MS = 30_000;
    const head = s.alerts[0];
    if (
      head &&
      head.kind === a.kind &&
      head.title === a.title &&
      head.sub === a.sub &&
      a.ts - head.ts < DEDUPE_WINDOW_MS
    ) {
      const next = [...s.alerts];
      next[0] = { ...head, ts: a.ts, count: (head.count ?? 1) + 1 };
      return { alerts: next };
    }
    return { alerts: [{ ...a, count: 1 }, ...s.alerts].slice(0, 50) };
  }),
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
  setSupervisorRunning: (v) => set({ supervisorRunning: v }),
  setIsoTheme: (v) => {
    try {
      localStorage.setItem(ISO_THEME_STORAGE_KEY, v);
    } catch {}
    set({ isoTheme: v });
  },
  setBudget: (usd) => set({ budgetTodayUsd: usd }),
  setBudgetCapped: (v) => set({ budgetCapped: v }),
  setRevenueToday: (usd) => set({ revenueTodayUsd: usd }),
  setLifetimeTotals: (revenueUsd, budgetUsd) =>
    set({ revenueLifetimeUsd: revenueUsd, budgetLifetimeUsd: budgetUsd }),
  hydratePerAgentTodayStats: (stats) => set((s) => {
    // Build a role → counters map from the DB snapshot. Anything not in the
    // snapshot stays at zero (no jobs today for that role yet).
    const byRole = new Map<string, { tokens: number; completed: number; failed: number }>();
    for (const row of stats) {
      byRole.set(row.role, {
        tokens: row.tokens_today,
        completed: row.completed_today,
        failed: row.failed_today,
      });
    }
    const nextAgents: typeof s.agents = { ...s.agents };
    // Hydrate every known agent — even those with zero rows — so a restart
    // with no jobs today still produces a deterministic state.
    for (const role of Object.keys(s.agents)) {
      const cur = s.agents[role];
      const seeded = byRole.get(role) ?? { tokens: 0, completed: 0, failed: 0 };
      nextAgents[role] = {
        ...cur,
        tokensToday: seeded.tokens,
        completedToday: seeded.completed,
        failedToday: seeded.failed,
      };
    }
    // Also fold in any roles present in the DB but missing from the in-memory
    // agents map (e.g. a worker added in Python but not in INITIAL_AGENTS).
    for (const [role, seeded] of byRole.entries()) {
      if (nextAgents[role]) continue;
      nextAgents[role] = {
        role,
        name: role.charAt(0).toUpperCase() + role.slice(1),
        state: "idle",
        task: "",
        model: "Haiku",
        tokensToday: seeded.tokens,
        completedToday: seeded.completed,
        failedToday: seeded.failed,
        currentJobId: null,
      };
    }
    return { agents: nextAgents };
  }),
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
  setAgentModel: (roleId, modelId) => set((s) => {
    const label = shortModelLabel(modelId);
    if (!label) return {};
    const existing = s.agents[roleId];
    const next: AgentEntry = existing
      ? { ...existing, model: label }
      : { ...ensureAgent(s.agents, roleId), model: label };
    if (existing && existing.model === label) return {};
    return { agents: { ...s.agents, [roleId]: next } };
  }),
  markRealActivity: (roleId) => set((s) => ({
    realActivityAt: { ...s.realActivityAt, [roleId]: Date.now() },
  })),
  bumpEtsyPublishesRev: () => set((s) => ({ etsyPublishesRev: s.etsyPublishesRev + 1 })),
  pushEtsyReceipt: (r) => set((s) => ({
    etsyRecentReceipts: [r, ...s.etsyRecentReceipts].slice(0, 5),
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
    const nextRewards = {
      ...s.rewardsByRole,
      [roleId]: { stars, tier, progressUsd: progress },
    };
    // Persist immediately — the in-memory map is the source of truth, and
    // localStorage is the cold-start cache that survives app restart.
    persistRewards(nextRewards);
    return { rewardsByRole: nextRewards };
  }),

  fireHireEvent: (e) => fireHireEventImpl(set, get, e),
  dissolveAgent: (roleId, opts) => dissolveAgentImpl(set, get, roleId, opts),
  idleDissolveTick: (now, idleThresholdMs) => idleDissolveTickImpl(set, get, now, idleThresholdMs),

  setRecentCycles: (cycles) => set({ recentCycles: cycles }),
  setWealthByRole: (m) => set({ wealthByRole: m }),
  setRewardsByRole: (m) => {
    persistRewards(m);
    set({ rewardsByRole: m });
  },
  setRevenueByRole: (m) => set({ revenueByRole: m }),
}));

// In dev (vite serves outside Tauri), the supervisor API rejects so the
// floor never picks up "running". Exposing the store on window lets devtools
// and end-to-end checks flip flags without round-tripping the backend.
if (import.meta.env.DEV) {
  (window as unknown as { __factoryStore?: typeof useFactoryStore }).__factoryStore = useFactoryStore;
}
