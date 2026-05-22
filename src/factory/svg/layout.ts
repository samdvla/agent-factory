import { Room } from "../state/types";
import { ROOM_W, ROOM_H, GAP } from "./geometry";

// Hard upper bound on the grid extent. The factory floor is a 10x10 grid of
// rooms; placeNewRoom will refuse to produce coordinates outside this range.
export const MAX_COLS = 10;
export const MAX_ROWS = 10;

export type Strip = { x0: number; y0: number; x1: number; y1: number };

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function roomCellX(col: number): { x0: number; x1: number } {
  const x0 = col * (ROOM_W + GAP);
  return { x0, x1: x0 + ROOM_W };
}

export function computeCorridors(rooms: Room[]): Strip[] {
  if (rooms.length < 2) return [];

  const cols = uniqueSorted(rooms.map((r) => r.col));
  const rows = uniqueSorted(rooms.map((r) => r.row));

  const colMin = Math.min(...cols);
  const colMax = Math.max(...cols);
  const rowMin = Math.min(...rows);
  const rowMax = Math.max(...rows);

  const yTop = rowMin * (ROOM_H + GAP);
  const yBot = (rowMax + 1) * (ROOM_H + GAP) - GAP;

  const strips: Strip[] = [];

  // Vertical corridors: between every pair of adjacent col indices in the
  // bounding box.
  for (let c = colMin; c < colMax; c++) {
    const gapX0 = (c + 1) * (ROOM_W + GAP) - GAP;
    const gapX1 = gapX0 + GAP;
    const hasLeft = rooms.some((r) => r.col === c);
    const hasRight = rooms.some((r) => r.col === c + 1);
    if (!hasLeft && !hasRight) continue;
    strips.push({ x0: gapX0, x1: gapX1, y0: yTop, y1: yBot });
  }

  // Horizontal corridors.
  for (let r = rowMin; r < rowMax; r++) {
    const gapY0 = (r + 1) * (ROOM_H + GAP) - GAP;
    const gapY1 = gapY0 + GAP;
    const adjacent = rooms.filter((rr) => rr.row === r || rr.row === r + 1);
    if (!adjacent.length) continue;
    const hasTop = adjacent.some((rr) => rr.row === r);
    const hasBot = adjacent.some((rr) => rr.row === r + 1);
    if (!hasTop || !hasBot) continue;
    // Span only columns that appear on both sides of the gap so the corridor
    // doesn't extend into columns that have no room on one of the two rows.
    const topCols = new Set(rooms.filter((rr) => rr.row === r).map((rr) => rr.col));
    const botCols = new Set(rooms.filter((rr) => rr.row === r + 1).map((rr) => rr.col));
    const sharedCols = [...topCols].filter((c) => botCols.has(c));
    const scopeCols = sharedCols.length ? sharedCols : [...topCols, ...botCols];
    const minCellX = Math.min(...scopeCols.map((c) => roomCellX(c).x0));
    const maxCellX = Math.max(...scopeCols.map((c) => roomCellX(c).x1));
    strips.push({ x0: minCellX, x1: maxCellX, y0: gapY0, y1: gapY1 });
  }

  return strips;
}

export type DoorSet = {
  north: boolean;   // always false (title wall)
  east: boolean;
  south: boolean;
  west: boolean;
};

export function computeDoors(rooms: Room[], corridors: Strip[]): Map<string, DoorSet> {
  const out = new Map<string, DoorSet>();
  for (const r of rooms) {
    const cellX = roomCellX(r.col);
    const y0 = r.row * (ROOM_H + GAP);
    const y1 = y0 + ROOM_H;
    const eps = 0.01;

    // East face is at x=cellX.x1. Strip is east-adjacent if its x0 == cellX.x1 (within eps)
    // and it overlaps the room's y range.
    const east = corridors.some(
      (c) => Math.abs(c.x0 - cellX.x1) < eps && c.y0 < y1 && c.y1 > y0,
    );
    // West face is at x=cellX.x0. Strip is west-adjacent if its x1 == cellX.x0.
    const west = corridors.some(
      (c) => Math.abs(c.x1 - cellX.x0) < eps && c.y0 < y1 && c.y1 > y0,
    );
    // South face at y=y1.
    const south = corridors.some(
      (c) => Math.abs(c.y0 - y1) < eps && c.x0 < cellX.x1 && c.x1 > cellX.x0,
    );
    out.set(r.id, { north: false, east, south, west });
  }
  return out;
}

import { RoomTag } from "../state/types";

function dist(a: { col: number; row: number }, b: { col: number; row: number }): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

function adjacentToCount(cell: { col: number; row: number }, rooms: Room[]): number {
  return rooms.filter((r) =>
    (Math.abs(r.col - cell.col) + Math.abs(r.row - cell.row)) === 1
  ).length;
}

