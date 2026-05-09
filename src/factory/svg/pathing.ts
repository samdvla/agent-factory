import { useFactoryStore } from "../state/factoryStore";
import { findPath, Waypoint } from "./layout";
import { stationWorld } from "./stations";

export type { Waypoint };

export function planRoomToRoomPath(
  fromRoomId: string, fromStationIdx: number,
  toRoomId: string, toStationIdx: number,
): Waypoint[] {
  const rooms = Object.values(useFactoryStore.getState().rooms);
  const path = findPath(rooms, fromRoomId, toRoomId);
  if (!path.length) return [];

  const start = stationWorld(fromRoomId, fromStationIdx);
  const end = stationWorld(toRoomId, toStationIdx);
  if (!start || !end) return path;

  return [start, ...path.slice(1, -1), end];
}
