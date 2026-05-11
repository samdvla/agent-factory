// Viewport culling helpers.
//
// The factory floor can grow to 100 rooms. Rendering every room (furniture,
// avatars, FX) at all times is prohibitive. This module exposes a deterministic
// detail-level decision per room based on the current viewBox so the renderer
// can drop off-screen geometry entirely or downgrade it to a wall-only shell.

import { Room } from "../state/types";
import { GAP, ROOM_W, ROOM_H, WALL_H, iso } from "./geometry";

export type DetailLevel = "full" | "shell" | "hidden";

export type ViewportRect = {
  /** World-coord rectangle currently inside the SVG viewBox. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * Project a room's iso bounding box onto screen-space (SVG user units). The
 * returned rect is intentionally generous: we union all four iso-projected
 * corners and pad upward by WALL_H so the room's tall north wall counts
 * toward visibility.
 */
export function roomScreenBBox(room: { col: number; row: number }): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const x0 = room.col * (ROOM_W + GAP);
  const y0 = room.row * (ROOM_H + GAP);
  const x1 = x0 + ROOM_W;
  const y1 = y0 + ROOM_H;
  const pts = [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y - WALL_H < minY) minY = p.y - WALL_H;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Decide how much detail to render for a room given the current viewport.
 * - "full": room overlaps the viewport (or sits within `fullMargin`).
 * - "shell": room is outside the viewport but within `shellMargin` — render
 *   walls + title only, drop furniture / props.
 * - "hidden": room is far enough off-screen that no part of it can leak in
 *   from a pan/zoom transition; skip rendering entirely.
 *
 * Margins are in world (SVG user) units to match `viewport` and `roomScreenBBox`.
 */
export function detailLevelForRoom(
  room: { col: number; row: number },
  viewport: ViewportRect,
  fullMargin = 0,
  shellMargin = 220,
): DetailLevel {
  const bb = roomScreenBBox(room);
  const insideFull =
    bb.maxX >= viewport.minX - fullMargin &&
    bb.minX <= viewport.maxX + fullMargin &&
    bb.maxY >= viewport.minY - fullMargin &&
    bb.minY <= viewport.maxY + fullMargin;
  if (insideFull) return "full";

  const insideShell =
    bb.maxX >= viewport.minX - shellMargin &&
    bb.minX <= viewport.maxX + shellMargin &&
    bb.maxY >= viewport.minY - shellMargin &&
    bb.minY <= viewport.maxY + shellMargin;
  if (insideShell) return "shell";

  return "hidden";
}

/**
 * Compute a single detail-level map for many rooms at once. Slightly cheaper
 * than calling `detailLevelForRoom` per-room when callers already have the
 * full list and want to memoize the result.
 */
export function detailLevelsFor(
  rooms: Room[],
  viewport: ViewportRect,
  fullMargin = 0,
  shellMargin = 220,
): Map<string, DetailLevel> {
  const out = new Map<string, DetailLevel>();
  for (const r of rooms) {
    out.set(r.id, detailLevelForRoom(r, viewport, fullMargin, shellMargin));
  }
  return out;
}
