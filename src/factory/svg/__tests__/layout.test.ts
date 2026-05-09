import { describe, it, expect } from "vitest";
import { computeCorridors } from "../layout";
import { computeDoors } from "../layout";
import { placeNewRoom } from "../layout";
import { findPath } from "../layout";
import type { Room, RoomKit } from "../../state/types";

const FOUNDING_ROOMS: Room[] = [
  { id: "strategy", name: "Strategy", col: 0, row: 0 },
  { id: "research", name: "Research", col: 1, row: 0 },
  { id: "design",   name: "Design",   col: 2, row: 0 },
  { id: "listing",  name: "Listing",  col: 0, row: 1 },
  { id: "cs",       name: "CS",       col: 1, row: 1 },
  { id: "finance",  name: "Finance",  col: 2, row: 1 },
  { id: "silab",    name: "SI Lab",   col: 1, row: 2 },
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
    const corridors = computeCorridors(FOUNDING_ROOMS);
    const doors = computeDoors(FOUNDING_ROOMS, corridors);
    for (const [, faces] of doors) {
      expect(faces.north).toBe(false);
    }
  });

  it("col 0 rooms have an east door (corridor at gap 6..7)", () => {
    const corridors = computeCorridors(FOUNDING_ROOMS);
    const doors = computeDoors(FOUNDING_ROOMS, corridors);
    expect(doors.get("strategy")?.east).toBe(true);
    expect(doors.get("listing")?.east).toBe(true);
  });

  it("col 2 rooms have a west door (corridor at gap 13..14)", () => {
    const corridors = computeCorridors(FOUNDING_ROOMS);
    const doors = computeDoors(FOUNDING_ROOMS, corridors);
    expect(doors.get("design")?.west).toBe(true);
    expect(doors.get("finance")?.west).toBe(true);
  });

  it("row 0 rooms have a south door (corridor at gap 6..7)", () => {
    const corridors = computeCorridors(FOUNDING_ROOMS);
    const doors = computeDoors(FOUNDING_ROOMS, corridors);
    expect(doors.get("research")?.south).toBe(true);
  });
});

const KIT_CREATIVE: RoomKit = {
  primaryTag: "creative", capacity: 1, accent: "#ff6b9d",
  stationLayout: "central", wallFeature: "moodboard", features: [],
};
const KIT_ANALYST: RoomKit = {
  primaryTag: "analyst", capacity: 2, accent: "#5fd4f0",
  stationLayout: "row", wallFeature: "trends", features: [],
};

function withKit(rooms: Room[], idsToTags: Record<string, RoomKit>): Room[] {
  return rooms.map((r) => idsToTags[r.id] ? { ...r, kit: idsToTags[r.id] } : r);
}

describe("placeNewRoom", () => {
  it("returns a cell adjacent to existing rooms when none of the tag exist", () => {
    const tagged = withKit(FOUNDING_ROOMS, { design: KIT_CREATIVE });
    const pos = placeNewRoom(tagged, "creative");
    expect([
      `${3},${0}`, `${2},${1}`, `${3},${1}`,
    ]).toContain(`${pos.col},${pos.row}`);
  });

  it("clusters same-tag rooms — second creative goes adjacent to first", () => {
    const tagged = withKit(FOUNDING_ROOMS, {
      design: KIT_CREATIVE,
      research: KIT_ANALYST,
    });
    const pos = placeNewRoom(tagged, "creative");
    const dx = Math.abs(pos.col - 2);
    const dy = Math.abs(pos.row - 0);
    expect(dx + dy).toBeLessThanOrEqual(2);
  });

  it("never returns a position that an existing room occupies", () => {
    const pos = placeNewRoom(FOUNDING_ROOMS, "analyst");
    expect(FOUNDING_ROOMS.some((r) => r.col === pos.col && r.row === pos.row)).toBe(false);
  });
});

describe("findPath", () => {
  it("returns a path between two adjacent rooms", () => {
    const path = findPath(FOUNDING_ROOMS, "strategy", "research");
    expect(path.length).toBeGreaterThanOrEqual(2);
  });

  it("returns a path that crosses the central corridor for diagonally placed rooms", () => {
    const path = findPath(FOUNDING_ROOMS, "strategy", "finance");
    expect(path.length).toBeGreaterThan(2);
    expect(path.some((p) => p.y >= 6 && p.y <= 7)).toBe(true);
  });

  it("returns empty when source or dest is unknown", () => {
    expect(findPath(FOUNDING_ROOMS, "strategy", "nonexistent")).toEqual([]);
    expect(findPath(FOUNDING_ROOMS, "nonexistent", "strategy")).toEqual([]);
  });
});

import { computeFacilityLayout, roomsHash } from "../layout";

describe("computeFacilityLayout", () => {
  it("returns corridors + doors + an unchanged hash for identical rooms", () => {
    const a = computeFacilityLayout(FOUNDING_ROOMS);
    const b = computeFacilityLayout(FOUNDING_ROOMS);
    expect(a.hash).toBe(b.hash);
    expect(a.corridors.length).toBe(b.corridors.length);
    expect(a.doors.size).toBe(b.doors.size);
  });

  it("hash changes when a room moves", () => {
    const moved = FOUNDING_ROOMS.map((r) => r.id === "silab" ? { ...r, col: 2 } : r);
    const a = roomsHash(FOUNDING_ROOMS);
    const b = roomsHash(moved);
    expect(a).not.toBe(b);
  });
});
