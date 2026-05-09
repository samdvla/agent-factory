import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RECIPES, kitFromTag } from "../recipes";
import { composeRoom, layoutStations } from "../composer";
import type { RoomTag, RoomKit } from "../../../state/types";

const ALL_TAGS: RoomTag[] = [
  "bridge", "analyst", "creative", "copy", "comms",
  "finance", "rd", "ops", "legal", "archive", "dev",
];

describe("RECIPES", () => {
  it("covers all 11 tags", () => {
    for (const t of ALL_TAGS) expect(RECIPES[t]).toBeDefined();
  });
  it("kitFromTag fills required fields", () => {
    for (const t of ALL_TAGS) {
      const k = kitFromTag(t, "#5fd4f0");
      expect(k.primaryTag).toBe(t);
      expect(k.capacity).toBeGreaterThan(0);
      expect(k.wallFeature).toBeDefined();
      expect(k.stationLayout).toBeDefined();
    }
  });
});

describe("composer", () => {
  it.each(ALL_TAGS)("composes %s without throwing", (tag) => {
    const kit = kitFromTag(tag, "#5fd4f0");
    const html = renderToStaticMarkup(<svg>{composeRoom(kit, 0, 0)}</svg>);
    expect(html).toContain("<svg");
  });

  it("layoutStations returns capacity-many stations", () => {
    const k: RoomKit = {
      primaryTag: "comms", capacity: 4, accent: "#6aa9ff",
      stationLayout: "perimeter", wallFeature: "chatwall", features: [],
    };
    expect(layoutStations(k)).toHaveLength(4);
  });

  it("row layout spreads stations along y=3.2", () => {
    const k: RoomKit = {
      primaryTag: "analyst", capacity: 3, accent: "#5fd4f0",
      stationLayout: "row", wallFeature: "trends", features: [],
    };
    const stations = layoutStations(k);
    expect(stations).toHaveLength(3);
    expect(stations.every((s) => Math.abs(s.y - 3.2) < 0.01)).toBe(true);
  });

  it("perimeter layout places along S/E walls (y near 4.6 OR x near 4.7)", () => {
    const k: RoomKit = {
      primaryTag: "comms", capacity: 4, accent: "#6aa9ff",
      stationLayout: "perimeter", wallFeature: "chatwall", features: [],
    };
    const stations = layoutStations(k);
    expect(stations.every((s) => s.y > 4.0 || s.x > 4.0)).toBe(true);
  });
});
