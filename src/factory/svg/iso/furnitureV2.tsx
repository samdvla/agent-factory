import {
  Box, Cylinder, Sphere, WallDecal,
  iso3, U, lighter, darker, pts,
} from "./primitives";

const fmt = (n: number) => n.toFixed(2);

// ───── OvalTable ─────
export function OvalTable({
  x = 0, y = 0, w = 2.8, d = 1.7, color = "#b8855a",
}: {
  x?: number; y?: number; w?: number; d?: number; color?: string;
}) {
  const cx = x + w / 2;
  const cy = y + d / 2;
  const top = iso3(cx, cy, 1.18);
  const rx = (w * U) / 2 + 4;
  const ry = (d * U) / 2 - 3;
  return (
    <g>
      <Cylinder x={cx} y={cy} z={0} r={0.32} h={1.1} color={darker(color, 0.5)} />
      <ellipse cx={top.x} cy={top.y + 8} rx={rx * 1.05} ry={ry * 1.05} fill="rgba(0,0,0,0.15)" />
      <ellipse cx={top.x} cy={top.y + 5} rx={rx} ry={ry} fill={darker(color, 0.22)} />
      <ellipse cx={top.x} cy={top.y} rx={rx} ry={ry} fill={lighter(color, 0.05)} />
      <ellipse cx={top.x - rx * 0.3} cy={top.y - ry * 0.2} rx={rx * 0.4} ry={ry * 0.15} fill="rgba(255,255,255,0.18)" />
    </g>
  );
}

// ───── OfficeChair (4 facing directions) ─────
type ChairFace = "back-left" | "back-right" | "front-left" | "front-right";
export function OfficeChair({
  x = 0, y = 0, color = "#2d2f38", accent, face = "back-left", size = 0.66,
}: {
  x?: number; y?: number; color?: string; accent?: string;
  face?: ChairFace;
  /**
   * Chair footprint in world units. Default 0.66 (≈ 11% of a 6×6 room),
   * matching the handoff's 1.1 chair in a 10×10 room when both rooms are
   * scaled to the same on-screen proportion.
   */
  size?: number;
}) {
  const s = size;
  const halfR = s / 2;
  const cx = x + halfR;
  const cy = y + halfR;
  const baseR = halfR * 0.95; // outer radius of the rolling base star

  // 10-pt star points for the rolling base
  const basePts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? baseR : baseR * 0.32;
    const ex = cx + Math.cos(ang) * r;
    const ey = cy + Math.sin(ang) * r;
    const p = iso3(ex, ey, 0.04);
    basePts.push(`${fmt(p.x)},${fmt(p.y)}`);
  }

  // 5 wheel caps at outer star tips
  const wheels: React.ReactNode[] = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const ex = cx + Math.cos(ang) * baseR;
    const ey = cy + Math.sin(ang) * baseR;
    const p = iso3(ex, ey, 0.04);
    wheels.push(
      <ellipse key={i} cx={p.x} cy={p.y + 2} rx={U * 0.13 * (s / 1.1)} ry={U * 0.06 * (s / 1.1)} fill="#08090d" />,
    );
  }

  const seat = accent || color;
  const seatInset = s * 0.13;
  const seatW = s - seatInset * 2;
  const armInset = s * 0.07;
  const armLen = s - armInset * 2;
  const armT = s * 0.055;
  const backThick = s * 0.13;

  return (
    <g>
      {wheels}
      <polygon points={basePts.join(" ")} fill="#15171c" />
      {(() => {
        const hub = iso3(cx, cy, 0.07);
        return <ellipse cx={hub.x} cy={hub.y} rx={U * 0.12 * (s / 1.1)} ry={U * 0.06 * (s / 1.1)} fill="#2a2d35" />;
      })()}
      {/* Gas lift */}
      <Box x={cx - s * 0.055} y={cy - s * 0.055} z={0.07} w={s * 0.11} d={s * 0.11} h={0.7} color="#15171c" />
      {/* Seat — slightly rounded look via two stacked slabs */}
      <Box x={x + seatInset} y={y + seatInset} z={0.77} w={seatW} d={seatW} h={0.1} color={darker(seat, 0.18)} />
      <Box x={x + seatInset + s * 0.04} y={y + seatInset + s * 0.04} z={0.87} w={seatW - s * 0.08} d={seatW - s * 0.08} h={0.1} color={seat} />
      {/* Arm rests — orientation depends on chair face */}
      {(face === "back-left" || face === "front-left") && (
        <>
          <Box x={x + armInset - armT / 2} y={y + armInset} z={0.95} w={armT} d={armLen} h={0.05} color="#15171c" />
          <Box x={x + s - armInset - armT / 2} y={y + armInset} z={0.95} w={armT} d={armLen} h={0.05} color="#15171c" />
        </>
      )}
      {(face === "back-right" || face === "front-right") && (
        <>
          <Box x={x + armInset} y={y + armInset - armT / 2} z={0.95} w={armLen} d={armT} h={0.05} color="#15171c" />
          <Box x={x + armInset} y={y + s - armInset - armT / 2} z={0.95} w={armLen} d={armT} h={0.05} color="#15171c" />
        </>
      )}
      {/* Back rest */}
      {face === "back-left" && (
        <>
          <Box x={x + seatInset} y={y + s - seatInset - backThick} z={0.87} w={seatW} d={backThick} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + seatInset + s * 0.04} y={y + s - seatInset - backThick + 0.02} z={1.42} w={seatW - s * 0.08} d={backThick - 0.04} h={0.9} color={seat} />
          <Box x={x + seatInset + s * 0.13} y={y + s - seatInset - backThick + 0.02} z={2.32} w={seatW - s * 0.26} d={backThick - 0.06} h={0.18} color={darker(seat, 0.3)} />
        </>
      )}
      {face === "back-right" && (
        <>
          <Box x={x + s - seatInset - backThick} y={y + seatInset} z={0.87} w={backThick} d={seatW} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + s - seatInset - backThick + 0.02} y={y + seatInset + s * 0.04} z={1.42} w={backThick - 0.04} d={seatW - s * 0.08} h={0.9} color={seat} />
          <Box x={x + s - seatInset - backThick + 0.02} y={y + seatInset + s * 0.13} z={2.32} w={backThick - 0.06} d={seatW - s * 0.26} h={0.18} color={darker(seat, 0.3)} />
        </>
      )}
      {face === "front-left" && (
        <>
          <Box x={x + seatInset} y={y + seatInset - backThick + 0.06} z={0.87} w={seatW} d={backThick} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + seatInset + s * 0.04} y={y + seatInset - backThick + 0.06} z={1.42} w={seatW - s * 0.08} d={backThick - 0.04} h={0.9} color={seat} />
        </>
      )}
      {face === "front-right" && (
        <>
          <Box x={x + seatInset - backThick + 0.06} y={y + seatInset} z={0.87} w={backThick} d={seatW} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + seatInset - backThick + 0.06} y={y + seatInset + s * 0.04} z={1.42} w={backThick - 0.04} d={seatW - s * 0.08} h={0.9} color={seat} />
        </>
      )}
    </g>
  );
}

