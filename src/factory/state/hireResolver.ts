import {
  AgentEntry, FactoryStore, HireEvent, Role, Room, RoomKit, RoomTag,
} from "./types";
import { kitFromTag, TAG_ACCENTS } from "../svg/kit/recipes";
import { placeNewRoom } from "../svg/layout";

type SetFn = (
  partial: Partial<FactoryStore> | ((s: FactoryStore) => Partial<FactoryStore>),
  replace?: boolean,
) => void;
type GetFn = () => FactoryStore;

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

function newRoleId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

function newRoomId(tag: RoomTag): string {
  return `${tag}-${Math.random().toString(36).slice(2, 6)}`;
}

export function fireHireEvent(set: SetFn, get: GetFn, e: HireEvent): void {
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
      col: pos.col,
      row: pos.row,
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
}

export function dissolveAgent(set: SetFn, get: GetFn, roleId: string): void {
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
}

export function idleDissolveTick(
  set: SetFn,
  get: GetFn,
  now: number,
  idleThresholdMs = 90_000,
): void {
  const state = get();
  for (const role of Object.values(state.roles)) {
    if (role.permanent) continue;
    const agent = state.agents[role.id];
    if (!agent) continue;
    if (agent.state !== "idle") continue;
    const lastIdle = state.agentLastIdleAt[role.id] ?? 0;
    if (lastIdle && now - lastIdle > idleThresholdMs) {
      dissolveAgent(set, get, role.id);
    }
  }
}
