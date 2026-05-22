import { memo, type ReactNode } from "react";
import { Role, AgentVisualState } from "../state/types";

function RoleWorkFx({ roleId }: { roleId: string }) {
  switch (roleId) {
    case "research":
      return (
        <span className="fx fx-chart" aria-hidden>
          <i className="bar b1" />
          <i className="bar b2" />
          <i className="bar b3" />
          <i className="bar b4" />
        </span>
      );
    case "designer":
      return (
        <span className="fx fx-swatch" aria-hidden>
          <i className="sw s1" />
          <i className="sw s2" />
          <i className="sw s3" />
        </span>
      );
    case "listing":
      return (
        <span className="fx fx-tags" aria-hidden>
          <i className="tag t1">#boho</i>
          <i className="tag t2">#svg</i>
          <i className="tag t3">#art</i>
        </span>
      );
    case "publisher":
      return (
        <span className="fx fx-upload" aria-hidden>
          <i className="upbar" />
          <i className="upcheck" />
        </span>
      );
    case "cs":
      return (
        <span className="fx fx-chat" aria-hidden>
          <i className="bub buyer" />
          <i className="bub agent" />
        </span>
      );
    case "cfo":
      return (
        <span className="fx fx-cash" aria-hidden>
          <i className="coin c1" />
          <i className="coin c2" />
          <i className="coin c3" />
          <i className="dollar">$</i>
        </span>
      );
    case "si":
      return (
        <span className="fx fx-spark" aria-hidden>
          <i className="orbit" />
          <i className="orbit o2" />
          <i className="core" />
        </span>
      );
    case "orchestrator":
      return (
        <span className="fx fx-board" aria-hidden>
          <i className="row r1" />
          <i className="row r2" />
          <i className="row r3" />
          <i className="check" />
        </span>
      );
    case "strategist":
      // Calliope writing prompt steers — three pen-scribble lines.
      return (
        <span className="fx fx-scribble" aria-hidden>
          <i className="line l1" />
          <i className="line l2" />
          <i className="line l3" />
        </span>
      );
    case "marketing":
      // Pinterest-style pin feed — three rectangles tiled like masonry.
      return (
        <span className="fx fx-pinfeed" aria-hidden>
          <i className="pin p1" />
          <i className="pin p2" />
          <i className="pin p3" />
        </span>
      );
    case "anime_spec":
      // Anime sparkle — three small stars twinkling on/off.
      return (
        <span className="fx fx-sparkle" aria-hidden>
          <i className="star s1" />
          <i className="star s2" />
          <i className="star s3" />
        </span>
      );
    case "hero_spec":
      // Comic-book burst — two action lines + a star center.
      return (
        <span className="fx fx-burst" aria-hidden>
          <i className="ray r1" />
          <i className="ray r2" />
          <i className="hero-star" />
        </span>
      );
    case "mecha_spec":
      // Mecha gear — a single cog spinning.
      return (
        <span className="fx fx-gear" aria-hidden>
          <i className="cog" />
        </span>
      );
    case "chibi_spec":
      // Pulsing heart with a tiny shimmer.
      return (
        <span className="fx fx-heart" aria-hidden>
          <i className="heart" />
          <i className="heart-glint" />
        </span>
      );
    case "deity_spec":
      // Halo / aura ring radiating outward.
      return (
        <span className="fx fx-halo" aria-hidden>
          <i className="halo-ring r1" />
          <i className="halo-ring r2" />
        </span>
      );
    case "creature_spec":
      // Three diagonal claw-rake marks.
      return (
        <span className="fx fx-claw" aria-hidden>
          <i className="slash s1" />
          <i className="slash s2" />
          <i className="slash s3" />
        </span>
      );
    case "humanoid_spec":
      // Shield + crossed sword silhouette.
      return (
        <span className="fx fx-shield" aria-hidden>
          <i className="shield" />
          <i className="blade" />
        </span>
      );
    default:
      // Generic fallback for any future role: a faint pulsing dot. Replaces
      // the previous `display: none` fx-paper so unknown agents still get a
      // visible "working" indicator when their state flips to working.
      return (
        <span className="fx fx-pulse" aria-hidden>
          <i className="pulse-dot" />
        </span>
      );
  }
}


