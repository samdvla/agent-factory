import { Room } from "../state/types";

export const ROOM_W = 6;
export const ROOM_H = 6;
export const GAP = 1;

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
    const gapX0 = (c + 1) * (ROOM_W + GAP) - GAP;       // = c*7 + 6
    const gapX1 = gapX0 + GAP;                          // = c*7 + 7
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

export function computeDoors(rooms: Room[]): Map<string, DoorSet> {
  const out = new Map<string, DoorSet>();
  for (const r of rooms) {
    out.set(r.id, {
      north: false,
      east:  rooms.some((o) => o.col > r.col),
      west:  rooms.some((o) => o.col < r.col),
      south: rooms.some((o) => o.row > r.row),
    });
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
      if (c < 0 || rr < 0) continue;
      const key = `${c},${rr}`;
      if (occupied.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ col: c, row: rr });
    }
  }

  if (!candidates.length) return { col: 0, row: rooms.length };

  const W_TAG = 4.0, W_GLOBAL = 1.0, W_ADJ = 0.5, W_ISOLATE = 100.0;

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    let score = 0;
    if (tagCent) score += -W_TAG * dist(c, tagCent);
    score += -W_GLOBAL * dist(c, globalCent);
    score += W_ADJ * adjacentToCount(c, rooms);
    if (isolatesAnyRoom(c, rooms)) score -= W_ISOLATE;
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
