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
  const yBot = (rowMax + 1) * (ROOM_H + GAP) - GAP + GAP;

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
    const hasTop = rooms.some((rr) => rr.row === r);
    const hasBot = rooms.some((rr) => rr.row === r + 1);
    if (!hasTop && !hasBot) continue;
    const minCellX = Math.min(...rooms.map((rr) => roomCellX(rr.col).x0));
    const maxCellX = Math.max(...rooms.map((rr) => roomCellX(rr.col).x1));
    strips.push({ x0: minCellX, x1: maxCellX + GAP, y0: gapY0, y1: gapY1 });
  }

  return strips;
}
