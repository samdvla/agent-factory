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

export default function Avatar({
  role, state, onClick, sizeScale = 1, lifetimeNet,
}: {
  role: Role;
  state: AgentVisualState;
  onClick: () => void;
  sizeScale?: number;
  /** Lifetime net P&L for this role, surfaced in the hover tooltip. */
  lifetimeNet?: number;
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
        <rect x={-3}   y={-12} width={2.2} height={14} rx={1} fill="#1f2a37" />
        <rect x={0.8}  y={-12} width={2.2} height={14} rx={1} fill="#1f2a37" />
        <rect x={-torsoW / 2}       y={-torsoH - 12} width={torsoW}     height={torsoH + 2} rx={2.5} fill="#2a3849" />
        <rect x={-torsoW / 2 + 1.5} y={-torsoH - 9}  width={torsoW - 3} height={torsoH - 6} rx={1.5} fill={c} fillOpacity={0.85} />
        {isAuth && (
          <rect x={-torsoW / 2 - 1} y={-torsoH - 10} width={torsoW + 2} height={3} rx={0.5} fill="#0e1620" />
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
        <circle cx={0} cy={-torsoH - 12 - headR - 0.5} r={headR} fill="#d8b894" />
        <path
          d={`M ${-headR - 0.5} ${-torsoH - 12 - headR + 0.5} Q 0 ${-torsoH - 12 - headR * 2 - 1} ${headR + 0.5} ${-torsoH - 12 - headR + 0.5} L ${headR - 0.5} ${-torsoH - 12 - headR + 1} L ${-headR + 0.5} ${-torsoH - 12 - headR + 1} Z`}
          fill="#1f2a37"
        />
      </svg>
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
    </div>
  );
}
