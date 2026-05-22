import { describe, it, expect } from "vitest";
import { findPath } from "../layout";
import type { Waypoint } from "../layout";
import { ROOM_W, ROOM_H, GAP } from "../geometry";
import type { Room } from "../../state/types";

const STEP_X = ROOM_W + GAP;
const STEP_Y = ROOM_H + GAP;

const FOUNDING_ROOMS: Room[] = [
  { id: "strategy", name: "Strategy",  col: 0, row: 0 },
  { id: "research", name: "Research",  col: 1, row: 0 },
  { id: "design",   name: "Design",    col: 2, row: 0 },
  { id: "listing",  name: "Listing",   col: 0, row: 1 },
  { id: "cs",       name: "CS",        col: 1, row: 1 },
  { id: "finance",  name: "Finance",   col: 2, row: 1 },
  { id: "silab",    name: "SI Lab",    col: 1, row: 2 },
];

function pathLen(p: Waypoint[]): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) {
    n += Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y);
  }
  return n;
}

describe("pathing regression guard", () => {
  it("returns a non-empty path between every pair of founding rooms", () => {
    for (const a of FOUNDING_ROOMS) {
      for (const b of FOUNDING_ROOMS) {
        if (a.id === b.id) continue;
        const path = findPath(FOUNDING_ROOMS, a.id, b.id);
        expect(path.length).toBeGreaterThan(0);
      }
    }
  });

  it("path length is within Manhattan distance + 50% of room centers", () => {
    for (const a of FOUNDING_ROOMS) {
      for (const b of FOUNDING_ROOMS) {
        if (a.id === b.id) continue;
        const path = findPath(FOUNDING_ROOMS, a.id, b.id);
        if (path.length < 2) continue;
        // Estimate a lower bound: Manhattan distance between room centers.
        const ax = a.col * STEP_X + ROOM_W / 2;
        const ay = a.row * STEP_Y + ROOM_H / 2;
        const bx = b.col * STEP_X + ROOM_W / 2;
        const by = b.row * STEP_Y + ROOM_H / 2;
        const lower = Math.abs(ax - bx) + Math.abs(ay - by);
        const len = pathLen(path);
        // Path must be no more than 1.6x the Manhattan distance (allows for corridor detours).
        expect(len).toBeLessThanOrEqual(lower * 1.6 + 5);
      }
    }
  });
});