const W = 32;
const H = 44;

// 5 tiers × 2 (filled vs empty slot). Empty slots are barely visible so the
// chest layout stays consistent as stars accumulate.
const TIER_COLORS = ["#cd7f32", "#c0c0c0", "#ffd700", "#b9f2ff", "#d8b4ff"];
const TIER_NAMES = ["bronze", "silver", "gold", "platinum", "diamond"];

/**
 * 5-point star SVG path. Even points at radius `r`, odd points at `r*0.42`.
 * Pre-rotated so the top point is straight up.
 */
function starPath(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.42;
    const x = cx + rad * Math.cos(a);
    const y = cy + rad * Math.sin(a);
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  pts.push("Z");
  return pts.join(" ");
}

/* ─── Iso body — handoff-style figurine (legs + torso as 3-face boxes) ─── */

function mixHex(a: string, b: string, amount: number): string {
  const parse = (h: string) => {
    const s = h.startsWith("#") ? h.slice(1) : h;
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const r = Math.round(ar + (br - ar) * amount);
  const g = Math.round(ag + (bg - ag) * amount);
  const bl = Math.round(ab + (bb - ab) * amount);
  return "#" + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
}

const darkerHex = (c: string, a = 0.18) => mixHex(c, "#000000", a);
const lighterHex = (c: string, a = 0.15) => mixHex(c, "#ffffff", a);

/**
 * Mini iso 3D figure that fills the same 32×44 viewBox the previous flat
 * avatar used. Coordinates are SVG-pixel space; we draw shoes, legs, and
 * torso as 3-face polygons (left / right / top) to give the figurine
 * dimensional shading without re-implementing the room-iso projection.
 * The viewBox shape stays identical so role hair / eyes / accessories /
 * chest stars defined elsewhere still line up over the head.
 */
function IsoBody({ torsoH, torsoW, accent }: { torsoH: number; torsoW: number; accent: string }) {
  // Handoff-style figurine: torso colored with the role accent, pants in
  // a darker shade of the same accent, shoes near-black, plus iso depth
  // shading on every solid (3 visible faces per box).
  const pants = darkerHex(accent, 0.55);
  const shoeColor = "#15171c";
  const skin = "var(--skin)";

  // Shoes — beefier iso parallelograms with a visible side face so each foot
  // reads as a 3D shape (not just a flat line) at base zoom.
  const shoe = (sx: number, side: "l" | "r") => (
    <g className={`avatar-shoe avatar-shoe-${side}`}>
      {/* sole / left dark face */}
      <polygon
        points={`${sx - 1.9},2.4 ${sx + 1.9},2.4 ${sx + 2.6},0.4 ${sx - 1.3},0.4`}
        fill={shoeColor}
      />
      {/* top */}
      <polygon
        points={`${sx - 1.3},0.4 ${sx + 2.6},0.4 ${sx + 2.6},-1.0 ${sx - 1.3},-1.0`}
        fill={lighterHex(shoeColor, 0.3)}
      />
      {/* side highlight */}
      <polygon
        points={`${sx + 1.9},2.4 ${sx + 2.6},0.4 ${sx + 2.6},-1.0 ${sx + 1.9},1.0`}
        fill={darkerHex(shoeColor, 0.4)}
      />
    </g>
  );

  // Legs — taller, thicker 3-face boxes with pronounced iso shading.
  const leg = (lx: number, side: "l" | "r") => (
    <g className={`avatar-leg avatar-leg-${side}`}>
      {/* dark left face */}
      <polygon
        points={`${lx - 1.4},-1 ${lx - 1.4},-12.5 ${lx + 0.4},-13.5 ${lx + 0.4},-2`}
        fill={darkerHex(pants, 0.25)}
      />
      {/* main right face */}
      <polygon
        points={`${lx + 0.4},-2 ${lx + 0.4},-13.5 ${lx + 2.4},-12.5 ${lx + 2.4},-1`}
        fill={pants}
      />
      {/* top face highlight */}
      <polygon
        points={`${lx - 1.4},-12.5 ${lx + 0.4},-13.5 ${lx + 2.4},-12.5 ${lx + 0.4},-11.5`}
        fill={lighterHex(pants, 0.2)}
      />
    </g>
  );

  const baseY = -12;
  const torsoBottom = baseY;
  const torsoTop = baseY - torsoH;
  const torsoLeft = -torsoW / 2;
  const torsoRight = torsoW / 2;
  // Narrower iso depth so arms can sit cleanly outside the torso silhouette.
  const dx = 1.6;
  const dy = -1.0;
  const accentLight = lighterHex(accent, 0.22);
  const accentDark = darkerHex(accent, 0.22);

  // Arm geometry: a tall capsule (upper arm) in the torso accent, with a
  // skin-colored hand below. Positioned just outside the front face so they
  // read clearly as "arms hanging at the sides" at the avatar's small size.
  const armW = 2.0;          // upper arm width
  const armH = 6.5;          // upper arm height
  const armPivotY = torsoTop + 3.2;
  const armPivotL = torsoLeft - armW / 2;
  const armPivotR = torsoRight + armW / 2;
  const handR = 1.55;
  return (
    <g>
      {shoe(-2.2, "l")}
      {shoe(2.2, "r")}
      {leg(-3.0, "l")}
      {leg(1.0, "r")}
      {/* Torso — left/front face in role accent */}
      <polygon
        points={`${torsoLeft},${torsoBottom} ${torsoLeft},${torsoTop} ${torsoRight},${torsoTop} ${torsoRight},${torsoBottom}`}
        fill={accent}
      />
      {/* Torso — right side (iso depth) */}
      <polygon
        points={`${torsoRight},${torsoBottom} ${torsoRight},${torsoTop} ${torsoRight + dx},${torsoTop + dy} ${torsoRight + dx},${torsoBottom + dy}`}
        fill={accentDark}
      />
      {/* Torso — top (iso depth) */}
      <polygon
        points={`${torsoLeft},${torsoTop} ${torsoLeft + dx},${torsoTop + dy} ${torsoRight + dx},${torsoTop + dy} ${torsoRight},${torsoTop}`}
        fill={accentLight}
      />
      {/* Shoulder accent stripe near the top of the torso front face */}
      <rect
        x={torsoLeft + 1.2}
        y={torsoTop + 2}
        width={torsoW - 2.4}
        height={1.4}
        fill={accentLight}
        fillOpacity={0.9}
      />
      {/* Arms — tall capsule sat just outside each torso edge plus a skin
          hand at the bottom. Vertical translate animations (driven by the
          .avatar-arm-l/.avatar-arm-r classes) bob the whole limb for walk
          and typing — simple translateY composes cleanly with SVG scale
          across zoom levels. */}
      <g className="avatar-arm avatar-arm-l">
        <rect
          x={armPivotL - armW / 2}
          y={armPivotY}
          width={armW}
          height={armH}
          rx={armW / 2}
          fill={accentDark}
        />
        <circle cx={armPivotL} cy={armPivotY + armH + handR * 0.4} r={handR} fill={skin} />
      </g>
      <g className="avatar-arm avatar-arm-r">
        <rect
          x={armPivotR - armW / 2}
          y={armPivotY}
          width={armW}
          height={armH}
          rx={armW / 2}
          fill={accent}
        />
        <circle cx={armPivotR} cy={armPivotY + armH + handR * 0.4} r={handR} fill={skin} />
      </g>
    </g>
  );
}

/**
 * Specialist hair/hat silhouettes. Each shape sits over the base skull
 * ellipse and is the PRIMARY way a viewer tells one specialist apart from
 * another at the floor's small avatar scale. Silhouette-first per the
 * project pin: distinct profile beats layered details.
 */
function SpecialistHat({
  archetype, headR, hcy, accent,
}: {
  archetype: import("../state/types").AvatarArchetype;
  headR: number; hcy: number; accent: string;
}) {
  switch (archetype) {
    case "anime_spec":
      // Spiked twin-tail — two pointed pigtails flaring outward from a
      // tall spiky crown.
      return (
        <g>
          {/* Crown — tall jagged hairline */}
          <path
            d={`M ${-headR} ${hcy + 0.2}
                L ${-headR * 0.7} ${hcy - headR * 1.6}
                L ${-headR * 0.3} ${hcy - headR * 0.6}
                L 0 ${hcy - headR * 2.0}
                L ${headR * 0.3} ${hcy - headR * 0.6}
                L ${headR * 0.7} ${hcy - headR * 1.6}
                L ${headR} ${hcy + 0.2}
                L ${headR - 0.4} ${hcy - 0.4}
                L ${-headR + 0.4} ${hcy - 0.4} Z`}
            fill={accent}
          />
          {/* Left pigtail */}
          <path
            d={`M ${-headR - 0.1} ${hcy - headR * 0.2}
                L ${-headR - 2.5} ${hcy + headR * 0.4}
                L ${-headR - 1.6} ${hcy + headR * 0.6}
                L ${-headR + 0.2} ${hcy + 0.4} Z`}
            fill={accent}
          />
          {/* Right pigtail */}
          <path
            d={`M ${headR + 0.1} ${hcy - headR * 0.2}
                L ${headR + 2.5} ${hcy + headR * 0.4}
                L ${headR + 1.6} ${hcy + headR * 0.6}
                L ${headR - 0.2} ${hcy + 0.4} Z`}
            fill={accent}
          />
        </g>
      );
    case "hero_spec":
      // Domino mask + slicked-back hair. The mask is the silhouette anchor.
      return (
        <g>
          {/* Hair (slicked back, low) */}
          <path
            d={`M ${-headR} ${hcy + 0.15}
                Q 0 ${hcy - headR * 0.9}
                  ${headR} ${hcy + 0.15}
                L ${headR - 0.4} ${hcy - 0.4}
                Q 0 ${hcy - headR + 0.5}
                  ${-headR + 0.4} ${hcy - 0.4} Z`}
            fill="#101015"
          />
          {/* Domino mask — solid stripe across the eyes */}
          <path
            d={`M ${-headR + 0.1} ${hcy - 0.5}
                L ${-headR * 0.15} ${hcy - 0.9}
                L ${headR * 0.15} ${hcy - 0.9}
                L ${headR - 0.1} ${hcy - 0.5}
                L ${headR - 0.1} ${hcy + 0.7}
                L ${headR * 0.15} ${hcy + 0.6}
                L ${-headR * 0.15} ${hcy + 0.6}
                L ${-headR + 0.1} ${hcy + 0.7} Z`}
            fill={accent}
          />
          {/* Mask eye-slit highlights */}
          <ellipse cx={-headR * 0.36} cy={hcy + 0.05} rx={0.7} ry={0.45} fill="#fff" />
          <ellipse cx={headR * 0.36} cy={hcy + 0.05} rx={0.7} ry={0.45} fill="#fff" />
        </g>
      );
    case "mecha_spec":
      // Pilot helmet with a forward visor and a single antenna.
      return (
        <g>
          {/* Helmet shell — wraps the top half of the head + a bit below */}
          <path
            d={`M ${-headR - 0.4} ${hcy + 0.8}
                Q ${-headR - 0.4} ${hcy - headR * 1.4}
                  0 ${hcy - headR * 1.6}
                Q ${headR + 0.4} ${hcy - headR * 1.4}
                  ${headR + 0.4} ${hcy + 0.8}
                Q 0 ${hcy + headR * 0.4}
                  ${-headR - 0.4} ${hcy + 0.8} Z`}
            fill={accent}
            stroke="#101015"
            strokeWidth={0.25}
          />
          {/* Visor — dark band across eye level */}
          <path
            d={`M ${-headR - 0.2} ${hcy - 0.5}
                Q 0 ${hcy - 0.2}
                  ${headR + 0.2} ${hcy - 0.5}
                L ${headR + 0.2} ${hcy + 0.6}
                Q 0 ${hcy + 0.8}
                  ${-headR - 0.2} ${hcy + 0.6} Z`}
            fill="#10131a"
          />
          {/* Visor reflection sheen */}
          <line x1={-headR * 0.6} y1={hcy - 0.1} x2={headR * 0.2} y2={hcy + 0.3} stroke={accent} strokeWidth={0.45} opacity={0.85} />
          {/* Antenna on the right side */}
          <line x1={headR + 0.1} y1={hcy - headR * 1.1} x2={headR + 0.7} y2={hcy - headR * 1.9} stroke="#101015" strokeWidth={0.4} />
          <circle cx={headR + 0.7} cy={hcy - headR * 1.9} r={0.35} fill={accent} />
        </g>
      );
    case "chibi_spec":
      // Cat-ear headband — two pointed ears poking up from a soft round hair.
      return (
        <g>
          {/* Round hair dome (softer than default) */}
          <path
            d={`M ${-headR - 0.2} ${hcy + 0.2}
                Q 0 ${hcy - headR * 1.5}
                  ${headR + 0.2} ${hcy + 0.2}
                L ${headR - 0.4} ${hcy - 0.4}
                Q 0 ${hcy - headR + 0.5}
                  ${-headR + 0.4} ${hcy - 0.4} Z`}
            fill={accent}
          />
          {/* Left ear */}
          <polygon
            points={`${-headR * 0.7},${hcy - headR * 1.0}
                     ${-headR * 0.2},${hcy - headR * 1.0}
                     ${-headR * 0.45},${hcy - headR * 1.9}`}
            fill={accent}
          />
          <polygon
            points={`${-headR * 0.6},${hcy - headR * 1.05}
                     ${-headR * 0.3},${hcy - headR * 1.05}
                     ${-headR * 0.45},${hcy - headR * 1.55}`}
            fill="#fff1f6"
          />
          {/* Right ear */}
          <polygon
            points={`${headR * 0.2},${hcy - headR * 1.0}
                     ${headR * 0.7},${hcy - headR * 1.0}
                     ${headR * 0.45},${hcy - headR * 1.9}`}
            fill={accent}
          />
          <polygon
            points={`${headR * 0.3},${hcy - headR * 1.05}
                     ${headR * 0.6},${hcy - headR * 1.05}
                     ${headR * 0.45},${hcy - headR * 1.55}`}
            fill="#fff1f6"
          />
        </g>
      );
    case "deity_spec":
      // Laurel wreath crown — two arcs of small leaves over a low hair cap.
      return (
        <g>
          {/* Hair cap (low so the laurel reads on top) */}
          <path
            d={`M ${-headR} ${hcy + 0.15}
                Q 0 ${hcy - headR * 0.8}
                  ${headR} ${hcy + 0.15}
                L ${headR - 0.4} ${hcy - 0.4}
                Q 0 ${hcy - headR + 0.5}
                  ${-headR + 0.4} ${hcy - 0.4} Z`}
            fill="#4a3520"
          />
          {/* Laurel — two arcs of small leaves at temple level */}
          {[
            { dx: -headR * 0.85, dy: -headR * 0.7, rot: -25 },
            { dx: -headR * 0.55, dy: -headR * 0.95, rot: -15 },
            { dx: -headR * 0.18, dy: -headR * 1.05, rot: -5 },
            { dx:  headR * 0.18, dy: -headR * 1.05, rot:  5 },
            { dx:  headR * 0.55, dy: -headR * 0.95, rot: 15 },
            { dx:  headR * 0.85, dy: -headR * 0.7, rot: 25 },
          ].map((p, i) => (
            <ellipse
              key={i}
              cx={p.dx}
              cy={hcy + p.dy}
              rx={0.9}
              ry={0.45}
              fill={accent}
              transform={`rotate(${p.rot} ${p.dx} ${hcy + p.dy})`}
            />
          ))}
        </g>
      );
    case "creature_spec":
      // Hooded silhouette with two short curled horns poking through.
      return (
        <g>
          {/* Hood — wraps head + extends down past the chin */}
          <path
            d={`M ${-headR - 0.6} ${hcy + 1.2}
                Q ${-headR - 0.6} ${hcy - headR * 1.2}
                  0 ${hcy - headR * 1.3}
                Q ${headR + 0.6} ${hcy - headR * 1.2}
                  ${headR + 0.6} ${hcy + 1.2}
                Q 0 ${hcy + headR * 0.6}
                  ${-headR - 0.6} ${hcy + 1.2} Z`}
            fill={accent}
          />
          {/* Hood inner shadow ring */}
          <path
            d={`M ${-headR + 0.2} ${hcy + 0.6}
                Q 0 ${hcy - headR * 0.6}
                  ${headR - 0.2} ${hcy + 0.6}
                Q 0 ${hcy + headR * 0.45}
                  ${-headR + 0.2} ${hcy + 0.6} Z`}
            fill="#000"
            fillOpacity={0.35}
          />
          {/* Left horn (small curled tusk) */}
          <path
            d={`M ${-headR * 0.6} ${hcy - headR * 1.0}
                Q ${-headR * 1.0} ${hcy - headR * 1.6}
                  ${-headR * 0.5} ${hcy - headR * 1.7}
                Q ${-headR * 0.4} ${hcy - headR * 1.2}
                  ${-headR * 0.6} ${hcy - headR * 1.0} Z`}
            fill="#e8d5b0"
            stroke="#1a1410"
            strokeWidth={0.18}
          />
          {/* Right horn (mirrored) */}
          <path
            d={`M ${headR * 0.6} ${hcy - headR * 1.0}
                Q ${headR * 1.0} ${hcy - headR * 1.6}
                  ${headR * 0.5} ${hcy - headR * 1.7}
                Q ${headR * 0.4} ${hcy - headR * 1.2}
                  ${headR * 0.6} ${hcy - headR * 1.0} Z`}
            fill="#e8d5b0"
            stroke="#1a1410"
            strokeWidth={0.18}
          />
        </g>
      );
    case "humanoid_spec":
      // Winged helm — open-face helmet with a centerline ridge and a pair
      // of small wings flaring out at the temples.
      return (
        <g>
          {/* Helmet shell — wraps the top + sides, leaves the face open */}
          <path
            d={`M ${-headR - 0.3} ${hcy + 0.6}
                Q ${-headR - 0.3} ${hcy - headR * 1.4}
                  0 ${hcy - headR * 1.5}
                Q ${headR + 0.3} ${hcy - headR * 1.4}
                  ${headR + 0.3} ${hcy + 0.6}
                L ${headR - 0.2} ${hcy + 0.2}
                Q 0 ${hcy - headR * 0.6}
                  ${-headR + 0.2} ${hcy + 0.2} Z`}
            fill={accent}
          />
          {/* Center ridge crest */}
          <path
            d={`M -0.25 ${hcy - headR * 1.5}
                L 0.25 ${hcy - headR * 1.5}
                L 0.1 ${hcy + 0.4}
                L -0.1 ${hcy + 0.4} Z`}
            fill="#f0e2c2"
          />
          {/* Left wing */}
          <path
            d={`M ${-headR - 0.2} ${hcy - headR * 0.5}
                L ${-headR - 2.4} ${hcy - headR * 0.95}
                L ${-headR - 1.6} ${hcy - headR * 0.5}
                L ${-headR - 0.2} ${hcy - headR * 0.2} Z`}
            fill="#f0e2c2"
            stroke="#3a2818"
            strokeWidth={0.2}
          />
          {/* Right wing */}
          <path
            d={`M ${headR + 0.2} ${hcy - headR * 0.5}
                L ${headR + 2.4} ${hcy - headR * 0.95}
                L ${headR + 1.6} ${hcy - headR * 0.5}
                L ${headR + 0.2} ${hcy - headR * 0.2} Z`}
            fill="#f0e2c2"
            stroke="#3a2818"
            strokeWidth={0.2}
          />
        </g>
      );
    default:
      return null;
  }
}

/**
 * Handoff-style head — skin ellipse with a soft drop shadow, a simple swoop
 * hair cap, two dot eyes, and a small mouth when the agent is working.
 * Specialist archetypes swap the default hair for a distinct hat/silhouette
 * via SpecialistHat — the small avatar scale means hair/hat is the only
 * thing that reads, so each specialist has its own unmistakable shape.
 */
function IsoHead({
  torsoH, headR, state, archetype, accent,
}: {
  torsoH: number; headR: number;
  state: import("../state/types").AgentVisualState;
  archetype: import("../state/types").AvatarArchetype;
  accent: string;
}) {
  const hcy = -torsoH - 12 - headR - 0.5;
  const hair = "var(--uniform-dark)";
  const skin = "var(--skin)";
  // Soft drop shadow under the head
  const shadowY = hcy + 1.4;
  const isSpecialist =
    archetype === "anime_spec" || archetype === "hero_spec" ||
    archetype === "mecha_spec" || archetype === "chibi_spec" ||
    archetype === "deity_spec" || archetype === "creature_spec" ||
    archetype === "humanoid_spec";
  // Helm / hood / mask styles cover the eyes themselves — don't draw the
  // dot eyes on top of an opaque mask/visor/hood.
  const coversEyes =
    archetype === "hero_spec" || archetype === "mecha_spec" ||
    archetype === "creature_spec";
  return (
    <g>
      {/* Neck — small skin-toned slab between torso and head */}
      <rect x={-1.6} y={-torsoH - 12 - 1.2} width={3.2} height={1.6} fill={skin} fillOpacity={0.85} />
      {/* Head shadow + main skin ellipse */}
      <ellipse cx={0} cy={shadowY} rx={headR} ry={headR * 0.96} fill="#000" fillOpacity={0.18} />
      <ellipse cx={0} cy={hcy} rx={headR} ry={headR * 0.96} fill={skin} />
      {isSpecialist ? (
        <SpecialistHat archetype={archetype} headR={headR} hcy={hcy} accent={accent} />
      ) : (
        /* Default hair cap — gentle dome over the top of the head */
        <path
          d={`M ${-headR} ${hcy + 0.15}
              Q 0 ${hcy - headR - 1.4}
                ${headR} ${hcy + 0.15}
              L ${headR - 0.4} ${hcy - 0.4}
              Q 0 ${hcy - headR + 0.5}
                ${-headR + 0.4} ${hcy - 0.4} Z`}
          fill={hair}
        />
      )}
      {/* Eyes — two small dark dots; suppressed when the silhouette covers
          them (mask, visor, deep hood) so they don't bleed through. */}
      {!coversEyes && (
        <>
          <ellipse cx={-headR * 0.36} cy={hcy} rx={0.55} ry={0.8} fill="#1a1c22" />
          <ellipse cx={headR * 0.36} cy={hcy} rx={0.55} ry={0.8} fill="#1a1c22" />
        </>
      )}
      {/* Mouth — present only when working AND the lower face isn't hooded */}
      {state === "working" && archetype !== "creature_spec" && (
        <ellipse cx={0} cy={hcy + headR * 0.4} rx={1.0} ry={0.32} fill="#1a1c22" opacity={0.7} />
      )}
    </g>
  );
}

function Avatar({
  role, state, onClick, sizeScale = 1, lifetimeNet, rewards, thought,
}: {
  role: Role;
  state: AgentVisualState;
  onClick: () => void;
  sizeScale?: number;
  /** Lifetime net P&L for this role, surfaced in the hover tooltip. */
  lifetimeNet?: number;
  /** Current reward state — drives the chest stars + tier color. */
  rewards?: { stars: number; tier: number };
  /** Short 1-2 line "what they're working on / talking about" string. When
   *  set, renders a speech-bubble thought cloud above the avatar's head.
   *  AvatarLayer derives this from the most recent ticker line for the role
   *  (falling back to the agent's task), so it reflects live activity. */
  thought?: string;
}) {
  if (state === "killed") return null;

  const c = role.hex;
  const a = role.archetype;
  const torsoH = a === "authoritative" ? 18 : a === "slim" ? 16 : a === "lab" ? 19 : 17;
  const torsoW = a === "formal" ? 11 : a === "lab" ? 12 : 10;
  const headR = 4;

  // Native size = display size at this zoom. The browser rasterizes the SVG
  // at this size, so the avatar stays crisp at every zoom level.
  const sw = W * sizeScale;
  const sh = H * sizeScale;

  return (
    <div
      className={`avatar avatar-${state}`}
      data-role={role.id}
      onClick={onClick}
      title={`${role.name} · ${role.title} · net $${
        (lifetimeNet ?? 0).toFixed(2)
      }`}
      style={
        {
          position: "relative",
          display: "inline-block",
          width: sw,
          height: sh,
          cursor: "pointer",
          ["--role-color" as string]: c,
        } as React.CSSProperties
      }
    >
      {/* Thought cloud — a small speech bubble above the head showing what
          the agent is currently working on / talking about. BOTH its size
          (scale) AND its vertical offset (bottom) scale with sizeScale: the
          avatar figure is `sh = H * sizeScale` tall, so anchoring the
          bubble's bottom edge at `sh` keeps it sitting right on top of the
          head at every zoom level. A fixed-px bottom dropped it to body
          level when zoomed in. transform-origin 50% 100% means the bubble
          grows upward from that head-top anchor. */}
      {thought && (
        <div
          className="avatar-thought"
          style={{
            bottom: sh,
            transform: `translateX(-50%) scale(${sizeScale})`,
            transformOrigin: "50% 100%",
          }}
        >
          <span className="thought-text">{thought}</span>
        </div>
      )}
      {/* FX layer — keeps its natural 32×44 box and scales as a unit so all
          internal pixel-positioned children stay in proportion. */}
      <div
        className="avatar-fx"
        style={{
          transform: `translateX(-50%) scale(${sizeScale})`,
          transformOrigin: "50% 100%",
        }}
      >
        <span className="glow" />
        <RoleWorkFx roleId={role.id} />
      </div>
      <svg
        className="avatar-figure"
        viewBox="-16 -36 32 44"
        width={sw}
        height={sh}
        style={{ overflow: "visible" }}
      >
        <ellipse cx={0} cy={2} rx={11} ry={3} fill={c} fillOpacity={0.35} />
        <ellipse cx={0} cy={2} rx={7}  ry={2} fill={c} fillOpacity={0.7}  />
        <ellipse cx={0} cy={3} rx={9}  ry={2} fill="#000" fillOpacity={0.45} />
        <IsoBody torsoH={torsoH} torsoW={torsoW} accent={c} />
        <IsoHead torsoH={torsoH} headR={headR} state={state} archetype={a} accent={c} />
        {rewards && rewards.stars > 0 && (() => {
          // Reward stars sit on the front face of the iso torso.
          const STAR_R = 0.45;
          const COL_W = (torsoW - 4) / 5;
          const ROW_H = 1.5;
          const x0 = -torsoW / 2 + 2 + COL_W / 2;
          const cyTop = -torsoH - 7 + ROW_H / 2;
          const color = TIER_COLORS[Math.min(rewards.tier, TIER_COLORS.length - 1)];
          const slots: ReactNode[] = [];
          for (let i = 0; i < 10; i++) {
            const col = i % 5;
            const row = Math.floor(i / 5);
            const sx = x0 + col * COL_W;
            const sy = cyTop + row * ROW_H;
            const filled = i < rewards.stars;
            slots.push(
              <path
                key={i}
                d={starPath(sx, sy, STAR_R)}
                fill={filled ? color : "#0e1620"}
                fillOpacity={filled ? 0.95 : 0.5}
                stroke={filled ? color : "#1f2a37"}
                strokeWidth={0.08}
              />
            );
          }
          return <g aria-label={`${rewards.stars} ${TIER_NAMES[Math.min(rewards.tier, TIER_NAMES.length - 1)]} stars`}>{slots}</g>;
        })()}
      </svg>
      {/* The old state-glyph badge (W / > / ? above the head) was removed —
          the natural thought cloud now conveys what each agent is doing, so
          the single-letter pill is redundant. */}
    </div>
  );
}

// Avatar renders a heavy SVG figure. Skip re-rendering it unless a prop that
// actually changes the picture changed. `onClick` is intentionally excluded:
// the parent recreates the closure every render, but it always resolves to
// the same stable store action for this role, so ignoring it is correct and
// keeps the figure from re-rendering on every animation frame / pan tick.
// role and rewards are referentially stable from the store between visual
// changes, so a reference compare is both safe and cheap.
function avatarPropsEqual(
  prev: Parameters<typeof Avatar>[0],
  next: Parameters<typeof Avatar>[0],
): boolean {
  return (
    prev.role === next.role &&
    prev.state === next.state &&
    prev.sizeScale === next.sizeScale &&
    prev.lifetimeNet === next.lifetimeNet &&
    prev.rewards === next.rewards &&
    prev.thought === next.thought
  );
}

export default memo(Avatar, avatarPropsEqual);
