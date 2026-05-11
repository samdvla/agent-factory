import { describe, it, expect } from "vitest";
import {
  detailLevelForRoom, detailLevelsFor, roomScreenBBox,
} from "../viewport";

// Construct a viewport that snugly contains the room at (0, 0).
function viewportAroundOrigin() {
  const bb = roomScreenBBox({ col: 0, row: 0 });
  return { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY };
}

describe("detailLevelForRoom", () => {
  it("returns 'full' for an in-viewport room", () => {
    const viewport = viewportAroundOrigin();
    const tier = detailLevelForRoom({ col: 0, row: 0 }, viewport);
    expect(tier).toBe("full");
  });

  it("returns 'full' for any room whose iso bbox overlaps the viewport", () => {
    // Because iso projection shears the grid, adjacent grid cells visually
    // overlap quite a bit. Room (1, 0) still has its left edge inside the
    // origin viewport's right edge.
    const viewport = viewportAroundOrigin();
    expect(detailLevelForRoom({ col: 1, row: 0 }, viewport)).toBe("full");
    expect(detailLevelForRoom({ col: 0, row: 1 }, viewport)).toBe("full");
  });

  it("returns 'shell' for a room just outside the viewport but within the margin", () => {
    // Room at (3, 0) is far enough out from the snug origin viewport that it
    // no longer overlaps, but its left edge sits within the default
    // 220-unit shell margin.
    const viewport = viewportAroundOrigin();
    const tier = detailLevelForRoom({ col: 2, row: 0 }, viewport);
    expect(tier).toBe("shell");
  });

  it("returns 'hidden' for a far-off room", () => {
    const viewport = viewportAroundOrigin();
    // Room at (9, 9): far corner of the 10x10 grid — well beyond any
    // reasonable margin from the origin viewport.
    const tier = detailLevelForRoom({ col: 9, row: 9 }, viewport);
    expect(tier).toBe("hidden");
  });

  it("respects the shell margin parameter", () => {
    const viewport = viewportAroundOrigin();
    // With a generous 10000-unit shell margin, even far rooms upgrade.
    const tier = detailLevelForRoom({ col: 9, row: 9 }, viewport, 0, 10000);
    expect(tier).toBe("shell");
  });

  it("upgrades any room to 'full' with a sufficiently large full margin", () => {
    const viewport = viewportAroundOrigin();
    const tier = detailLevelForRoom({ col: 9, row: 9 }, viewport, 10000, 10000);
    expect(tier).toBe("full");
  });
});

describe("detailLevelsFor", () => {
  it("returns a map with one entry per input room and uses each tier", () => {
    const viewport = viewportAroundOrigin();
    const rooms = [
      { id: "a", name: "a", col: 0, row: 0 },
      { id: "b", name: "b", col: 2, row: 0 },
      { id: "c", name: "c", col: 9, row: 9 },
    ];
    const map = detailLevelsFor(rooms, viewport);
    expect(map.size).toBe(3);
    expect(map.get("a")).toBe("full");
    expect(map.get("b")).toBe("shell");
    expect(map.get("c")).toBe("hidden");
  });
});
