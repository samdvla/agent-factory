import { Role, AgentVisualState } from "../state/types";

const STATE_GLYPH: Record<AgentVisualState, string> = {
  working:     "⌨",
  idle:        "·",
  walking:     "→",
  awaiting:    "?",
  paused:      "Z",
  crashed:     "!",
  killed:      "×",
  quarantined: "⚠",
};

export default function Avatar({
  role, state, onClick,
}: {
  role: Role;
  state: AgentVisualState;
  onClick: () => void;
}) {
  if (state === "killed") return null;

  const c = role.hex;
  const a = role.archetype;
  const torsoH = a === "authoritative" ? 18 : a === "slim" ? 16 : a === "lab" ? 19 : 17;
  const torsoW = a === "formal" ? 11 : a === "lab" ? 12 : 10;
  const headR = 4;
  const isLab  = a === "lab";
  const isAuth = a === "authoritative";

  return (
    <div
      className={`avatar avatar-${state}`}
      onClick={onClick}
      title={`${role.name} · ${role.title}`}
      style={{ position: "relative", display: "inline-block", cursor: "pointer" }}
    >
      <svg viewBox="-16 -36 32 44" width={32} height={44} style={{ overflow: "visible" }}>
        {/* glow ring at feet */}
        <ellipse cx={0} cy={2} rx={11} ry={3} fill={c} fillOpacity={0.35} />
        <ellipse cx={0} cy={2} rx={7}  ry={2} fill={c} fillOpacity={0.7}  />
        {/* shadow under feet */}
        <ellipse cx={0} cy={3} rx={9}  ry={2} fill="#000" fillOpacity={0.45} />
        {/* legs */}
        <rect x={-3}   y={-12} width={2.2} height={14} rx={1} fill="#1f2a37" />
        <rect x={0.8}  y={-12} width={2.2} height={14} rx={1} fill="#1f2a37" />
        {/* torso */}
        <rect x={-torsoW / 2}       y={-torsoH - 12} width={torsoW}     height={torsoH + 2} rx={2.5} fill="#2a3849" />
        {/* vest accent */}
        <rect x={-torsoW / 2 + 1.5} y={-torsoH - 9}  width={torsoW - 3} height={torsoH - 6} rx={1.5} fill={c} fillOpacity={0.85} />
        {isAuth && (
          <rect x={-torsoW / 2 - 1} y={-torsoH - 10} width={torsoW + 2} height={3} rx={0.5} fill="#0e1620" />
        )}
        {isLab && (
          <rect x={-torsoW / 2 - 0.5} y={-torsoH - 8} width={torsoW + 1} height={torsoH - 4} rx={1.5} fill="#cdd5df" fillOpacity={0.85} />
        )}
        {/* head */}
        <circle cx={0} cy={-torsoH - 12 - headR - 0.5} r={headR} fill="#d8b894" />
        {/* hair cap */}
        <path
          d={`M ${-headR - 0.5} ${-torsoH - 12 - headR + 0.5} Q 0 ${-torsoH - 12 - headR * 2 - 1} ${headR + 0.5} ${-torsoH - 12 - headR + 0.5} L ${headR - 0.5} ${-torsoH - 12 - headR + 1} L ${-headR + 0.5} ${-torsoH - 12 - headR + 1} Z`}
          fill="#1f2a37"
        />
      </svg>
      <span className={`avatar-glyph glyph-${state}`}>{STATE_GLYPH[state]}</span>
    </div>
  );
}
