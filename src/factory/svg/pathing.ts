import { ROOMS } from "../state/fixtures";
import { stationWorld } from "./stations";

export type Waypoint = { x: number; y: number };

// Corridor centerlines (in world-grid units)
const COL_AB = 6.5;   // vertical corridor between col 0 and col 1
const COL_BC = 13.5;  // vertical corridor between col 1 and col 2
const ROW_01 = 6.5;   // horizontal corridor between row 0 and row 1 (full width)

function roomMidY(row: number) {
  return row * 7 + 3;
}

/**
 * Where the avatar exits its source room into the corridor system, and
 * which corridor centerline it lands on. Col 1 rooms can exit either side;
 * we pick the side closer to the destination column.
 */
function exitWaypoints(roomId: string, targetCol: number): { wps: Waypoint[]; corridorX: number } {
  const r = ROOMS[roomId];
  if (!r) return { wps: [], corridorX: COL_AB };
  const my = roomMidY(r.row);
  if (r.col === 0) {
    return { wps: [{ x: 6.0, y: my }, { x: COL_AB, y: my }], corridorX: COL_AB };
  }
  if (r.col === 2) {
    return { wps: [{ x: 14.0, y: my }, { x: COL_BC, y: my }], corridorX: COL_BC };
  }
  // col 1: pick the corridor closer to target col
  if (targetCol <= 1) {
    return { wps: [{ x: 7.0, y: my }, { x: COL_AB, y: my }], corridorX: COL_AB };
  }
  return { wps: [{ x: 13.0, y: my }, { x: COL_BC, y: my }], corridorX: COL_BC };
}

/**
 * Where the avatar enters the destination room from a given corridor.
 */
function entryWaypoints(roomId: string, fromCorridorX: number): Waypoint[] {
  const r = ROOMS[roomId];
  if (!r) return [];
  const my = roomMidY(r.row);
  if (r.col === 0) {
    // Only east door
    return [{ x: COL_AB, y: my }, { x: 6.0, y: my }];
  }
  if (r.col === 1) {
    if (fromCorridorX === COL_AB) {
      return [{ x: COL_AB, y: my }, { x: 7.0, y: my }];
    }
    return [{ x: COL_BC, y: my }, { x: 13.0, y: my }];
  }
  if (r.col === 2) {
    return [{ x: COL_BC, y: my }, { x: 14.0, y: my }];
  }
  return [];
}

/**
 * Plan a corridor-aware polyline from a start station to an end station
 * in another room. Each waypoint is in world-grid units.
 */
export function planRoomToRoomPath(
  fromRoomId: string, fromStationIdx: number,
  toRoomId: string, toStationIdx: number,
): Waypoint[] {
  if (fromRoomId === toRoomId) {
    const a = stationWorld(fromRoomId, fromStationIdx);
    const b = stationWorld(toRoomId, toStationIdx);
    return a && b ? [a, b] : [];
  }

  const from = ROOMS[fromRoomId];
  const to = ROOMS[toRoomId];
  if (!from || !to) return [];

  const start = stationWorld(fromRoomId, fromStationIdx);
  const end = stationWorld(toRoomId, toStationIdx);
  if (!start || !end) return [];

  const path: Waypoint[] = [start];

  const exit = exitWaypoints(fromRoomId, to.col);
  for (const w of exit.wps) path.push(w);

  // Choose which corridor centerline the destination wants to enter from.
  // Always use row 0/1 (full-width) for column crossings — it's guaranteed
  // continuous with both vertical corridors.
  const targetCorridorX =
    to.col === 0 ? COL_AB :
    to.col === 2 ? COL_BC :
    // col 1: enter from whichever side the path is currently on
    exit.corridorX;

  const toY = roomMidY(to.row);

  if (exit.corridorX !== targetCorridorX) {
    // Cross via row 0/1 corridor
    path.push({ x: exit.corridorX, y: ROW_01 });
    path.push({ x: targetCorridorX, y: ROW_01 });
    path.push({ x: targetCorridorX, y: toY });
  } else if (path[path.length - 1].y !== toY) {
    // Same corridor — slide vertically
    path.push({ x: exit.corridorX, y: toY });
  }

  const entry = entryWaypoints(toRoomId, targetCorridorX);
  for (const w of entry) path.push(w);

  path.push(end);
  return path;
}
