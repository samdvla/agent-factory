import { describe, it, expect } from "vitest";
import type {
  RoomTag, WallFeature, RoomKit, HireEvent, AgentVisualState,
} from "../types";

describe("new types", () => {
  it("RoomTag includes the 12 spec tags", () => {
    const tags: RoomTag[] = [
      "bridge", "analyst", "creative", "copy", "comms",
      "finance", "rd", "ops", "legal", "archive", "dev",
      "marketing",
    ];
    expect(tags).toHaveLength(12);
  });

  it("WallFeature includes the 10 spec features", () => {
    const features: WallFeature[] = [
      "kanban", "trends", "moodboard", "ledger", "logwall",
      "chatwall", "warmap", "datafeed", "archive", "docs",
    ];
    expect(features).toHaveLength(10);
  });

  it("RoomKit shape compiles", () => {
    const kit: RoomKit = {
      primaryTag: "analyst",
      capacity: 2,
      accent: "#5fd4f0",
      stationLayout: "row",
      wallFeature: "trends",
      features: ["bookshelf", "binder-stack"],
    };
    expect(kit.capacity).toBe(2);
  });

  it("HireEvent shape compiles", () => {
    const e: HireEvent = {
      id: "h1",
      ts: 0,
      roleSpec: {
        name: "Trend Hunter",
        title: "Specialist",
        primaryTag: "analyst",
        archetype: "slim",
        model: "Haiku",
      },
      justification: { reason: "niche_demand", metric: "niche queue=6" },
    };
    expect(e.justification.reason).toBe("niche_demand");
  });

  it("AgentVisualState includes the new lifecycle states", () => {
    const states: AgentVisualState[] = ["materializing", "dissolving"];
    expect(states).toHaveLength(2);
  });
});
