import { useMemo } from "react";
import type { ReactNode } from "react";
import { useFactoryStore } from "../state/factoryStore";
import { Room } from "../state/types";
import { ROOM_W, ROOM_H, GAP } from "./geometry";
import { Strip } from "./layout";
import { Box, FloorLightPool, iso3, mix } from "./iso/primitives";
import { getIsoTheme, IsoTheme } from "./iso/themes";

// The corridor network is derived directly from the room grid:
//
//   buildSegments(rooms)  → straight hallway slabs between every 4-adjacent pair
//   buildJunctions(rooms) → square corner pads wherever ≥3 of 4 surrounding cells
//                           are rooms, so L / T / + junctions read as a single
//                           continuous walkway.
//
// Both functions are exported so future features (traffic overlays, hallway
// labels, decorative props, alternate themes) can iterate the same data
// without re-deriving topology. Adding a new room that's adjacent to an
// existing one automatically grows the network — no extra wiring needed.

export type CorridorSegmentData = {
  key: string;
  axis: "ew" | "ns";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  accentA: string;
  accentB: string;
};

export type CorridorJunctionData = {
  key: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  accent: string;
};

const DEFAULT_ACCENT = "#5fd4f0";

function roomAccent(r: Room | undefined): string {
  return r?.kit?.accent ?? DEFAULT_ACCENT;
}

export function buildSegments(rooms: Room[]): CorridorSegmentData[] {
  if (rooms.length < 2) return [];
  const byCell = new Map<string, Room>();
  for (const r of rooms) byCell.set(`${r.col},${r.row}`, r);
  const Sx = ROOM_W + GAP;
  const Sy = ROOM_H + GAP;
  const out: CorridorSegmentData[] = [];
  for (const r of rooms) {
    const east = byCell.get(`${r.col + 1},${r.row}`);
    if (east) {
      const x0 = r.col * Sx + ROOM_W;
      const y0 = r.row * Sy;
      out.push({
        key: `e:${r.id}->${east.id}`,
        axis: "ew",
        x0, y0,
        x1: x0 + GAP,
        y1: y0 + ROOM_H,
        accentA: roomAccent(r),
        accentB: roomAccent(east),
      });
    }
    const south = byCell.get(`${r.col},${r.row + 1}`);
    if (south) {
      const x0 = r.col * Sx;
      const y0 = r.row * Sy + ROOM_H;
      out.push({
        key: `s:${r.id}->${south.id}`,
        axis: "ns",
        x0, y0,
        x1: x0 + ROOM_W,
        y1: y0 + GAP,
        accentA: roomAccent(r),
        accentB: roomAccent(south),
      });
    }
  }
  return out;
}

function blendAccents(accents: string[]): string {
  if (!accents.length) return DEFAULT_ACCENT;
  return accents.reduce((acc, cur) => mix(acc, cur, 0.5));
}

export function buildJunctions(rooms: Room[]): CorridorJunctionData[] {
  if (rooms.length < 3) return [];
  const byCell = new Map<string, Room>();
  for (const r of rooms) byCell.set(`${r.col},${r.row}`, r);
  const Sx = ROOM_W + GAP;
  const Sy = ROOM_H + GAP;

  // Each junction cell is the corner gap NW-anchored at integer cell (c, r) —
  // i.e., the GAP×GAP square between cols c/c+1 and rows r/r+1. We only need
  // to consider anchors reachable from some room.
  const anchors = new Set<string>();
  for (const r of rooms) {
    for (const dc of [-1, 0]) {
      for (const dr of [-1, 0]) {
        const c = r.col + dc;
        const rr = r.row + dr;
        if (c < 0 || rr < 0) continue;
        anchors.add(`${c},${rr}`);
      }
    }
  }

  const out: CorridorJunctionData[] = [];
  for (const key of anchors) {
    const [c, r] = key.split(",").map(Number);
    const surrounding = [
      byCell.get(`${c},${r}`),
      byCell.get(`${c + 1},${r}`),
      byCell.get(`${c},${r + 1}`),
      byCell.get(`${c + 1},${r + 1}`),
    ];
    const present = surrounding.filter(Boolean) as Room[];
    // ≥3 means at least two perpendicular hallways meet at this corner.
    if (present.length < 3) continue;
    out.push({
      key: `j:${c},${r}`,
      x0: c * Sx + ROOM_W,
      y0: r * Sy + ROOM_H,
      x1: c * Sx + ROOM_W + GAP,
      y1: r * Sy + ROOM_H + GAP,
      accent: blendAccents(present.map(roomAccent)),
    });
  }
  return out;
}

