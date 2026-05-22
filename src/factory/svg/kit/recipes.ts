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
  // Specialist rooms — single station, capacity 1, smaller working area than a
  // boss room. They reuse moodboard/drafting for the wall + feature baseline
  // because the visual identity comes from the iso renderer's niche props,
  // not from the legacy composer fallback.
  anime_studio:   { wallFeature: "moodboard", stationLayout: "central", defaultCapacity: 1, features: ["drafting"] },
  hero_studio:    { wallFeature: "moodboard", stationLayout: "central", defaultCapacity: 1, features: ["drafting"] },
  mecha_bay:      { wallFeature: "logwall",   stationLayout: "central", defaultCapacity: 1, features: ["server-rack"] },
  chibi_corner:   { wallFeature: "moodboard", stationLayout: "central", defaultCapacity: 1, features: ["color-rack"] },
  deity_atelier:  { wallFeature: "archive",   stationLayout: "central", defaultCapacity: 1, features: ["drafting"] },
  creature_den:   { wallFeature: "moodboard", stationLayout: "central", defaultCapacity: 1, features: ["drafting"] },
  humanoid_forge: { wallFeature: "moodboard", stationLayout: "central", defaultCapacity: 1, features: ["drafting"] },
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
  // Specialist accents — one signature hue per archetype. Picked so each
  // room reads as visually different from its neighbors at a glance:
  //   anime  — hot magenta            hero   — comic-book primary blue
  //   mecha  — industrial orange      chibi  — soft pastel mauve
  //   deity  — burnished gold         creature — jade green
  //   humanoid — burnt leather brown
  anime_studio:   "#ff3d8b",
  hero_studio:    "#3057ff",
  mecha_bay:      "#ff8c2e",
  chibi_corner:   "#d8a8ff",
  deity_atelier:  "#d8a857",
  creature_den:   "#3e9d6f",
  humanoid_forge: "#a87049",
};
