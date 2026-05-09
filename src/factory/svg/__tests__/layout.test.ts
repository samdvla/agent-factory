import { describe, it, expect } from "vitest";
import { computeCorridors } from "../layout";
import type { Room } from "../../state/types";

const FOUNDING_ROOMS: Room[] = [
  { id: "strategy", name: "Strategy",  occupant: "", col: 0, row: 0, kind: "bridge"   },
  { id: "research", name: "Research",  occupant: "", col: 1, row: 0, kind: "analyst"  },
  { id: "design",   name: "Design",    occupant: "", col: 2, row: 0, kind: "fab"      },
  { id: "listing",  name: "Listing",   occupant: "", col: 0, row: 1, kind: "dispatch" },
  { id: "cs",       name: "CS",        occupant: "", col: 1, row: 1, kind: "comms"    },
  { id: "finance",  name: "Finance",   occupant: "", col: 2, row: 1, kind: "control"  },
  { id: "silab",    name: "SI Lab",    occupant: "", col: 1, row: 2, kind: "rd"       },
];

describe("computeCorridors", () => {
  it("returns at least one horizontal and one vertical strip", () => {
    const strips = computeCorridors(FOUNDING_ROOMS);
    expect(strips.some((s) => s.x1 - s.x0 > s.y1 - s.y0)).toBe(true);
    expect(strips.some((s) => s.x1 - s.x0 < s.y1 - s.y0)).toBe(true);
  });

  it("includes a vertical corridor at col gap 6..7 (x0=6, x1=7)", () => {
    const strips = computeCorridors(FOUNDING_ROOMS);
    expect(strips.some((s) => Math.abs(s.x0 - 6) < 0.01 && Math.abs(s.x1 - 7) < 0.01)).toBe(true);
  });

  it("includes a vertical corridor at col gap 13..14 (x0=13, x1=14)", () => {
    const strips = computeCorridors(FOUNDING_ROOMS);
    expect(strips.some((s) => Math.abs(s.x0 - 13) < 0.01 && Math.abs(s.x1 - 14) < 0.01)).toBe(true);
  });

  it("includes a horizontal corridor at row gap 6..7 (y0=6, y1=7)", () => {
    const strips = computeCorridors(FOUNDING_ROOMS);
    expect(strips.some((s) => Math.abs(s.y0 - 6) < 0.01 && Math.abs(s.y1 - 7) < 0.01)).toBe(true);
  });

  it("returns no strips when given a single room", () => {
    const single: Room[] = [FOUNDING_ROOMS[0]];
    expect(computeCorridors(single)).toEqual([]);
  });
});