function networkKey(rooms: Room[]): string {
  return rooms
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}@${r.col},${r.row}:${r.kit?.accent ?? ""}`)
    .join("|");
}

// Geometry tunables. Slab is intentionally thinner than the room platform
// (0.32) so a room's platform overhang naturally hides the corridor at the
// dock — no z-fighting needed, painter's order does the rest.
const SLAB_H = 0.14;
const RAIL_INSET = 0.20;
const RAIL_WIDTH = 0.045;
const RAIL_HEIGHT = 0.06;
// Whole-network opacity: keeps the corridors as connective tissue without
// competing with the room pavilions.
const CORRIDOR_OPACITY = 0.72;

function CorridorSegment({ seg, theme }: { seg: CorridorSegmentData; theme: IsoTheme }) {
  const { x0, y0, x1, y1, axis, accentA, accentB } = seg;
  const w = x1 - x0;
  const d = y1 - y0;
  const longLen = axis === "ew" ? w : d;
  const shortLen = axis === "ew" ? d : w;

  const slab = (
    <Box
      x={x0}
      y={y0}
      w={w}
      d={d}
      h={SLAB_H}
      color={theme.platform}
      colors={{ top: theme.floor }}
    />
  );

  // Hatched ticks across the path, same cadence as room floor lines.
  const hatch: ReactNode[] = [];
  const stride = 0.55;
  if (axis === "ew") {
    for (let i = stride; i < w; i += stride) {
      const a = iso3(x0 + i, y0 + 0.18, SLAB_H + 0.002);
      const b = iso3(x0 + i, y1 - 0.18, SLAB_H + 0.002);
      hatch.push(
        <line key={`h${i.toFixed(2)}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={theme.floorTile} strokeWidth={0.5} />,
      );
    }
  } else {
    for (let i = stride; i < d; i += stride) {
      const a = iso3(x0 + 0.18, y0 + i, SLAB_H + 0.002);
      const b = iso3(x1 - 0.18, y0 + i, SLAB_H + 0.002);
      hatch.push(
        <line key={`h${i.toFixed(2)}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={theme.floorTile} strokeWidth={0.5} />,
      );
    }
  }

  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  // Top-edge finish line: thin trim along the slab perimeter so the path
  // reads as a deliberately edged surface rather than a floating slab.
  const trimPts = (() => {
    const z = SLAB_H + 0.0015;
    const a = iso3(x0, y0, z);
    const b = iso3(x1, y0, z);
    const c = iso3(x1, y1, z);
    const dd = iso3(x0, y1, z);
    return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${dd.x},${dd.y}`;
  })();

  const centerLine = (() => {
    if (axis === "ew") {
      const a = iso3(x0 + 0.1, cy, SLAB_H + 0.004);
      const b = iso3(x1 - 0.1, cy, SLAB_H + 0.004);
      return (
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={theme.wallTrim} strokeOpacity={0.55}
              strokeWidth={0.9} strokeDasharray="4 3.5" strokeLinecap="round" />
      );
    }
    const a = iso3(cx, y0 + 0.1, SLAB_H + 0.004);
    const b = iso3(cx, y1 - 0.1, SLAB_H + 0.004);
    return (
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={theme.wallTrim} strokeOpacity={0.55}
            strokeWidth={0.9} strokeDasharray="4 3.5" strokeLinecap="round" />
    );
  })();

  // Rails split at the midpoint so each half carries its room's accent —
  // a subtle handshake that reads as "this connects A to B".
  const rails: ReactNode[] = [];
  const railFaces = (c: string) => ({ top: c, right: c, left: c });
  if (axis === "ew") {
    const half = w / 2;
    const yTop = y0 + RAIL_INSET;
    const yBot = y1 - RAIL_INSET - RAIL_WIDTH;
    rails.push(
      <Box key="rt-a" x={x0} y={yTop} w={half} d={RAIL_WIDTH} h={RAIL_HEIGHT} color={accentA} colors={railFaces(accentA)} />,
      <Box key="rt-b" x={x0 + half} y={yTop} w={half} d={RAIL_WIDTH} h={RAIL_HEIGHT} color={accentB} colors={railFaces(accentB)} />,
      <Box key="rb-a" x={x0} y={yBot} w={half} d={RAIL_WIDTH} h={RAIL_HEIGHT} color={accentA} colors={railFaces(accentA)} />,
      <Box key="rb-b" x={x0 + half} y={yBot} w={half} d={RAIL_WIDTH} h={RAIL_HEIGHT} color={accentB} colors={railFaces(accentB)} />,
    );
  } else {
    const half = d / 2;
    const xLeft = x0 + RAIL_INSET;
    const xRight = x1 - RAIL_INSET - RAIL_WIDTH;
    rails.push(
      <Box key="rl-a" x={xLeft} y={y0} w={RAIL_WIDTH} d={half} h={RAIL_HEIGHT} color={accentA} colors={railFaces(accentA)} />,
      <Box key="rl-b" x={xLeft} y={y0 + half} w={RAIL_WIDTH} d={half} h={RAIL_HEIGHT} color={accentB} colors={railFaces(accentB)} />,
      <Box key="rr-a" x={xRight} y={y0} w={RAIL_WIDTH} d={half} h={RAIL_HEIGHT} color={accentA} colors={railFaces(accentA)} />,
      <Box key="rr-b" x={xRight} y={y0 + half} w={RAIL_WIDTH} d={half} h={RAIL_HEIGHT} color={accentB} colors={railFaces(accentB)} />,
    );
  }

  return (
    <g className="iso-corridor">
      {slab}
      <polygon points={trimPts} fill="none" stroke={theme.wallTrim}
               strokeWidth={0.6} strokeOpacity={0.45} />
      {hatch}
      <FloorLightPool
        x={cx} y={cy}
        rx={longLen * 0.48}
        ry={shortLen * 0.34}
        color={theme.ambient}
        opacity={0.55}
      />
      <FloorLightPool
        x={axis === "ew" ? x0 + 0.1 : cx}
        y={axis === "ew" ? cy : y0 + 0.1}
        rx={shortLen * 0.46}
        ry={shortLen * 0.26}
        color={accentA}
        opacity={theme.isDark ? 0.24 : 0.16}
      />
      <FloorLightPool
        x={axis === "ew" ? x1 - 0.1 : cx}
        y={axis === "ew" ? cy : y1 - 0.1}
        rx={shortLen * 0.46}
        ry={shortLen * 0.26}
        color={accentB}
        opacity={theme.isDark ? 0.24 : 0.16}
      />
      {centerLine}
      <g filter="url(#iso-soft-blur)" opacity={0.85}>{rails}</g>
      {rails}
    </g>
  );
}

function CorridorJunction({ j, theme }: { j: CorridorJunctionData; theme: IsoTheme }) {
  const { x0, y0, x1, y1, accent } = j;
  const w = x1 - x0;
  const d = y1 - y0;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const trimPts = (() => {
    const z = SLAB_H + 0.0015;
    const a = iso3(x0, y0, z);
    const b = iso3(x1, y0, z);
    const c = iso3(x1, y1, z);
    const dd = iso3(x0, y1, z);
    return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${dd.x},${dd.y}`;
  })();

  // A tiny accent disc at the center marks the junction without ever
  // visually competing with avatars walking through.
  const center = iso3(cx, cy, SLAB_H + 0.006);

  return (
    <g className="iso-corridor-junction">
      <Box x={x0} y={y0} w={w} d={d} h={SLAB_H}
           color={theme.platform} colors={{ top: theme.floor }} />
      <polygon points={trimPts} fill="none" stroke={theme.wallTrim}
               strokeWidth={0.6} strokeOpacity={0.45} />
      <FloorLightPool x={cx} y={cy}
                      rx={w * 0.46} ry={d * 0.3}
                      color={theme.ambient} opacity={0.5} />
      <circle cx={center.x} cy={center.y} r={1.8}
              fill={accent} opacity={0.55}
              filter="url(#iso-soft-blur)" />
      <circle cx={center.x} cy={center.y} r={0.9}
              fill={accent} opacity={0.9} />
    </g>
  );
}

export default function Corridors({ strips: _strips }: { strips: Strip[] }) {
  const rooms = useFactoryStore((s) => s.rooms);
  const themeName = useFactoryStore((s) => s.isoTheme);
  const theme = getIsoTheme(themeName);

  const network = useMemo(() => {
    const list = Object.values(rooms);
    return {
      segments: buildSegments(list),
      junctions: buildJunctions(list),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkKey(Object.values(rooms))]);

  if (!network.segments.length && !network.junctions.length) return null;

  return (
    <g
      className={`iso-corridors iso-theme-${theme.name}`}
      opacity={CORRIDOR_OPACITY}
    >
      {network.segments.map((seg) => (
        <CorridorSegment key={seg.key} seg={seg} theme={theme} />
      ))}
      {network.junctions.map((j) => (
        <CorridorJunction key={j.key} j={j} theme={theme} />
      ))}
    </g>
  );
}
