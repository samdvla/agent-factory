import type { ReactNode } from "react";
import { Box, Platform, FloorLightPool, WallDecal, iso3, U } from "./primitives";
import { getIsoTheme, IsoThemeName } from "./themes";

const fmt = (n: number) => n.toFixed(2);

const ROOM_W_DEFAULT = 6;
const ROOM_D_DEFAULT = 6;
// Walls reduced 30% from the original 4.0 → 2.8 so the rooms read as
// pavilions rather than glass boxes.
const WALL_H = 2.8;           // total wall height in world Z
const WALL_SOLID = 1.4;       // solid lower section (half of total)
const WALL_T = 0.14;
const PLATFORM_PAD = 0.42;
const PLATFORM_THICK = 0.32;

/**
 * Drop-in replacement for the visual contents of a room — raised platform
 * with cream floor, solid lower / glass upper walls, neon trim along the
 * top edge and inside-base, signage plaque on the back-left wall, and an
 * ambient warm-light wash on the floor.
 *
 * Does **not** wrap itself in `<g>` so it can sit inside the existing
 * RoomShell wrapper (which carries the room's class names + transform).
 */
export default function RoomShellIso({
  b,
  accent,
  name,
  subtitle,
  showFurniture = true,
  children,
  width = ROOM_W_DEFAULT,
  depth = ROOM_D_DEFAULT,
  theme: themeName,
}: {
  /** Room bounds in world coords (room-local origin: b.x0 == 0 when the
   *  parent translates by the room's world position). For SvgFactoryFloor
   *  the bounds are already in world space; we just consume them. */
  b: { x0: number; y0: number; x1: number; y1: number };
  accent: string;
  name: string;
  subtitle?: string;
  showFurniture?: boolean;
  /** Furniture rendered inside the room (in absolute world coords). */
  children?: ReactNode;
  width?: number;
  depth?: number;
  /** Iso theme controlling floor/wall/glass palette. */
  theme?: IsoThemeName;
}) {
  const THEME = getIsoTheme(themeName);
  // We do everything in room-local coords (0..width, 0..depth) and translate
  // the whole group by (b.x0, b.y0). This means the iso3 helpers can use
  // local positions and the existing iso() avatar pipeline still aligns.
  const ROOM_W = width;
  const ROOM_D = depth;

  // Light pool centered on the floor
  const ambientCx = ROOM_W * 0.55;
  const ambientCy = ROOM_D * 0.55;

  // Signage plaque: written onto the back-left glass panel.  Sized so the
  // text reads cleanly without dominating the room.
  const labelTxt = name.toUpperCase();
  const labelW = Math.max(labelTxt.length * U * 0.26 + U * 0.4, U * 1.6);
  const subTxt = subtitle ? subtitle.toUpperCase() : "";

  return (
    <g
      className="iso-shell"
      style={{ ["--accent" as string]: accent }}
      transform={`translate(${fmt(iso3(b.x0, b.y0, 0).x)}, ${fmt(iso3(b.x0, b.y0, 0).y)})`}
    >
      {/* Raised platform under the room */}
      <Platform
        x={-PLATFORM_PAD}
        y={-PLATFORM_PAD}
        w={ROOM_W + PLATFORM_PAD * 2}
        d={ROOM_D + PLATFORM_PAD * 2}
        thickness={PLATFORM_THICK}
        color={THEME.platform}
      />

      {/* Floor */}
      {(() => {
        const a = iso3(0, 0, 0);
        const b1 = iso3(ROOM_W, 0, 0);
        const c1 = iso3(ROOM_W, ROOM_D, 0);
        const d1 = iso3(0, ROOM_D, 0);
        return (
          <polygon
            points={`${fmt(a.x)},${fmt(a.y)} ${fmt(b1.x)},${fmt(b1.y)} ${fmt(c1.x)},${fmt(c1.y)} ${fmt(d1.x)},${fmt(d1.y)}`}
            fill={THEME.floor}
          />
        );
      })()}

      {/* Subtle floor hatch — quiet horizontal lines */}
      {(() => {
        const lines: ReactNode[] = [];
        for (let i = 0.6; i < ROOM_D; i += 0.6) {
          const a = iso3(0, i, 0.001);
          const b1 = iso3(ROOM_W, i, 0.001);
          lines.push(
            <line key={`wp${i}`} x1={a.x} y1={a.y} x2={b1.x} y2={b1.y} stroke={THEME.floorTile} strokeWidth={0.5} />,
          );
        }
        return lines;
      })()}

      {/* Ambient warm wash near the center of the floor */}
      <FloorLightPool x={ambientCx} y={ambientCy} rx={ROOM_W * 0.45} ry={ROOM_D * 0.27} color={THEME.ambient} opacity={0.55} />

      {/* Solid lower walls (back-left + back-right) */}
      <Box x={0} y={-WALL_T} w={ROOM_W} d={WALL_T} h={WALL_SOLID} color={THEME.wallBack} />
      <Box x={-WALL_T} y={0} w={WALL_T} d={ROOM_D} h={WALL_SOLID} color={THEME.wallSide} />

      {/* Mullion seam at solid/glass boundary */}
      <Box x={-WALL_T} y={-WALL_T} z={WALL_SOLID} w={ROOM_W + WALL_T} d={WALL_T} h={0.06} color={THEME.wallTrim} />
      <Box x={-WALL_T} y={-WALL_T} z={WALL_SOLID} w={WALL_T} d={ROOM_D + WALL_T} h={0.06} color={THEME.wallTrim} />

      {/* Glass upper sections — translucent panels with vertical mullions on each wall */}
      <WallDecal wall="left" u={0} v={WALL_SOLID}>
        <rect x={0} y={0} width={ROOM_W * U} height={-(WALL_H - WALL_SOLID) * U} fill={THEME.glassFill} />
        {[ROOM_W * 0.25, ROOM_W * 0.5, ROOM_W * 0.75].map((p, i) => (
          <line
            key={i}
            x1={p * U}
            y1={-0.05 * U}
            x2={p * U}
            y2={-(WALL_H - WALL_SOLID) * U + 0.05 * U}
            stroke={THEME.wallTrim}
            strokeWidth={1.2}
            opacity={0.85}
          />
        ))}
        <polygon
          points={`0,0 ${ROOM_W * U * 0.45},0 ${ROOM_W * U * 0.6},${-(WALL_H - WALL_SOLID) * U} 0,${-(WALL_H - WALL_SOLID) * U}`}
          fill="rgba(255,255,255,0.06)"
        />
      </WallDecal>
      <WallDecal wall="right" u={0} v={WALL_SOLID}>
        <rect x={0} y={0} width={-ROOM_D * U} height={-(WALL_H - WALL_SOLID) * U} fill={THEME.glassFill} />
        {[ROOM_D * 0.25, ROOM_D * 0.5, ROOM_D * 0.75].map((p, i) => (
          <line
            key={i}
            x1={-p * U}
            y1={-0.05 * U}
            x2={-p * U}
            y2={-(WALL_H - WALL_SOLID) * U + 0.05 * U}
            stroke={THEME.wallTrim}
            strokeWidth={1.2}
            opacity={0.85}
          />
        ))}
        <polygon
          points={`0,0 ${-ROOM_D * U * 0.45},0 ${-ROOM_D * U * 0.6},${-(WALL_H - WALL_SOLID) * U} 0,${-(WALL_H - WALL_SOLID) * U}`}
          fill="rgba(255,255,255,0.06)"
        />
      </WallDecal>

      {/* Faint horizontal panel seam on the solid lower wall */}
      <WallDecal wall="left" u={0} v={0}>
        <line x1={0} y1={-WALL_SOLID * U + 4} x2={ROOM_W * U} y2={-WALL_SOLID * U + 4} stroke={THEME.wallTrim} strokeWidth={0.6} opacity={0.4} />
      </WallDecal>
      <WallDecal wall="right" u={0} v={0}>
        <line x1={0} y1={-WALL_SOLID * U + 4} x2={-ROOM_D * U} y2={-WALL_SOLID * U + 4} stroke={THEME.wallTrim} strokeWidth={0.6} opacity={0.4} />
      </WallDecal>

      {/* Bottom wall gradient for subtle depth */}
      <WallDecal wall="left" u={0} v={0}>
        <rect x={0} y={0} width={ROOM_W * U} height={-1.4 * U} fill="url(#iso-wall-grad-bottom)" opacity={0.5} />
      </WallDecal>
      <WallDecal wall="right" u={0} v={0}>
        <rect x={0} y={0} width={-ROOM_D * U} height={-1.4 * U} fill="url(#iso-wall-grad-bottom)" opacity={0.5} />
      </WallDecal>

      {/* Top parapet frame */}
      <Box x={-WALL_T} y={-WALL_T} z={WALL_H} w={ROOM_W + WALL_T} d={WALL_T} h={0.08} color={THEME.parapet} />
      <Box x={-WALL_T} y={-WALL_T} z={WALL_H} w={WALL_T} d={ROOM_D + WALL_T} h={0.08} color={THEME.parapet} />

      {/* Neon glow strip just under the top frame (accent color) */}
      <Box x={0} y={-WALL_T * 0.6} z={WALL_H - 0.06} w={ROOM_W} d={0.02} h={0.04} color={accent} />
      <Box x={-WALL_T * 0.6} y={0} z={WALL_H - 0.06} w={0.02} d={ROOM_D} h={0.04} color={accent} />

      {/* Inside-base skirting + accent stripe */}
      <Box x={0} y={0} w={ROOM_W} d={0.06} h={0.22} color={THEME.skirting} />
      <Box x={0} y={0} w={0.06} d={ROOM_D} h={0.22} color={THEME.skirting} />
      <Box x={0} y={0.06} w={ROOM_W} d={0.025} h={0.06} color={accent} />
      <Box x={0.06} y={0} w={0.025} d={ROOM_D} h={0.06} color={accent} />

      {/* Corner uplight — vertical neon stripe at inside corner */}
      <Box x={0} y={0} z={0.22} w={0.04} d={0.04} h={WALL_H * 0.6 - 0.22} color={accent} />

      {/* Sliding-door track strip on the front-right edge (purely visual) */}
      {(() => {
        const dx = ROOM_W * 0.45;
        const dw = 1.0;
        const a = iso3(dx, ROOM_D + 0.02, 0.005);
        const b1 = iso3(dx + dw, ROOM_D + 0.02, 0.005);
        return <line x1={a.x} y1={a.y} x2={b1.x} y2={b1.y} stroke={accent} strokeWidth={1.4} opacity={0.6} />;
      })()}

      {/* Furniture group — only when we're rendering at full detail. */}
      {showFurniture && <g className="iso-room-furniture">{children}</g>}

      {/* Signage plaque on the back-left glass panel */}
      <WallDecal wall="left" u={ROOM_W * 0.06} v={WALL_H * 0.82}>
        <rect
          x={-U * 0.2}
          y={-U * 0.5}
          width={labelW + U * 0.3}
          height={U * 0.8}
          fill={THEME.isDark ? "rgba(10,12,18,0.65)" : "rgba(255,255,255,0.65)"}
          stroke={accent}
          strokeWidth={1}
          opacity={THEME.isDark ? 0.9 : 0.8}
          rx={2.5}
        />
        <circle cx={-U * 0.08} cy={-U * 0.38} r={1.1} fill={accent} opacity={0.6} />
        <circle cx={labelW + U * 0.04} cy={-U * 0.38} r={1.1} fill={accent} opacity={0.6} />
        <circle cx={-U * 0.08} cy={U * 0.22} r={1.1} fill={accent} opacity={0.6} />
        <circle cx={labelW + U * 0.04} cy={U * 0.22} r={1.1} fill={accent} opacity={0.6} />
        <rect x={-U * 0.12} y={-U * 0.42} width={U * 0.04} height={U * 0.66} fill={accent}>
          <animate attributeName="opacity" values="0.55;1;0.55" dur="2.6s" repeatCount="indefinite" />
        </rect>
        <text
          x={0}
          y={-U * 0.06}
          fill={accent}
          fontFamily="ui-monospace, Menlo, 'Inconsolata', monospace"
          fontSize={U * 0.3}
          fontWeight={700}
          letterSpacing={2}
        >
          {labelTxt}
        </text>
        {subTxt && (
          <text
            x={0}
            y={U * 0.18}
            fill={accent}
            opacity={0.7}
            fontFamily="ui-monospace, Menlo, monospace"
            fontSize={U * 0.13}
            fontWeight={500}
            letterSpacing={1.5}
          >
            {subTxt}
          </text>
        )}
      </WallDecal>
    </g>
  );
}
