import { useFactoryStore } from "../state/factoryStore";

export const TW = 64;
export const TH = 32;
export const WALL_H = 60;
export const ROOM_W = 6;
export const ROOM_H = 6;
export const GAP = 1;

export function iso(x: number, y: number) {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) };
}

export function roomOrigin(col: number, row: number) {
  return { wx: col * (ROOM_W + GAP), wy: row * (ROOM_H + GAP) };
}

export function getRoomBounds(roomId: string) {
  const room = useFactoryStore.getState().rooms[roomId];
  const { wx, wy } = roomOrigin(room.col, room.row);
  return { x0: wx, y0: wy, x1: wx + ROOM_W, y1: wy + ROOM_H };
}

export function roomCenter(roomId: string) {
  const b = getRoomBounds(roomId);
  return iso((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
}

export function deskHotspot(roomId: string) {
  const b = getRoomBounds(roomId);
  const cx = (b.x0 + b.x1) / 2;
  const cy = b.y0 + (ROOM_H * 0.55);
  return { x: cx, y: cy };
}

export function floorPoly(x0: number, y0: number, x1: number, y1: number) {
  const a = iso(x0, y0), b = iso(x1, y0), c = iso(x1, y1), d = iso(x0, y1);
  return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`;
}

export function wallNorthPoly(x0: number, y0: number, x1: number, _y1: number, h: number) {
  const a = iso(x0, y0), b = iso(x1, y0);
  return `${a.x},${a.y} ${b.x},${b.y} ${b.x},${b.y - h} ${a.x},${a.y - h}`;
}

export function wallEastPoly(_x0: number, y0: number, x1: number, y1: number, h: number) {
  const b = iso(x1, y0), c = iso(x1, y1);
  return `${c.x},${c.y} ${b.x},${b.y} ${b.x},${b.y - h} ${c.x},${c.y - h}`;
}
