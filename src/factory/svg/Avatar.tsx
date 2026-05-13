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

/**
 * Per-role hair / hat. Replaces the default swoop with a silhouette that
 * differentiates each role at a glance — silhouette is the biggest legibility
 * lever at this scale, much more than any tiny on-face accessory.
 *
 * Coord system: head center is (0, hcy). Head bottom = hcy + headR (touches
 * torso top). All shapes are filled (no thin strokes) so they stay crisp.
 */
function RoleHair({
  roleId, accent, hcy, headR,
}: { roleId: string; accent: string; hcy: number; headR: number }): ReactNode {
  const hair = "var(--uniform-dark)";

  switch (roleId) {
    case "designer": {
      // Beret hat on top, with a small wisp of hair underneath
      return (
        <g>
          <path
            d={`M ${-headR + 0.4} ${hcy - headR + 1.8}
                Q 0 ${hcy - headR + 0.4}
                  ${headR - 0.4} ${hcy - headR + 1.8} Z`}
            fill={hair}
          />
          <ellipse cx={-0.6} cy={hcy - headR + 0.2} rx={headR + 1.5} ry={1.5} fill={accent} />
          <ellipse cx={-0.6} cy={hcy - headR + 0.55} rx={headR + 0.7} ry={0.9}
            fill="var(--uniform-dark)" fillOpacity={0.16} />
          <circle cx={headR - 0.4} cy={hcy - headR - 1.0} r={0.6} fill={accent} />
        </g>
      );
    }
    case "publisher": {
      // Baseball cap (forward-facing) — fills the head crown + brim
      return (
        <g>
          <path
            d={`M ${-headR + 0.2} ${hcy - headR + 1.6}
                Q 0 ${hcy - headR - 1.4}
                  ${headR - 0.2} ${hcy - headR + 1.6}
                L ${headR + 0.2} ${hcy - headR + 2.4}
                L ${-headR - 0.2} ${hcy - headR + 2.4} Z`}
            fill={accent}
          />
          <ellipse cx={headR + 1.1} cy={hcy - headR + 2.1} rx={1.7} ry={0.55}
            fill={accent} fillOpacity={0.92} />
          <circle cx={0} cy={hcy - headR - 0.4} r={0.4} fill="var(--ink-0)" fillOpacity={0.3} />
        </g>
      );
    }
    case "research": {
      // Bob — chin-length on the sides, framing the face
      const top = hcy - headR - 1.4;
      const sides = hcy + headR - 0.2;
      const fringe = hcy - headR + 1.5;
      return (
        <path
          d={`M ${-headR - 0.7} ${sides}
              L ${-headR - 0.7} ${hcy - headR + 0.8}
              Q ${-headR + 0.2} ${top} 0 ${top - 0.2}
              Q ${headR - 0.2} ${top} ${headR + 0.7} ${hcy - headR + 0.8}
              L ${headR + 0.7} ${sides}
              L ${headR - 0.3} ${sides - 0.4}
              L ${headR - 0.4} ${fringe}
              L ${-headR + 0.4} ${fringe}
              L ${-headR + 0.3} ${sides - 0.4} Z`}
          fill={hair}
        />
      );
    }
    case "cs": {
      // Soft curls — overlapping rounds on top of the head
      return (
        <g fill={hair}>
          <ellipse cx={0} cy={hcy - headR + 0.7} rx={headR + 0.7} ry={1.4} />
          <circle cx={-2.3} cy={hcy - headR - 0.2} r={1.5} />
          <circle cx={-0.7} cy={hcy - headR - 1.0} r={1.6} />
          <circle cx={0.9} cy={hcy - headR - 1.0} r={1.6} />
          <circle cx={2.3} cy={hcy - headR - 0.2} r={1.5} />
        </g>
      );
    }
    case "cfo":
    case "orchestrator": {
      // Slicked back — flat low-profile with a sharp hairline
      return (
        <path
          d={`M ${-headR - 0.2} ${hcy - headR + 1.0}
              Q ${-headR + 1.4} ${hcy - headR - 0.8}
                ${headR + 0.2} ${hcy - headR + 1.6}
              L ${headR - 0.4} ${hcy - headR + 1.8}
              L ${-headR + 0.4} ${hcy - headR + 1.4} Z`}
          fill={hair}
        />
      );
    }
    case "listing": {
      // Side-swept — asymmetric peak, leaves the right ear free for a pencil
      return (
        <path
          d={`M ${-headR - 0.4} ${hcy - headR + 0.5}
              Q ${-headR + 1.4} ${hcy - headR - 2.0}
                ${headR + 0.4} ${hcy - headR + 0.8}
              L ${headR - 0.4} ${hcy - headR + 1.4}
              L ${-headR + 0.4} ${hcy - headR + 1.1} Z`}
          fill={hair}
        />
      );
    }
    case "si": {
      // Buzz cut — close to scalp, leaves room for antenna up top
      return (
        <path
          d={`M ${-headR + 0.2} ${hcy - headR + 1.4}
              Q 0 ${hcy - headR + 0.1}
                ${headR - 0.2} ${hcy - headR + 1.4}
              L ${headR - 0.4} ${hcy - headR + 1.7}
              L ${-headR + 0.4} ${hcy - headR + 1.7} Z`}
          fill={hair}
        />
      );
    }
  }

  // Default swoop — unchanged from the original
  return (
    <path
      d={`M ${-headR - 0.5} ${hcy - headR + 0.5}
          Q 0 ${hcy - headR * 2 - 1}
            ${headR + 0.5} ${hcy - headR + 0.5}
          L ${headR - 0.5} ${hcy - headR + 1}
          L ${-headR + 0.5} ${hcy - headR + 1} Z`}
      fill={hair}
    />
  );
}

