import { Color } from "three";

/**
 * Theme palette for the 3D scene — read straight from the live CSS custom
 * properties on `:root` so the floor automatically re-tints when the user
 * switches themes (claude / espresso / pine / plum / midnight / linen).
 *
 * Read once on mount + on the `theme-changed` event (or via a MutationObserver
 * on data-theme) — see useThemeColors below.
 */
export type ThemeColors = {
  floor: Color;
  floorAlt: Color;
  wallN: Color;
  wallE: Color;
  wallEdge: Color;
  grid: Color;
  corridor: Color;
  bg0: Color;
  bg1: Color;
  bg2: Color;
  ink0: Color;
  ink2: Color;
  ink3: Color;
  accent: Color;
  accentWarm: Color;
  accentOk: Color;
  accentBad: Color;
  skin: Color;
  uniform: Color;
  uniformDark: Color;
  roleColors: Record<string, Color>;
};

function readCssColor(name: string, fallback: string): Color {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  // Three.Color handles both #rrggbb and rgb()/hsl() forms.
  try {
    return new Color(raw || fallback);
  } catch {
    return new Color(fallback);
  }
}

export function readThemePalette(): ThemeColors {
  return {
    floor:       readCssColor("--floor", "#2d241b"),
    floorAlt:    readCssColor("--bg-2", "#25201b"),
    wallN:       readCssColor("--wall-n", "#251d15"),
    wallE:       readCssColor("--wall-e", "#1a140e"),
    wallEdge:    readCssColor("--wall-edge", "#443728"),
    grid:        readCssColor("--grid", "#34291f"),
    corridor:    readCssColor("--corridor", "#1f1812"),
    bg0:         readCssColor("--bg-0", "#14110d"),
    bg1:         readCssColor("--bg-1", "#1c1814"),
    bg2:         readCssColor("--bg-2", "#25201b"),
    ink0:        readCssColor("--ink-0", "#f4ecd8"),
    ink2:        readCssColor("--ink-2", "#8a7e6a"),
    ink3:        readCssColor("--ink-3", "#5a5147"),
    accent:      readCssColor("--accent", "#d97757"),
    accentWarm:  readCssColor("--accent-warm", "#e8a857"),
    accentOk:    readCssColor("--accent-ok", "#8aa86b"),
    accentBad:   readCssColor("--accent-bad", "#c66363"),
    skin:        readCssColor("--skin", "#d8b894"),
    uniform:     readCssColor("--uniform", "#3a342d"),
    uniformDark: readCssColor("--uniform-dark", "#2a2520"),
    roleColors: {
      orchestrator: readCssColor("--role-orchestrator", "#e8a857"),
      research:     readCssColor("--role-research", "#c5a572"),
      designer:     readCssColor("--role-designer", "#d97a8a"),
      listing:      readCssColor("--role-listing", "#8aa86b"),
      publisher:    readCssColor("--role-listing", "#8aa86b"),
      cs:           readCssColor("--role-cs", "#9bb0c5"),
      cfo:          readCssColor("--role-cfo", "#c4b76b"),
      si:           readCssColor("--role-si", "#b39bd1"),
      guardian:     readCssColor("--role-guardian", "#c66363"),
    },
  };
}
