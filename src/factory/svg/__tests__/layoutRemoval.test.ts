import { describe, it, expect } from "vitest";
import { computeFacilityLayout, computeCorridors } from "../layout";
import type { Room } from "../../state/types";

const FOUNDING_ROOMS: Room[] = [
  { id: "strategy", name: "Strategy",  col: 0, row: 0 },
  { id: "research", name: "Research",  col: 1, row: 0 },
  { id: "design",   name: "Design",    col: 2, row: 0 },
  { id: "listing",  name: "Listing",   col: 0, row: 1 },
  { id: "cs",       name: "CS",        col: 1, row: 1 },
  { id: "finance",  name: "Finance",   col: 2, row: 1 },
  { id: "silab",    name: "SI Lab",    col: 1, row: 2 },
];

describe("layout regen on room removal", () => {
  it("hash changes when a room is removed", () => {
    const before = computeFacilityLayout(FOUNDING_ROOMS).hash;
    const after = computeFacilityLayout(FOUNDING_ROOMS.filter(r => r.id !== "silab")).hash;
    expect(before).not.toBe(after);
  });

  it("corridors shrink when the row 2 silab is removed", () => {
    const withSilab = computeCorridors(FOUNDING_ROOMS);
    const withoutSilab = computeCorridors(FOUNDING_ROOMS.filter(r => r.id !== "silab"));
    // Without silab, no row gap between row 1 and row 2 should exist.
    const hasRow12After = withoutSilab.some(s => Math.abs(s.y0 - 13) < 0.01);
    const hasRow12Before = withSilab.some(s => Math.abs(s.y0 - 13) < 0.01);
    expect(hasRow12Before).toBe(true);
    expect(hasRow12After).toBe(false);
  });

  it("doors update when a neighbor is removed", () => {
    const withFinance = computeFacilityLayout(FOUNDING_ROOMS);
    const withoutFinance = computeFacilityLayout(
      FOUNDING_ROOMS.filter(r => r.id !== "finance"),
    );
    // With finance present, design (col 2) has a south door (corridor to row 1).
    const designBefore = withFinance.doors.get("design")!;
    expect(designBefore.south).toBe(true);
    // Without finance, the corridor between row 0 and row 1 at col 2 should not exist
    // (no rooms on either side of that gap at col 2). Design's south door should be false.
    const designAfter = withoutFinance.doors.get("design")!;
    expect(designAfter.south).toBe(false);
  });
});