function isolatesAnyRoom(cell: { col: number; row: number }, rooms: Room[]): boolean {
  // Approximation: a placement isolates a room if that room would have no
  // 4-connected room or `cell` neighbor after the placement. The check is
  // strong enough for our small grids.
  for (const r of rooms) {
    const others = [...rooms.filter((o) => o.id !== r.id), { col: cell.col, row: cell.row }];
    const hasNeighbor = others.some(
      (o) => Math.abs(o.col - r.col) + Math.abs(o.row - r.row) === 1,
    );
    if (!hasNeighbor) return true;
  }
  return false;
}

export function placeNewRoom(rooms: Room[], tag: RoomTag): { col: number; row: number } {
  if (rooms.length === 0) return { col: 0, row: 0 };

  const occupied = new Set(rooms.map((r) => `${r.col},${r.row}`));

  const sameTag = rooms.filter((r) => r.kit?.primaryTag === tag);
  const tagCent = sameTag.length
    ? {
        col: sameTag.reduce((s, r) => s + r.col, 0) / sameTag.length,
        row: sameTag.reduce((s, r) => s + r.row, 0) / sameTag.length,
      }
    : null;
  const globalCent = {
    col: rooms.reduce((s, r) => s + r.col, 0) / rooms.length,
    row: rooms.reduce((s, r) => s + r.row, 0) / rooms.length,
  };

  const candidates: { col: number; row: number }[] = [];
  const seen = new Set<string>();
  const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (const r of rooms) {
    for (const [dc, dr] of deltas) {
      const c = r.col + dc;
      const rr = r.row + dr;
      // Reject negative coords and any cell outside the 10x10 grid envelope.
      if (c < 0 || rr < 0) continue;
      if (c >= MAX_COLS || rr >= MAX_ROWS) continue;
      const key = `${c},${rr}`;
      if (occupied.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ col: c, row: rr });
    }
  }

  if (!candidates.length) {
    // Graceful fallback: scan col=0 for the lowest open row inside the bound.
    // If every cell on col=0 is taken, scan the whole grid in row-major order.
    for (let rr = 0; rr < MAX_ROWS; rr++) {
      if (!occupied.has(`0,${rr}`)) return { col: 0, row: rr };
    }
    for (let rr = 0; rr < MAX_ROWS; rr++) {
      for (let cc = 0; cc < MAX_COLS; cc++) {
        if (!occupied.has(`${cc},${rr}`)) return { col: cc, row: rr };
      }
    }
    // Grid fully saturated (100 rooms): clamp to last cell instead of crashing.
    return { col: MAX_COLS - 1, row: MAX_ROWS - 1 };
  }

  const W_TAG = 4.0, W_GLOBAL = 1.0, W_ADJ = 0.5, W_ISOLATE = 100.0, W_NORTH = 100.0;

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    let score = 0;
    if (tagCent) score += -W_TAG * dist(c, tagCent);
    score += -W_GLOBAL * dist(c, globalCent);
    score += W_ADJ * adjacentToCount(c, rooms);
    if (isolatesAnyRoom(c, rooms)) score -= W_ISOLATE;
    // Penalise cells that would only be accessible from the north (title wall — no door allowed).
    const hasNonNorth =
      rooms.some((o) => o.col === c.col + 1) ||
      rooms.some((o) => o.col === c.col - 1) ||
      rooms.some((o) => o.row === c.row + 1);
    if (!hasNonNorth) score -= W_NORTH;
    if (
      score > bestScore ||
      (score === bestScore &&
        (c.col < best.col || (c.col === best.col && c.row < best.row)))
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export type FacilityLayout = {
  hash: string;
  corridors: Strip[];
  doors: Map<string, DoorSet>;
};

export function roomsHash(rooms: Room[]): string {
  return rooms
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}@${r.col},${r.row}`)
    .join("|");
}

export function computeFacilityLayout(rooms: Room[]): FacilityLayout {
  const corridors = computeCorridors(rooms);
  return {
    hash: roomsHash(rooms),
    corridors,
    doors: computeDoors(rooms, corridors),
  };
}

export type Waypoint = { x: number; y: number };

function roomCenterPt(room: Room): Waypoint {
  const cx = roomCellX(room.col);
  const y0 = room.row * (ROOM_H + GAP);
  const y1 = y0 + ROOM_H;
  return { x: (cx.x0 + cx.x1) / 2, y: (y0 + y1) / 2 };
}

// --- A* pathfinder with corridor-cell graph and per-roomsHash cache ---

type GraphNode = { x: number; y: number; key: string; isRoom?: string };

let cachedGraph: {
  hash: string;
  nodes: Map<string, GraphNode>;
  edges: Map<string, Set<string>>;
} | null = null;

function buildGraph(rooms: Room[]): {
  nodes: Map<string, GraphNode>;
  edges: Map<string, Set<string>>;
} {
  const corridors = computeCorridors(rooms);
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, Set<string>>();

  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.key)) {
      nodes.set(n.key, n);
      edges.set(n.key, new Set());
    }
  };
  const addEdge = (a: string, b: string) => {
    edges.get(a)?.add(b);
    edges.get(b)?.add(a);
  };

  // 1. Sample corridor cells at 1-unit resolution along each strip's center.
  //    Each strip is a thin 1xN or Nx1 rectangle. Walk the long axis.
  for (const c of corridors) {
    const horizontal = (c.x1 - c.x0) >= (c.y1 - c.y0);
    const cy = (c.y0 + c.y1) / 2;
    const cx = (c.x0 + c.x1) / 2;
    if (horizontal) {
      const start = Math.floor(c.x0);
      const end = Math.ceil(c.x1);
      let prevKey: string | null = null;
      for (let xi = start; xi <= end; xi++) {
        const key = `c-${xi.toFixed(2)},${cy.toFixed(2)}`;
        addNode({ x: xi, y: cy, key });
        if (prevKey) addEdge(prevKey, key);
        prevKey = key;
      }
    } else {
      const start = Math.floor(c.y0);
      const end = Math.ceil(c.y1);
      let prevKey: string | null = null;
      for (let yi = start; yi <= end; yi++) {
        const key = `c-${cx.toFixed(2)},${yi.toFixed(2)}`;
        addNode({ x: cx, y: yi, key });
        if (prevKey) addEdge(prevKey, key);
        prevKey = key;
      }
    }
  }

  // 2. Intersections are handled automatically: corridor cells that share a key
  //    (same x,y from different strips) dedup via addNode.

  // 3. Add room-center nodes and connect each to adjacent corridor cells on its perimeter.
  for (const r of rooms) {
    const cxR = roomCellX(r.col);
    const y0 = r.row * (ROOM_H + GAP);
    const y1 = y0 + ROOM_H;
    const roomKey = `r-${r.id}`;
    addNode({ x: (cxR.x0 + cxR.x1) / 2, y: (y0 + y1) / 2, key: roomKey, isRoom: r.id });

    for (const [, n] of nodes) {
      if (n.isRoom) continue;
      // East face at x=cxR.x1, corridor strip center at x1+GAP/2
      const onEast = Math.abs(n.x - (cxR.x1 + GAP / 2)) < 0.01 && n.y >= y0 && n.y <= y1 + GAP;
      // West face at x=cxR.x0, corridor strip center at x0-GAP/2
      const onWest = Math.abs(n.x - (cxR.x0 - GAP / 2)) < 0.01 && n.y >= y0 && n.y <= y1 + GAP;
      // South face at y=y1, corridor strip center at y1+GAP/2
      const onSouth = Math.abs(n.y - (y1 + GAP / 2)) < 0.01 && n.x >= cxR.x0 && n.x <= cxR.x1 + GAP;
      // No north — title wall.
      if (onEast || onWest || onSouth) {
        addEdge(roomKey, n.key);
      }
    }
  }
  return { nodes, edges };
}

export function findPath(rooms: Room[], fromId: string, toId: string): Waypoint[] {
  const from = rooms.find((r) => r.id === fromId);
  const to = rooms.find((r) => r.id === toId);
  if (!from || !to) return [];
  if (from.id === to.id) return [roomCenterPt(from)];

  const hash = roomsHash(rooms);
  if (!cachedGraph || cachedGraph.hash !== hash) {
    const g = buildGraph(rooms);
    cachedGraph = { hash, nodes: g.nodes, edges: g.edges };
  }
  const { nodes, edges } = cachedGraph;

  const startKey = `r-${from.id}`;
  const goalKey = `r-${to.id}`;
  if (!nodes.has(startKey) || !nodes.has(goalKey)) return [];

  // A* with Manhattan heuristic.
  const heur = (a: GraphNode, b: GraphNode) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const goalNode = nodes.get(goalKey)!;
  const open = new Set<string>([startKey]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[startKey, 0]]);
  const fScore = new Map<string, number>([[startKey, heur(nodes.get(startKey)!, goalNode)]]);

  while (open.size) {
    let currentKey: string | null = null;
    let bestF = Infinity;
    for (const k of open) {
      const f = fScore.get(k) ?? Infinity;
      if (f < bestF) { bestF = f; currentKey = k; }
    }
    if (!currentKey) break;
    if (currentKey === goalKey) break;
    open.delete(currentKey);
    const current = nodes.get(currentKey)!;
    const neighbors = edges.get(currentKey) ?? new Set();
    for (const n of neighbors) {
      const neighbor = nodes.get(n)!;
      const tentative = (gScore.get(currentKey) ?? Infinity) + heur(current, neighbor);
      if (tentative < (gScore.get(n) ?? Infinity)) {
        cameFrom.set(n, currentKey);
        gScore.set(n, tentative);
        fScore.set(n, tentative + heur(neighbor, goalNode));
        open.add(n);
      }
    }
  }
  if (!cameFrom.has(goalKey) && startKey !== goalKey) return [];

  const out: Waypoint[] = [];
  let k: string | undefined = goalKey;
  while (k) {
    const n = nodes.get(k);
    if (!n) break;
    out.unshift({ x: n.x, y: n.y });
    k = cameFrom.get(k);
  }
  return out;
}