/** Eyes — universal. Skipped when role has lenses overlaying the face. */
function RoleEyes({ hcy }: { hcy: number }): ReactNode {
  const eyeY = hcy + 0.5;
  const c = "var(--uniform-dark)";
  return (
    <g>
      <ellipse cx={-1.5} cy={eyeY} rx={0.55} ry={0.7} fill={c} />
      <ellipse cx={1.5} cy={eyeY} rx={0.55} ry={0.7} fill={c} />
    </g>
  );
}

/** Role-specific accessory — drawn on top of hair/eyes. */
function RoleAccessory({
  roleId, accent, hcy, headR,
}: { roleId: string; accent: string; hcy: number; headR: number }): ReactNode {
  const c = "var(--uniform-dark)";

  switch (roleId) {
    case "research": {
      // Round glasses (full pupils inside the rims)
      const eyeY = hcy + 0.5;
      return (
        <g>
          <circle cx={-1.5} cy={eyeY} r={1.25} fill="var(--bg-0)" fillOpacity={0.28} />
          <circle cx={1.5} cy={eyeY} r={1.25} fill="var(--bg-0)" fillOpacity={0.28} />
          <circle cx={-1.5} cy={eyeY} r={1.25} fill="none" stroke={c} strokeWidth={0.5} />
          <circle cx={1.5} cy={eyeY} r={1.25} fill="none" stroke={c} strokeWidth={0.5} />
          <line x1={-0.25} y1={eyeY} x2={0.25} y2={eyeY} stroke={c} strokeWidth={0.5} />
          <ellipse cx={-1.5} cy={eyeY} rx={0.4} ry={0.55} fill={c} />
          <ellipse cx={1.5} cy={eyeY} rx={0.4} ry={0.55} fill={c} />
        </g>
      );
    }
    case "cs": {
      // Headset arches over the curls, mic boom on the left
      return (
        <g>
          <path d={`M ${-headR + 0.1} ${hcy + 0.1}
                    Q 0 ${hcy - headR - 2.4}
                      ${headR - 0.1} ${hcy + 0.1}`}
            fill="none" stroke={c} strokeWidth={0.8} strokeLinecap="round" />
          <circle cx={-headR + 0.1} cy={hcy + 0.3} r={1.0} fill={c} />
          <circle cx={headR - 0.1} cy={hcy + 0.3} r={1.0} fill={c} />
          <circle cx={-headR + 0.1} cy={hcy + 0.3} r={0.5} fill={accent} />
          <circle cx={headR - 0.1} cy={hcy + 0.3} r={0.5} fill={accent} />
          <path d={`M ${-headR + 0.6} ${hcy + 1.0}
                    Q ${-headR + 1.4} ${hcy + 2.6}
                      ${-headR + 1.0} ${hcy + 3.4}`}
            fill="none" stroke={c} strokeWidth={0.55} strokeLinecap="round" />
          <circle cx={-headR + 1.0} cy={hcy + 3.4} r={0.55} fill={accent} />
        </g>
      );
    }
    case "cfo": {
      // Bow tie under the chin (on the chest top)
      const tieCy = hcy + headR + 1.6;
      return (
        <g>
          <path d={`M ${-2.4} ${tieCy - 1.2}
                    L ${-0.4} ${tieCy + 0.2}
                    L ${-2.4} ${tieCy + 1.4} Z`} fill={accent} />
          <path d={`M ${2.4} ${tieCy - 1.2}
                    L ${0.4} ${tieCy + 0.2}
                    L ${2.4} ${tieCy + 1.4} Z`} fill={accent} />
          <rect x={-0.6} y={tieCy - 0.6} width={1.2} height={1.3} rx={0.25} fill={accent} />
          <rect x={-0.6} y={tieCy - 0.6} width={1.2} height={0.45}
            fill="var(--uniform-dark)" opacity={0.3} />
        </g>
      );
    }
    case "si": {
      // Antenna with pulsing tip + soft halo
      return (
        <g>
          <line x1={0} y1={hcy - headR - 0.2} x2={0} y2={hcy - headR - 3.2}
            stroke={c} strokeWidth={0.6} strokeLinecap="round" />
          <circle cx={0} cy={hcy - headR - 3.5} r={1.6} fill={accent} fillOpacity={0.22}>
            <animate attributeName="r" values="1.4;2.0;1.4" dur="2.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.22;0.05;0.22" dur="2.4s" repeatCount="indefinite" />
          </circle>
          <circle cx={0} cy={hcy - headR - 3.5} r={0.9} fill={accent}>
            <animate attributeName="opacity" values="1;0.55;1" dur="2.4s" repeatCount="indefinite" />
          </circle>
        </g>
      );
    }
    case "listing": {
      // Pencil tucked behind the right ear (eraser + tip + body)
      return (
        <g transform={`rotate(-20 ${headR - 0.1} ${hcy})`}>
          <rect x={headR - 0.3} y={hcy - 0.5} width={2.8} height={0.85} rx={0.12}
            fill={accent} />
          <rect x={headR - 0.3} y={hcy - 0.5} width={0.55} height={0.85} rx={0.12}
            fill="var(--accent-bad)" fillOpacity={0.92} />
          <path d={`M ${headR + 2.5} ${hcy - 0.55}
                    L ${headR + 3.3} ${hcy - 0.07}
                    L ${headR + 2.5} ${hcy + 0.41} Z`}
            fill={c} />
        </g>
      );
    }
    case "orchestrator": {
      // 3-point crown pip sitting on the slick hair
      return (
        <g>
          <path d={`M ${-2.3} ${hcy - headR + 0.4}
                    L ${-2.0} ${hcy - headR - 1.4}
                    L ${-0.9} ${hcy - headR - 0.6}
                    L ${0} ${hcy - headR - 2.0}
                    L ${0.9} ${hcy - headR - 0.6}
                    L ${2.0} ${hcy - headR - 1.4}
                    L ${2.3} ${hcy - headR + 0.4} Z`}
            fill={accent} />
          <circle cx={0} cy={hcy - headR - 1.4} r={0.35} fill="var(--ink-0)" fillOpacity={0.45} />
        </g>
      );
    }
    case "guardian": {
      // Visor band across the forehead
      return (
        <path
          d={`M ${-headR + 0.3} ${hcy - 0.3}
              Q 0 ${hcy - headR + 1.5}
                ${headR - 0.3} ${hcy - 0.3}`}
          fill="none" stroke={accent} strokeWidth={0.9} strokeLinecap="round" />
      );
    }
  }
  return null;
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
  const isLab  = a === "lab";
  const isAuth = a === "authoritative";

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
        <rect x={-3}   y={-12} width={2.2} height={14} rx={1} fill="var(--uniform-dark)" />
        <rect x={0.8}  y={-12} width={2.2} height={14} rx={1} fill="var(--uniform-dark)" />
        <rect x={-torsoW / 2}       y={-torsoH - 12} width={torsoW}     height={torsoH + 2} rx={2.5} fill="var(--uniform)" />
        <rect x={-torsoW / 2 + 1.5} y={-torsoH - 9}  width={torsoW - 3} height={torsoH - 6} rx={1.5} fill={c} fillOpacity={0.85} />
        {rewards && rewards.stars > 0 && (() => {
          // 5×2 grid centered in the chest rect. Chest spans x ∈
          // [-torsoW/2+1.5, torsoW/2-1.5] and y ∈ [-torsoH-9, -15]; star
          // size + spacing keeps everything inside that with a small inset.
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
        {isAuth && (
          <rect x={-torsoW / 2 - 1} y={-torsoH - 10} width={torsoW + 2} height={3} rx={0.5} fill="var(--bg-0)" />
        )}
        {isLab && (
          <>
            {/* Lab coat: a narrow center stripe + a slight collar shading,
                instead of the previous full-torso white rect that read as a
                white sticker rather than a coat at standard zoom. */}
            <rect
              x={-1.4}
              y={-torsoH - 9}
              width={2.8}
              height={torsoH - 5}
              rx={1}
              fill="#e8edf2"
              fillOpacity={0.55}
            />
            <path
              d={`M ${-torsoW / 2 + 1.5} ${-torsoH - 9}
                  L 0 ${-torsoH - 6}
                  L ${torsoW / 2 - 1.5} ${-torsoH - 9} Z`}
              fill="#e8edf2"
              fillOpacity={0.4}
            />
          </>
        )}
        <circle cx={0} cy={-torsoH - 12 - headR - 0.5} r={headR} fill="var(--skin)" />
        <RoleHair roleId={role.id} accent={c} hcy={-torsoH - 12 - headR - 0.5} headR={headR} />
        {role.id !== "research" && <RoleEyes hcy={-torsoH - 12 - headR - 0.5} />}
        <RoleAccessory roleId={role.id} accent={c} hcy={-torsoH - 12 - headR - 0.5} headR={headR} />
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
