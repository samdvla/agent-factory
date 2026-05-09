import { create } from "zustand";
import {
  AgentEntry, AgentVisualState, AlertItem, GateRequest,
  Handoff, HireEvent, Role, Room, RoomTag, TickerEntry, RoomKit,
} from "./types";
import {
  INITIAL_AGENTS, ROLES as FOUNDING_ROLES, ROOMS as FOUNDING_ROOMS,
} from "./fixtures";
import { kitFromTag, TAG_ACCENTS } from "../svg/kit/recipes";
import { placeNewRoom } from "../svg/layout";

const ROOM_NAME_BY_TAG: Record<RoomTag, string> = {
  bridge:   "Strategy Annex",
  analyst:  "Research Wing",
  creative: "Design Annex",
  copy:     "Listing Wing",
  comms:    "Comms Hub",
  finance:  "Finance Annex",
  rd:       "Research Bay",
  ops:      "Ops Bay",
  legal:    "Legal Office",
  archive:  "Archive Room",
  dev:      "Dev Bay",
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
  agentTravel: Record<string, {
    roomId: string;
    stationIdx: number;
    waypoints?: Array<{ x: number; y: number }>;
    startedAt?: number;
    durationPerSegmentMs?: number;
  } | undefined>;
  agentLastIdleAt: Record<string, number>;

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

function newRoleId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

function newRoomId(tag: RoomTag): string {
  return `${tag}-${Math.random().toString(36).slice(2, 6)}`;
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
  sandbox: true,
  allStop: false,
  budgetTodayUsd: 0,
  budgetCapUsd: 10.0,
  revenueTodayUsd: 0,
  revenueByRole: {},
  handoffs: [],
  lastActivityAt: 0,
  agentTravel: {},
  agentLastIdleAt: {},

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
  addRevenue: (roleId, usd) => set((s) => ({
    revenueTodayUsd: s.revenueTodayUsd + usd,
    revenueByRole: {
      ...s.revenueByRole,
      [roleId]: (s.revenueByRole[roleId] ?? 0) + usd,
    },
    lastActivityAt: Date.now(),
  })),

  fireHireEvent: (e) => {
    const state = get();
    const { roleSpec, justification } = e;
    const tag = roleSpec.primaryTag;
    const accent = roleSpec.accent ?? TAG_ACCENTS[tag];

    let roomId: string;
    const candidates = Object.values(state.rooms).filter(
      (r) => r.kit?.primaryTag === tag
        && (r.occupants?.length ?? 0) < (r.kit.capacity ?? 1),
    );
    if (candidates.length) {
      const sameTag = Object.values(state.rooms).filter((r) => r.kit?.primaryTag === tag);
      const centroid = {
        col: sameTag.reduce((s, r) => s + r.col, 0) / sameTag.length,
        row: sameTag.reduce((s, r) => s + r.row, 0) / sameTag.length,
      };
      candidates.sort((a, b) => {
        const da = Math.abs(a.col - centroid.col) + Math.abs(a.row - centroid.row);
        const db = Math.abs(b.col - centroid.col) + Math.abs(b.row - centroid.row);
        return da - db;
      });
      roomId = candidates[0].id;
    } else {
      const allRooms = Object.values(state.rooms);
      const pos = placeNewRoom(allRooms, tag);
      const newKit: RoomKit = kitFromTag(tag, accent);
      const newId = newRoomId(tag);
      roomId = newId;
      const newRoom: Room = {
        id: newId,
        name: ROOM_NAME_BY_TAG[tag],
        occupant: roleSpec.name,
        col: pos.col,
        row: pos.row,
        kind: "rd",
        kit: newKit,
        occupants: [],
        createdAt: e.ts,
      };
      set((s) => ({ rooms: { ...s.rooms, [newId]: newRoom } }));
    }

    const roleId = newRoleId(roleSpec.name);
    const role: Role = {
      id: roleId,
      name: roleSpec.name,
      title: roleSpec.title,
      hex: accent,
      archetype: roleSpec.archetype,
      portrait: roleSpec.portrait ?? roleSpec.name[0]?.toUpperCase() ?? "?",
      room: roomId,
      permanent: justification.reason === "founding",
    };
    const agent: AgentEntry = {
      role: roleId,
      name: roleSpec.name,
      state: "materializing",
      task: "",
      model: roleSpec.model,
      tokensToday: 0,
      currentJobId: null,
    };
    set((s) => ({
      roles: { ...s.roles, [roleId]: role },
      agents: { ...s.agents, [roleId]: agent },
      rooms: {
        ...s.rooms,
        [roomId]: {
          ...s.rooms[roomId],
          occupants: [...(s.rooms[roomId].occupants ?? []), roleId],
        },
      },
    }));

    get().pushTicker({
      ts: e.ts || Date.now(),
      source: roleId,
      text: `hired ${roleSpec.name} · ${justification.metric}`,
    });

    const isPermanent = justification.reason === "founding";
    setTimeout(() => {
      const live = get().agents[roleId];
      if (!live || live.state !== "materializing") return;
      // Permanent (founding) roles: hand off to the founding loop (idle baseline).
      // Specialists: enter a randomized working window so the user sees them
      // earn their keep before idle-dissolve fires.
      if (isPermanent) {
        get().setAgentState(roleId, "idle");
        return;
      }
      get().setAgentState(roleId, "working");
      get().setAgentTask(roleId, `${justification.reason}: handling load`);
      const workMs = 45_000 + Math.random() * 30_000; // 45–75s
      setTimeout(() => {
        const stillThere = get().agents[roleId];
        if (stillThere && stillThere.state === "working") {
          get().setAgentState(roleId, "idle");
        }
      }, workMs);
    }, 600);
  },

  dissolveAgent: (roleId) => {
    const state = get();
    const role = state.roles[roleId];
    if (!role) return;
    if (role.permanent) return;

    set((s) => ({
      agents: {
        ...s.agents,
        [roleId]: { ...s.agents[roleId], state: "dissolving" },
      },
    }));

    const earned = get().revenueByRole[roleId] ?? 0;
    if (earned > 0) {
      get().pushTicker({
        ts: Date.now(),
        source: roleId,
        text: `dissolved · earned $${earned.toFixed(2)}`,
      });
    }

    setTimeout(() => {
      const cur = get();
      const nextRoles = { ...cur.roles };
      const nextAgents = { ...cur.agents };
      delete nextRoles[roleId];
      delete nextAgents[roleId];

      const nextRevenue = { ...cur.revenueByRole };
      const nextIdle = { ...cur.agentLastIdleAt };
      delete nextRevenue[roleId];
      delete nextIdle[roleId];

      const room = cur.rooms[role.room];
      const occupants = (room?.occupants ?? []).filter((r) => r !== roleId);
      const willDissolveRoom = !!room && occupants.length === 0;

      const nextRooms = room
        ? { ...cur.rooms, [role.room]: { ...room, occupants, dissolving: willDissolveRoom } }
        : cur.rooms;
      set({ roles: nextRoles, agents: nextAgents, rooms: nextRooms,
            revenueByRole: nextRevenue, agentLastIdleAt: nextIdle });

      if (willDissolveRoom) {
        setTimeout(() => {
          const after = get();
          const nr = { ...after.rooms };
          delete nr[role.room];
          set({ rooms: nr });
        }, 800);
      }
    }, 900);
  },

  idleDissolveTick: (now, idleThresholdMs = 90_000) => {
    const state = get();
    for (const role of Object.values(state.roles)) {
      if (role.permanent) continue;
      const agent = state.agents[role.id];
      if (!agent) continue;
      if (agent.state !== "idle") continue;
      const lastIdle = state.agentLastIdleAt[role.id] ?? 0;
      if (lastIdle && now - lastIdle > idleThresholdMs) {
        get().dissolveAgent(role.id);
      }
    }
  },
}));
