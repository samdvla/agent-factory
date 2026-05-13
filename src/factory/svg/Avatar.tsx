import type { ReactNode } from "react";
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
    default:
      return <span className="fx fx-paper" aria-hidden />;
  }
}


const STATE_GLYPH: Record<AgentVisualState, string> = {
  working:       "W",
  idle:          ".",
  walking:       ">",
  awaiting:      "?",
  paused:        "Z",
  crashed:       "!",
  killed:        "X",
  quarantined:   "Q",
  materializing: "+",
  dissolving:    "-",
};

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

  // Shoes: two slim parallelograms suggesting iso boots
  const shoe = (sx: number) => (
    <g>
      <polygon
        points={`${sx - 1.6},2 ${sx + 1.7},2 ${sx + 2.0},0 ${sx - 1.2},0`}
        fill={shoeColor}
      />
      <polygon
        points={`${sx - 1.2},0 ${sx + 2.0},0 ${sx + 2.0},-1 ${sx - 1.2},-1`}
        fill={lighterHex(shoeColor, 0.2)}
      />
    </g>
  );

  // Legs: 3-face boxes with iso depth
  const leg = (lx: number) => (
    <g>
      <polygon
        points={`${lx - 1.1},-1 ${lx - 1.1},-12 ${lx + 0.4},-13 ${lx + 0.4},-2`}
        fill={darkerHex(pants, 0.2)}
      />
      <polygon
        points={`${lx + 0.4},-2 ${lx + 0.4},-13 ${lx + 1.9},-12 ${lx + 1.9},-1`}
        fill={pants}
      />
      <polygon
        points={`${lx - 1.1},-12 ${lx + 0.4},-13 ${lx + 1.9},-12 ${lx + 0.4},-11`}
        fill={lighterHex(pants, 0.12)}
      />
    </g>
  );

  const baseY = -12;
  const torsoBottom = baseY;
  const torsoTop = baseY - torsoH;
  const torsoLeft = -torsoW / 2;
  const torsoRight = torsoW / 2;
  const dx = 2.4;
  const dy = -1.4;
  const accentLight = lighterHex(accent, 0.18);
  const accentDark = darkerHex(accent, 0.16);
  const armR = 1.6;
  return (
    <g>
      {shoe(-2.2)}
      {shoe(2.2)}
      {leg(-3.0)}
      {leg(1.0)}
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
      {/* Arms — visible as small accent circles either side of the torso, with
          a skin-colored hand just below to suggest the hand resting at desk
          level. Mirrors the handoff Agent's `arms + hands` rendering. */}
      <circle cx={torsoLeft - 0.8} cy={torsoTop + 5} r={armR} fill={accent} />
      <circle cx={torsoRight + 0.8} cy={torsoTop + 5} r={armR} fill={accent} />
      <circle cx={torsoLeft - 0.8} cy={torsoTop + 5 + armR + 0.6} r={armR * 0.8} fill={skin} />
      <circle cx={torsoRight + 0.8} cy={torsoTop + 5 + armR + 0.6} r={armR * 0.8} fill={skin} />
    </g>
  );
}

/**
 * Handoff-style head — skin ellipse with a soft drop shadow, a simple swoop
 * hair cap, two dot eyes, and a small mouth when the agent is working. No
 * role-specific accessories: the role identity now comes from the body's
 * accent color, matching the handoff zip's agent design exactly.
 */
function IsoHead({ torsoH, headR, state }: { torsoH: number; headR: number; state: import("../state/types").AgentVisualState }) {
  const hcy = -torsoH - 12 - headR - 0.5;
  const hair = "var(--uniform-dark)";
  const skin = "var(--skin)";
  // Soft drop shadow under the head
  const shadowY = hcy + 1.4;
  return (
    <g>
      {/* Neck — small skin-toned slab between torso and head */}
      <rect x={-1.6} y={-torsoH - 12 - 1.2} width={3.2} height={1.6} fill={skin} fillOpacity={0.85} />
      {/* Head shadow + main skin ellipse */}
      <ellipse cx={0} cy={shadowY} rx={headR} ry={headR * 0.96} fill="#000" fillOpacity={0.18} />
      <ellipse cx={0} cy={hcy} rx={headR} ry={headR * 0.96} fill={skin} />
      {/* Hair cap — gentle dome over the top of the head */}
      <path
        d={`M ${-headR} ${hcy + 0.15}
            Q 0 ${hcy - headR - 1.4}
              ${headR} ${hcy + 0.15}
            L ${headR - 0.4} ${hcy - 0.4}
            Q 0 ${hcy - headR + 0.5}
              ${-headR + 0.4} ${hcy - 0.4} Z`}
        fill={hair}
      />
      {/* Eyes — two small dark dots */}
      <ellipse cx={-headR * 0.36} cy={hcy} rx={0.55} ry={0.8} fill="#1a1c22" />
      <ellipse cx={headR * 0.36} cy={hcy} rx={0.55} ry={0.8} fill="#1a1c22" />
      {/* Mouth — present only when working */}
      {state === "working" && (
        <ellipse cx={0} cy={hcy + headR * 0.4} rx={1.0} ry={0.32} fill="#1a1c22" opacity={0.7} />
      )}
    </g>
  );
}

export default function Avatar({
  role, state, onClick, sizeScale = 1, lifetimeNet, rewards,
}: {
  role: Role;
  state: AgentVisualState;
  onClick: () => void;
  sizeScale?: number;
  /** Lifetime net P&L for this role, surfaced in the hover tooltip. */
  lifetimeNet?: number;
  /** Current reward state — drives the chest stars + tier color. */
  rewards?: { stars: number; tier: number };
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
        <IsoHead torsoH={torsoH} headR={headR} state={state} />
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
      {state !== "idle" && (
        <span
          className={`avatar-glyph glyph-${state}`}
          style={{
            top: -12 * sizeScale,
            // Scale via font + padding rather than transform: scale() so the
            // glyph (a unicode character) re-rasterizes crisp at every zoom
            // instead of being bitmap-stretched.
            fontSize: 11 * sizeScale,
            padding: `${1 * sizeScale}px ${4 * sizeScale}px`,
            minWidth: 14 * sizeScale,
            borderRadius: 8 * sizeScale,
            borderWidth: Math.max(1, sizeScale),
            transform: `translateX(-50%)`,
          }}
        >
          {STATE_GLYPH[state]}
        </span>
      )}
    </div>
  );
}
