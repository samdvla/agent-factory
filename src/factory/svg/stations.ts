import { useFactoryStore } from "../state/factoryStore";
import { roomOrigin } from "./geometry";
import { layoutStations } from "./kit/composer";

export type Station = { x: number; y: number; label: string };

/**
 * Synthetic "rest" waypoints layered on top of the room's real work stations.
 * They live in the same world-coordinate frame so AvatarLayer can mix them
 * into its rotation cycle and the agent visibly walks away from its desk
 * (matching the handoff's continuous walk → dwell → walk loop) even in
 * rooms with only one real station.
 */
const REST_POINTS: Array<{ dx: number; dy: number; label: string }> = [
  { dx: 1.2, dy: 4.8, label: "stretching" },
  { dx: 4.0, dy: 5.2, label: "thinking" },
  { dx: 4.4, dy: 1.8, label: "pacing" },
];

export function stationWorld(roomId: string, idx: number): Station | null {
  const room = useFactoryStore.getState().rooms[roomId];
  if (!room || !room.kit) return null;
  const list = layoutStations(room.kit);
  if (!list.length) return null;
  const total = list.length + REST_POINTS.length;
  const wrapped = ((idx % total) + total) % total;
  const { wx, wy } = roomOrigin(room.col, room.row);
  if (wrapped < list.length) {
    const st = list[wrapped];
    return { x: wx + st.x, y: wy + st.y, label: st.label };
  }
  const r = REST_POINTS[wrapped - list.length];
  return { x: wx + r.dx, y: wy + r.dy, label: r.label };
}

export function stationCount(roomId: string): number {
  const room = useFactoryStore.getState().rooms[roomId];
  if (!room?.kit) return 1;
  return Math.max(1, layoutStations(room.kit).length + REST_POINTS.length);
}

/**
 * The "real" work station count (excluding rest waypoints). AvatarLayer uses
 * this to mark whether a chosen destination is a working seat or a wander
 * point, which in turn drives whether the agent renders the working glyph.
 */
export function workStationCount(roomId: string): number {
  const room = useFactoryStore.getState().rooms[roomId];
  if (!room?.kit) return 1;
  return Math.max(1, layoutStations(room.kit).length);
}

export function isWorkStation(roomId: string, idx: number): boolean {
  const total = stationCount(roomId);
  const wrapped = ((idx % total) + total) % total;
  return wrapped < workStationCount(roomId);
}

export function homeStationFor(roleId: string, roomId: string): number {
  const count = workStationCount(roomId);
  if (count <= 1) return 0;
  let h = 0;
  for (let i = 0; i < roleId.length; i++) h = (h * 31 + roleId.charCodeAt(i)) | 0;
  return Math.abs(h) % count;
}