// ───── PendantLamp: cord + bell shade + glow disc ─────
export function PendantLamp({
  x = 0, y = 0, ceilZ = 4, dropTo = 3.0,
  color = "#f5d77a", shade: shadeC = "#f0eee5",
}: {
  x?: number; y?: number;
  ceilZ?: number; dropTo?: number;
  color?: string; shade?: string;
}) {
  const top = iso3(x, y, ceilZ);
  const bot = iso3(x, y, dropTo);
  return (
    <g>
      <line x1={top.x} y1={top.y} x2={bot.x} y2={bot.y} stroke="#1a1d23" strokeWidth={1.2} />
      <ellipse cx={bot.x} cy={bot.y - 2} rx={U * 0.32} ry={U * 0.14} fill={shadeC} />
      <ellipse cx={bot.x} cy={bot.y + 2} rx={U * 0.32} ry={U * 0.14} fill={darker(shadeC, 0.15)} />
      <ellipse cx={bot.x} cy={bot.y + 5} rx={U * 0.22} ry={U * 0.1} fill={color} opacity={0.95} />
    </g>
  );
}

// ───── Plant: clustered foliage on a pot, optional taller variant ─────
export function Plant({
  x = 0, y = 0, color = "#4a8f5a", pot = "#8e6748", tall = false, size = 0.48,
}: {
  x?: number; y?: number;
  color?: string; pot?: string;
  tall?: boolean;
  /** Footprint in world units. Default 0.48 ≈ scaled-down version of handoff's 0.8. */
  size?: number;
}) {
  const baseH = tall ? 1.6 : 0.5;
  const half = size / 2;
  return (
    <g>
      <Cylinder x={x + half} y={y + half} z={0} r={half * 0.8} h={baseH * 0.5} color={pot} />
      <Cylinder x={x + half} y={y + half} z={baseH * 0.5} r={half * 0.75} h={0.05} color="#4a3a2a" />
      <Sphere x={x + half} y={y + half} z={baseH + 0.05} r={half * 1.05} color={color} />
      <Sphere x={x + half + size * 0.25} y={y + half - size * 0.1} z={baseH + 0.22} r={half * 0.75} color={lighter(color, 0.12)} />
      <Sphere x={x + half - size * 0.25} y={y + half + size * 0.2} z={baseH + 0.18} r={half * 0.7} color={darker(color, 0.1)} />
      <Sphere x={x + half + size * 0.06} y={y + half + size * 0.19} z={baseH + 0.35} r={half * 0.55} color={lighter(color, 0.18)} />
    </g>
  );
}

