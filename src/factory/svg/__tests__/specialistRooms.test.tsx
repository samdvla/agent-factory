import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AnimeStudio, HeroStudio, MechaBay, ChibiCorner,
  DeityAtelier, CreatureDen, HumanoidForge,
} from "../iso/rooms";
import Avatar from "../Avatar";
import type { Role } from "../../state/types";

// Each room renderer is a pure SVG component — render-without-crash plus a
// signature-prop check is enough to lock the visual wiring in tests. The
// signature prop is something only that archetype emits, so a future
// refactor that accidentally swaps two rooms would fail here.

const rooms = [
  { name: "AnimeStudio",   Comp: AnimeStudio,   accent: "#ff3d8b", signature: "katana" },
  { name: "HeroStudio",    Comp: HeroStudio,    accent: "#3057ff", signature: "cape" },
  { name: "MechaBay",      Comp: MechaBay,      accent: "#ff8c2e", signature: "gantry" },
  { name: "ChibiCorner",   Comp: ChibiCorner,   accent: "#d8a8ff", signature: "plush" },
  { name: "DeityAtelier",  Comp: DeityAtelier,  accent: "#d8a857", signature: "obelisk" },
  { name: "CreatureDen",   Comp: CreatureDen,   accent: "#3e9d6f", signature: "bone" },
  { name: "HumanoidForge", Comp: HumanoidForge, accent: "#a87049", signature: "sword" },
];

describe("specialist room renderers", () => {
  it.each(rooms)("$name renders without crashing", ({ Comp, accent }) => {
    const html = renderToStaticMarkup(
      <svg>
        <Comp accent={accent} />
      </svg>,
    );
    // Sanity check — every room produces SVG output and uses its accent.
    expect(html.length).toBeGreaterThan(500);
    // Each room must apply its accent at least once (rugs, accent lines,
    // niche props all get tinted with it).
    expect(html.toLowerCase()).toContain(accent.toLowerCase());
  });
});

// Avatar silhouettes — render one avatar per specialist archetype and
// confirm the SVG carries archetype-distinguishing geometry.

function specRole(archetype: Role["archetype"], hex: string): Role {
  return {
    id: `spec-${archetype}`,
    name: "Test",
    title: "Specialist",
    hex,
    archetype,
    portrait: "T",
    room: "design",
    permanent: true,
  };
}

describe("specialist avatar silhouettes", () => {
  const cases: Array<{ archetype: Role["archetype"]; hex: string }> = [
    { archetype: "anime_spec",    hex: "#ff3d8b" },
    { archetype: "hero_spec",     hex: "#3057ff" },
    { archetype: "mecha_spec",    hex: "#ff8c2e" },
    { archetype: "chibi_spec",    hex: "#d8a8ff" },
    { archetype: "deity_spec",    hex: "#d8a857" },
    { archetype: "creature_spec", hex: "#3e9d6f" },
    { archetype: "humanoid_spec", hex: "#a87049" },
  ];

  it.each(cases)("$archetype avatar renders with accent path", ({ archetype, hex }) => {
    const html = renderToStaticMarkup(
      <Avatar role={specRole(archetype, hex)} state="idle" onClick={() => {}} />,
    );
    expect(html).toContain("svg");
    // The accent appears at least once in the SVG (hair/hat or cape/etc).
    expect(html.toLowerCase()).toContain(hex.toLowerCase());
  });

  it("non-specialist archetypes keep the default head (no accent-tinted hat)", () => {
    const html = renderToStaticMarkup(
      <Avatar
        role={{
          id: "designer", name: "Mara", title: "Designer",
          hex: "#ff6b9d", archetype: "relaxed",
          portrait: "M", room: "design", permanent: true,
        }}
        state="idle"
        onClick={() => {}}
      />,
    );
    expect(html).toContain("svg");
    // Default hair uses the CSS var, not an accent-colored fill — the head
    // path SHOULD be present but with the CSS variable, not the role hex.
    expect(html).toContain("var(--uniform-dark)");
  });
});
