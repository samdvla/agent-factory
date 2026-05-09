import { describe, it, expect } from "vitest";
import { computeCorridors } from "../layout";
import { computeDoors } from "../layout";
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

  it("vertical corridor y1 equals 20 for founding 7-room layout", () => {
    const strips = computeCorridors(FOUNDING_ROOMS);
    const verticals = strips.filter((s) => s.x1 - s.x0 < s.y1 - s.y0);
    for (const v of verticals) expect(v.y1).toBeCloseTo(20, 5);
  });

  it("horizontal corridor at y=13..14 spans only col 1 (cs↔silab adjacent)", () => {
    const strips = computeCorridors(FOUNDING_ROOMS);
    const row12 = strips.find((s) => Math.abs(s.y0 - 13) < 0.01);
    expect(row12).toBeDefined();
    expect(row12!.x0).toBeCloseTo(7, 5);   // col 1 left edge
    expect(row12!.x1).toBeCloseTo(13, 5);  // col 1 right edge
  });

  it("horizontal corridor at y=6..7 spans full width 0..20 for row 0↔1", () => {
    const strips = computeCorridors(FOUNDING_ROOMS);
    const row01 = strips.find((s) => Math.abs(s.y0 - 6) < 0.01);
    expect(row01).toBeDefined();
    expect(row01!.x0).toBeCloseTo(0, 5);
    expect(row01!.x1).toBeCloseTo(20, 5);
  });
});

describe("computeDoors", () => {
  it("never puts a door on the north face", () => {
    const doors = computeDoors(FOUNDING_ROOMS);
    for (const [, faces] of doors) {
      expect(faces.north).toBe(false);
    }
  });

  it("col 0 rooms have an east door (corridor at gap 6..7)", () => {
    const doors = computeDoors(FOUNDING_ROOMS);
    expect(doors.get("strategy")?.east).toBe(true);
    expect(doors.get("listing")?.east).toBe(true);
  });

  it("col 2 rooms have a west door (corridor at gap 13..14)", () => {
    const doors = computeDoors(FOUNDING_ROOMS);
    expect(doors.get("design")?.west).toBe(true);
    expect(doors.get("finance")?.west).toBe(true);
  });

  it("row 0 rooms have a south door (corridor at gap 6..7)", () => {
    const doors = computeDoors(FOUNDING_ROOMS);
    expect(doors.get("research")?.south).toBe(true);
  });
});
