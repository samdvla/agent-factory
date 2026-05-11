import { describe, it, expect } from "vitest";
import { computeCorridors } from "../layout";
import { computeDoors } from "../layout";
import { placeNewRoom } from "../layout";
import { findPath } from "../layout";
import { MAX_COLS, MAX_ROWS } from "../layout";
import type { Room, RoomKit, RoomTag } from "../../state/types";

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

// ---------- 10x10 grid cap tests ----------

const TAGS: RoomTag[] = [
  "bridge", "analyst", "creative", "copy", "comms",
  "finance", "rd", "ops", "legal", "archive", "dev",
];

function dummyRoom(id: string, col: number, row: number, tag: RoomTag = "analyst"): Room {
  return {
    id,
    name: id,
    col,
    row,
    kit: {
      primaryTag: tag,
      capacity: 1,
      accent: "#5fd4f0",
      stationLayout: "row",
      wallFeature: "trends",
      features: [],
    },
  };
}

describe("placeNewRoom respects 10x10 grid bounds", () => {
  it("never returns a column >= MAX_COLS or row >= MAX_ROWS even when forced to extend the grid", () => {
    // Saturate the full grid except one cell, then place again.
    const rooms: Room[] = [];
    for (let c = 0; c < MAX_COLS; c++) {
      for (let r = 0; r < MAX_ROWS; r++) {
        if (c === MAX_COLS - 1 && r === MAX_ROWS - 1) continue;
        rooms.push(dummyRoom(`r-${c}-${r}`, c, r));
      }
    }
    const pos = placeNewRoom(rooms, "analyst");
    expect(pos.col).toBeLessThan(MAX_COLS);
    expect(pos.row).toBeLessThan(MAX_ROWS);
    expect(pos.col).toBeGreaterThanOrEqual(0);
    expect(pos.row).toBeGreaterThanOrEqual(0);
    // With one open cell at (9, 9), the placer must land there.
    expect(pos).toEqual({ col: MAX_COLS - 1, row: MAX_ROWS - 1 });
  });

  it("falls back gracefully when no in-bounds candidate is adjacent to existing rooms", () => {
    // A single room jammed against the far corner — its only neighbours are
    // (9, 8) and (8, 9) and (10, 9)/(9, 10) which both exceed bounds.
    // Place a room with that tag and confirm the result is in-bounds.
    const rooms: Room[] = [dummyRoom("corner", MAX_COLS - 1, MAX_ROWS - 1)];
    const pos = placeNewRoom(rooms, "analyst");
    expect(pos.col).toBeGreaterThanOrEqual(0);
    expect(pos.row).toBeGreaterThanOrEqual(0);
    expect(pos.col).toBeLessThan(MAX_COLS);
    expect(pos.row).toBeLessThan(MAX_ROWS);
  });

  it("never returns negative coords for clusters of tags scattered across the grid", () => {
    // Fuzz with a few seed layouts that use different tags.
    const seeds: Room[][] = [
      [dummyRoom("a", 0, 0), dummyRoom("b", 5, 5, "creative")],
      [dummyRoom("a", 9, 9), dummyRoom("b", 0, 0, "dev")],
      [dummyRoom("a", 4, 0), dummyRoom("b", 4, 9, "ops"), dummyRoom("c", 0, 4, "comms")],
    ];
    for (const rooms of seeds) {
      for (const tag of TAGS) {
        const pos = placeNewRoom(rooms, tag);
        expect(pos.col).toBeGreaterThanOrEqual(0);
        expect(pos.row).toBeGreaterThanOrEqual(0);
        expect(pos.col).toBeLessThan(MAX_COLS);
        expect(pos.row).toBeLessThan(MAX_ROWS);
      }
    }
  });

  it("is deterministic — same input yields same output", () => {
    const rooms: Room[] = [
      dummyRoom("strategy", 0, 0, "bridge"),
      dummyRoom("research", 1, 0, "analyst"),
      dummyRoom("design", 2, 0, "creative"),
      dummyRoom("listing", 0, 1, "copy"),
    ];
    const a = placeNewRoom(rooms, "analyst");
    const b = placeNewRoom(rooms, "analyst");
    expect(a).toEqual(b);
  });
});

describe("computeCorridors handles a 10x10 grid", () => {
  it("returns sane strips with finite coordinates for a sparse 10x10 setup", () => {
    // Place rooms at every other cell of the 10x10 grid.
    const rooms: Room[] = [];
    for (let c = 0; c < MAX_COLS; c++) {
      for (let r = 0; r < MAX_ROWS; r++) {
        if ((c + r) % 2 === 0) rooms.push(dummyRoom(`r-${c}-${r}`, c, r));
      }
    }
    const strips = computeCorridors(rooms);
    expect(strips.length).toBeGreaterThan(0);
    for (const s of strips) {
      expect(Number.isFinite(s.x0)).toBe(true);
      expect(Number.isFinite(s.x1)).toBe(true);
      expect(Number.isFinite(s.y0)).toBe(true);
      expect(Number.isFinite(s.y1)).toBe(true);
      expect(s.x1).toBeGreaterThan(s.x0);
      expect(s.y1).toBeGreaterThan(s.y0);
    }
  });

  it("returns the expected number of vertical strips for a full 10x10 grid", () => {
    const rooms: Room[] = [];
    for (let c = 0; c < MAX_COLS; c++) {
      for (let r = 0; r < MAX_ROWS; r++) {
        rooms.push(dummyRoom(`r-${c}-${r}`, c, r));
      }
    }
    const strips = computeCorridors(rooms);
    // Vertical strips: one between every pair of adjacent occupied columns.
    // With 10 columns, that's 9 vertical strips.
    const verticals = strips.filter((s) => s.x1 - s.x0 < s.y1 - s.y0);
    expect(verticals.length).toBe(MAX_COLS - 1);
    // Horizontal strips: one between every pair of adjacent occupied rows.
    const horizontals = strips.filter((s) => s.x1 - s.x0 >= s.y1 - s.y0);
    expect(horizontals.length).toBe(MAX_ROWS - 1);
  });
});
