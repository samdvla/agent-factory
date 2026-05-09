import { ROOMS } from "../state/fixtures";
import { roomOrigin } from "./geometry";

export type Station = { x: number; y: number; label: string };

/**
 * Per-room-kind stations, in room-local grid coords (0..ROOM_W, 0..ROOM_H).
 * Each station is positioned to align with a visible prop in RoomProps so
 * walking avatars look like they're heading to a real spot in the room.
 */
export const STATIONS_BY_KIND: Record<string, Station[]> = {
  // Strategy Room — boss's office. Podium at the holo, executive desk in
  // the NE, lounge in the SW, plus the back data wall.
  bridge: [
    { x: 3.0, y: 4.7, label: "command podium" },
    { x: 5.0, y: 2.6, label: "executive desk" },
    { x: 1.4, y: 5.5, label: "lounge sofa" },
    { x: 3.0, y: 1.4, label: "data wall" },
  ],
  // Research Lab — dual terminals, sample shelf (east), trends wall (south)
  analyst: [
    { x: 2.4, y: 4.7, label: "terminal A" },
    { x: 3.7, y: 4.7, label: "terminal B" },
    { x: 4.7, y: 3.5, label: "samples shelf" },
    { x: 3.0, y: 1.4, label: "trends wall" },
  ],
  // Design Studio — render desk, color rack, drafting board, mood wall
  fab: [
    { x: 2.6, y: 4.7, label: "render desk" },
    { x: 4.7, y: 4.5, label: "color rack" },
    { x: 1.1, y: 4.6, label: "drafting board" },
    { x: 3.0, y: 1.4, label: "mood wall" },
  ],
  // Listing Desk — three monitors + kanban wall (Theo + Avery share)
  dispatch: [
    { x: 1.7, y: 4.6, label: "draft monitor" },
    { x: 3.0, y: 4.6, label: "review monitor" },
    { x: 4.3, y: 4.6, label: "publish monitor" },
    { x: 3.0, y: 1.4, label: "kanban board" },
  ],
  // CS Booth — central terminal + 3 case windows on the back wall
  comms: [
    { x: 3.0, y: 4.7, label: "chat console" },
    { x: 1.5, y: 1.4, label: "case #1" },
    { x: 3.0, y: 1.4, label: "case #2" },
    { x: 4.5, y: 1.4, label: "case #3" },
  ],
  // Finance Office — ledger desk, safe (east), PnL wall, audit cart
  control: [
    { x: 3.0, y: 4.7, label: "ledger desk" },
    { x: 4.5, y: 3.5, label: "safe" },
    { x: 3.0, y: 1.4, label: "P&L wall" },
    { x: 1.4, y: 4.7, label: "audit cart" },
  ],
  // SI Lab — terminal, experiment bench, server rack, log wall
  rd: [
    { x: 1.7, y: 4.6, label: "lab terminal" },
    { x: 3.0, y: 4.7, label: "experiment bench" },
    { x: 4.5, y: 4.8, label: "server rack" },
    { x: 3.0, y: 1.4, label: "log wall" },
  ],
};

/**
 * Translate a station to world-iso grid coordinates by offsetting it into
 * the target room. Returns `null` if the room is unknown.
 */
export function stationWorld(
  roomId: string,
  idx: number,
): { x: number; y: number; label: string } | null {
  const room = ROOMS[roomId];
  if (!room) return null;
  const list = STATIONS_BY_KIND[room.kind];
  if (!list || !list.length) return null;
  const st = list[((idx % list.length) + list.length) % list.length];
  const { wx, wy } = roomOrigin(room.col, room.row);
  return { x: wx + st.x, y: wy + st.y, label: st.label };
}

export function stationCount(roomId: string): number {
  const room = ROOMS[roomId];
  if (!room) return 1;
  const list = STATIONS_BY_KIND[room.kind];
  return list?.length ?? 1;
}

/**
 * Pick a base/home-station index per role so two agents that share a room
 * (like Theo + Avery on the listing desk) start at different monitors.
 */
export function homeStationFor(roleId: string, roomId: string): number {
  const count = stationCount(roomId);
  if (count <= 1) return 0;
  // simple deterministic hash so each role gets a stable home station
  let h = 0;
  for (let i = 0; i < roleId.length; i++) h = (h * 31 + roleId.charCodeAt(i)) | 0;
  return Math.abs(h) % count;
}
