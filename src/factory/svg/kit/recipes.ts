import { RoomKit, RoomTag, StationLayout, WallFeature, RoomFeature } from "../../state/types";

export type RecipeDefaults = {
  wallFeature: WallFeature;
  stationLayout: StationLayout;
  defaultCapacity: number;
  features: RoomFeature[];
};

export const RECIPES: Record<RoomTag, RecipeDefaults> = {
  analyst:  { wallFeature: "trends",    stationLayout: "row",       defaultCapacity: 2, features: ["bookshelf", "binder-stack"] },
  creative: { wallFeature: "moodboard", stationLayout: "central",   defaultCapacity: 1, features: ["color-rack", "drafting"] },
  copy:     { wallFeature: "kanban",    stationLayout: "row",       defaultCapacity: 2, features: ["printer", "binder-stack"] },
  comms:    { wallFeature: "chatwall",  stationLayout: "perimeter", defaultCapacity: 4, features: ["phone-bank", "headset", "queue-board"] },
  finance:  { wallFeature: "ledger",    stationLayout: "central",   defaultCapacity: 1, features: ["safe", "file-cabinet", "token-meter"] },
  rd:       { wallFeature: "logwall",   stationLayout: "central",   defaultCapacity: 1, features: ["server-rack", "lab-bench"] },
  bridge:   { wallFeature: "warmap",    stationLayout: "cluster",   defaultCapacity: 1, features: ["conference-table", "kpi-panel"] },
  legal:    { wallFeature: "docs",      stationLayout: "row",       defaultCapacity: 2, features: ["law-shelf", "file-safe", "doc-stamp"] },
  ops:      { wallFeature: "datafeed",  stationLayout: "row",       defaultCapacity: 3, features: ["terminal-rack"] },
  archive:  { wallFeature: "archive",   stationLayout: "perimeter", defaultCapacity: 1, features: ["archive-wall", "binder-stack", "carousel"] },
  dev:      { wallFeature: "logwall",   stationLayout: "row",       defaultCapacity: 2, features: ["terminal-rack", "server-rack", "cable-tray"] },
  marketing:{ wallFeature: "moodboard", stationLayout: "row",       defaultCapacity: 2, features: ["color-rack", "carousel"] },
};

export function kitFromTag(tag: RoomTag, accent: string, capacityOverride?: number): RoomKit {
  const r = RECIPES[tag];
  return {
    primaryTag: tag,
    capacity: capacityOverride ?? r.defaultCapacity,
    accent,
    stationLayout: r.stationLayout,
    wallFeature: r.wallFeature,
    features: r.features.slice(),
  };
}

export const TAG_ACCENTS: Record<RoomTag, string> = {
  bridge:   "#f5a623",
  analyst:  "#5fd4f0",
  creative: "#ff6b9d",
  copy:     "#6bd968",
  comms:    "#6aa9ff",
  finance:  "#c4d943",
  rd:       "#b393f5",
  ops:      "#5ed0a8",
  legal:    "#cdd5df",
  archive:  "#a78566",
  dev:      "#5fd4f0",
  marketing: "#ff6f61",
};
