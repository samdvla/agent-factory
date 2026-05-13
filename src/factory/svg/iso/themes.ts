/**
 * Iso room theme palettes — ported verbatim from the handoff's
 * `room.jsx` THEMES. Each theme controls platform/floor/wall colors
 * and the ambient floor wash. Per-room accents (cyan for ops,
 * orange for bridge, etc.) are layered on top of these and stay
 * theme-independent.
 */
export type IsoThemeName = "warm" | "clinic" | "night";

export interface IsoTheme {
  name: IsoThemeName;
  /** Page background behind the room cluster. */
  sky: string;
  /** Cream/parchment/black slab the room sits on. */
  platform: string;
  /** Floor diamond color. */
  floor: string;
  /** Faint hatched lines across the floor. */
  floorTile: string;
  /** "wood" hatch pattern vs "tile" pattern. */
  floorPattern: "wood" | "tile";
  /** Back-left wall (y=0). */
  wallBack: string;
  /** Back-right wall (x=0). */
  wallSide: string;
  /** Mullion/trim color across the top of the solid wall section. */
  wallTrim: string;
  /** Parapet box at the top frame. */
  parapet: string;
  /** Translucent glass fill (rgba string). */
  glassFill: string;
  /** Inside-base skirting. */
  skirting: string;
  /** Soft warm ellipse on the floor (rgba). */
  ambient: string;
  /** True for dark themes (used to tweak signage opacity etc.). */
  isDark: boolean;
}

export const ISO_THEMES: Record<IsoThemeName, IsoTheme> = {
  warm: {
    name: "warm",
    sky: "#efe3c8",
    platform: "#faf3e5",
    floor: "#e7d5b4",
    floorTile: "rgba(80,50,20,0.10)",
    floorPattern: "wood",
    wallBack: "#f4ead2",
    wallSide: "#ecdfc1",
    wallTrim: "#c8b88f",
    parapet: "#cbb88a",
    glassFill: "rgba(255,247,225,0.32)",
    skirting: "#a48863",
    ambient: "rgba(255,240,200,0.35)",
    isDark: false,
  },
  clinic: {
    name: "clinic",
    sky: "#dff0f4",
    platform: "#ffffff",
    floor: "#f4f7f9",
    floorTile: "rgba(0,40,80,0.05)",
    floorPattern: "tile",
    wallBack: "#ffffff",
    wallSide: "#f6f8fa",
    wallTrim: "#dce3e9",
    parapet: "#cdd6de",
    glassFill: "rgba(220,235,248,0.42)",
    skirting: "#aab6c1",
    ambient: "rgba(180,220,235,0.4)",
    isDark: false,
  },
  night: {
    name: "night",
    sky: "#0e1118",
    platform: "#2a2e38",
    floor: "#1c1f26",
    floorTile: "rgba(255,255,255,0.05)",
    floorPattern: "tile",
    wallBack: "#252932",
    wallSide: "#1d2129",
    wallTrim: "#3a4258",
    parapet: "#3a4258",
    glassFill: "rgba(80,130,200,0.22)",
    skirting: "#0d0f15",
    ambient: "rgba(40,80,130,0.35)",
    isDark: true,
  },
};

export function getIsoTheme(name: IsoThemeName | undefined): IsoTheme {
  return ISO_THEMES[name ?? "warm"];
}

export const ISO_THEME_NAMES: IsoThemeName[] = ["warm", "clinic", "night"];

/**
 * Map an app-wide theme id (claude/espresso/pine/plum/midnight/linen) to an
 * iso room theme.
 *
 * - Brown-family app themes (claude, espresso) and the light linen palette
 *   all pair with the cream `warm` iso rooms.
 * - The cool / forest dark themes (pine, plum, midnight) pair with the dark
 *   `night` iso rooms.
 *
 * The `clinic` (bright white) iso theme is available as a manual override
 * in Settings but isn't auto-selected by any app theme.
 */
export function mapAppThemeToIso(appTheme: string | null | undefined): IsoThemeName {
  if (appTheme === "pine" || appTheme === "plum" || appTheme === "midnight") {
    return "night";
  }
  // claude, espresso, linen, and any unknown id default to warm cream.
  return "warm";
}