// ───── TallPlant: tall stem + clustered foliage at top ─────
export function TallPlant({
  x = 0, y = 0, color = "#4a8f5a", pot = "#23262c", size = 0.48,
}: {
  x?: number; y?: number;
  color?: string; pot?: string;
  size?: number;
}) {
  const half = size / 2;
  return (
    <g>
      <Cylinder x={x + half} y={y + half} z={0} r={half * 0.95} h={0.65} color={pot} />
      <Cylinder x={x + half} y={y + half} z={0.65} r={half * 0.9} h={0.04} color={darker(pot, 0.3)} />
      <Box x={x + half - 0.02} y={y + half - 0.02} z={0.69} w={0.04} d={0.04} h={1.5} color={darker(color, 0.4)} />
      <Sphere x={x + half} y={y + half} z={1.95} r={half * 1.35} color={color} />
      <Sphere x={x + half + size * 0.28} y={y + half - size * 0.13} z={2.1} r={half * 1.0} color={lighter(color, 0.12)} />
      <Sphere x={x + half - size * 0.25} y={y + half + size * 0.19} z={2.05} r={half * 0.9} color={darker(color, 0.08)} />
      <Sphere x={x + half + size * 0.025} y={y + half + size * 0.25} z={2.3} r={half * 0.8} color={lighter(color, 0.05)} />
      <Sphere x={x + half - size * 0.13} y={y + half - size * 0.19} z={2.35} r={half * 0.7} color={color} />
    </g>
  );
}

// ───── Rug: rounded floor mat with subtle inner highlight ─────
export function Rug({
  x = 0, y = 0, w = 2, d = 2, color = "#d4a373", opacity = 1,
}: {
  x?: number; y?: number; w?: number; d?: number;
  color?: string; opacity?: number;
}) {
  const p = (px: number, py: number) => iso3(x + px, y + py, 0.006);
  return (
    <g>
      <polygon points={pts([p(0, 0), p(w, 0), p(w, d), p(0, d)])} fill={color} opacity={opacity} />
      <polygon
        points={pts([p(0.1, 0.1), p(w - 0.1, 0.1), p(w - 0.1, d - 0.1), p(0.1, d - 0.1)])}
        fill={lighter(color, 0.12)}
        opacity={opacity * 0.6}
      />
    </g>
  );
}

// ───── Clock: pasted onto a wall, with an animated second hand ─────
export function Clock({
  wall = "right", u = 4.0, v = 2.5, size = 1.0,
}: {
  wall?: "left" | "right";
  u?: number; v?: number;
  /** Multiplier for the clock face radius (1 = standard). */
  size?: number;
}) {
  const r = U * 0.5 * size;
  return (
    <WallDecal wall={wall} u={u} v={v}>
      <circle cx={0} cy={0} r={r} fill="#0d0f14" />
      <circle cx={0} cy={0} r={r * 0.92} fill="#fafafa" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
        const ang = (i / 12) * Math.PI * 2 - Math.PI / 2;
        const r1 = r * 0.76;
        const r2 = i % 3 === 0 ? r * 0.6 : r * 0.68;
        return (
          <line
            key={i}
            x1={Math.cos(ang) * r1}
            y1={Math.sin(ang) * r1}
            x2={Math.cos(ang) * r2}
            y2={Math.sin(ang) * r2}
            stroke="#1a1a1e"
            strokeWidth={i % 3 === 0 ? 2 : 1}
          />
        );
      })}
      <line x1={0} y1={0} x2={0} y2={-r * 0.6} stroke="#1a1a1e" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={0} y1={0} x2={r * 0.44} y2={r * 0.16} stroke="#1a1a1e" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={0} y1={0} x2={0} y2={-r * 0.8} stroke="#c96442" strokeWidth={1} strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="60s" repeatCount="indefinite" />
      </line>
      <circle cx={0} cy={0} r={1.8} fill="#c96442" />
    </WallDecal>
  );
}

// Re-export a few primitives so room compositions can grab everything from one
// entry point.
export { FloorLightPool, FloorRect } from "./primitives";
