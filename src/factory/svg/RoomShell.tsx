import { ROOMS, ROLES } from "../state/fixtures";
import {
  floorPoly,
  wallNorthPoly,
  wallEastPoly,
  getRoomBounds,
  iso,
  ROOM_W,
  WALL_H,
} from "./geometry";
import { PROPS_BY_KIND } from "./RoomProps";
import { useFactoryStore } from "../state/factoryStore";

// Which walls open onto a corridor for each room. The back (north) wall is
// reserved for the room title — never put a door there. South and west walls
// aren't drawn in iso, so they're already open passages where corridors meet
// them. East-wall doors are added wherever a vertical corridor runs along
// the room's east side.
//
// The grid:
//   strategy(0,0)  research(1,0)  design(2,0)
//   listing(0,1)   cs(1,1)        finance(2,1)
//                  silab(1,2)
const ROOM_DOORS: Record<string, { east?: boolean }> = {
  strategy: { east: true },
  research: { east: true },
  design:   {},
  listing:  { east: true },
  cs:       { east: true },
  finance:  {},
  silab:    { east: true },
};

// Door dimensions (in world-grid units / wall-height units)
const DOOR_W = 1.0;     // door is 1 grid unit wide
const DOOR_H = WALL_H * 0.66;

export default function RoomShell({ roomId }: { roomId: string }) {
  const room = ROOMS[roomId];
  const role = Object.values(ROLES).find((r) => r.room === roomId);
  const accent = role?.hex ?? "#5fd4f0";
  const b = getRoomBounds(roomId);
  const PropsForKind = PROPS_BY_KIND[room.kind];
  const doors = ROOM_DOORS[roomId] ?? {};

  const roomState = useFactoryStore((s) => {
    const occupants = Object.values(ROLES).filter((r) => r.room === roomId);
    const states = occupants.map((r) => s.agents[r.id]?.state).filter(Boolean);
    if (states.includes("crashed")) return "crashed";
    if (states.includes("working")) return "working";
    if (states.includes("walking")) return "walking";
    if (states.includes("awaiting")) return "awaiting";
    return "idle";
  });

  // Inner grid lines
  const gridLines: React.ReactNode[] = [];
  for (let i = 1; i < ROOM_W; i++) {
    const a = iso(b.x0 + i, b.y0), c = iso(b.x0 + i, b.y1);
    gridLines.push(
      <line key={`v${i}`} x1={a.x} y1={a.y} x2={c.x} y2={c.y}
        stroke="#1f2a37" strokeWidth={0.5} strokeOpacity={0.6} />,
    );
    const e = iso(b.x0, b.y0 + i), f = iso(b.x1, b.y0 + i);
    gridLines.push(
      <line key={`h${i}`} x1={e.x} y1={e.y} x2={f.x} y2={f.y}
        stroke="#1f2a37" strokeWidth={0.5} strokeOpacity={0.6} />,
    );
  }

  const stripA = iso(b.x0 + 0.05, b.y1 - 0.05);
  const stripB = iso(b.x1 - 0.05, b.y1 - 0.05);

  // Wall-mounted title via shear
  const wallMid = iso((b.x0 + b.x1) / 2, b.y0);
  const titleX = wallMid.x;
  const titleY = wallMid.y - WALL_H * 0.78;
  const subY   = wallMid.y - WALL_H * 0.66;
  const plateLeft  = iso(b.x0 + 0.4, b.y0);
  const plateRight = iso(b.x1 - 0.4, b.y0);

  const glowPad = 0.15;
  const glowPolyPts = floorPoly(b.x0 - glowPad, b.y0 - glowPad, b.x1 + glowPad, b.y1 + glowPad);

  // ----- East wall + optional door -----
  const eastWalls: React.ReactNode[] = [];
  const eastDoorAccents: React.ReactNode[] = [];
  const eastFloorThreshold: React.ReactNode[] = [];
  if (doors.east) {
    const dStart = (b.y0 + b.y1) / 2 - DOOR_W / 2;
    const dEnd = dStart + DOOR_W;
    // Wall pieces
    eastWalls.push(
      <polygon key="e1" className="room-wall room-wall-e"
        points={wallEastPoly(b.x0, b.y0, b.x1, dStart, WALL_H)}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
      <polygon key="e2" className="room-wall room-wall-e"
        points={wallEastPoly(b.x0, dEnd, b.x1, b.y1, WALL_H)}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
    );
    // Lintel above the doorway
    const lA = iso(b.x1, dStart), lB = iso(b.x1, dEnd);
    eastWalls.push(
      <polygon key="el" className="room-wall room-wall-e door-lintel"
        points={`${lA.x},${lA.y - DOOR_H} ${lB.x},${lB.y - DOOR_H} ${lB.x},${lB.y - WALL_H} ${lA.x},${lA.y - WALL_H}`}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
    );
    // Doorway frame highlights — vertical strips on either side of the opening
    eastDoorAccents.push(
      <line key="el-edge1" x1={lA.x} y1={lA.y} x2={lA.x} y2={lA.y - DOOR_H}
        stroke={accent} strokeOpacity={0.8} strokeWidth={0.6} />,
      <line key="el-edge2" x1={lB.x} y1={lB.y} x2={lB.x} y2={lB.y - DOOR_H}
        stroke={accent} strokeOpacity={0.8} strokeWidth={0.6} />,
      // Lintel underline (top of door frame)
      <line key="el-lintel" x1={lA.x} y1={lA.y - DOOR_H} x2={lB.x} y2={lB.y - DOOR_H}
        stroke={accent} strokeOpacity={0.8} strokeWidth={0.6} />,
    );
    // Threshold strip on the floor at the doorway
    const tA = iso(b.x1, dStart), tB = iso(b.x1, dEnd);
    eastFloorThreshold.push(
      <line key="ethr" x1={tA.x} y1={tA.y} x2={tB.x} y2={tB.y}
        stroke={accent} strokeOpacity={0.55} strokeWidth={1.5} />,
    );
  } else {
    eastWalls.push(
      <polygon key="e" className="room-wall room-wall-e"
        points={wallEastPoly(b.x0, b.y0, b.x1, b.y1, WALL_H)}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
    );
  }

  // ----- North wall (always solid — reserved for the room title) -----
  const northWalls: React.ReactNode[] = [
    <polygon key="n" className="room-wall room-wall-n"
      points={wallNorthPoly(b.x0, b.y0, b.x1, b.y0, WALL_H)}
      fill="#0d141c" stroke="#1a2532" strokeWidth={0.5} />,
  ];

  return (
    <g className={`iso-room is-${roomState}`} data-room={roomId} data-name={room.name} data-occupant={room.occupant}>
      <polygon className="room-glow"
        points={glowPolyPts} fill={accent} fillOpacity={0.06} />
      <polygon className="room-floor"
        points={floorPoly(b.x0, b.y0, b.x1, b.y1)}
        fill="#0f1620" stroke="#1a2532" strokeWidth={0.6} />
      {northWalls}
      {eastWalls}
      {gridLines}
      <line x1={stripA.x} y1={stripA.y} x2={stripB.x} y2={stripB.y}
        stroke={accent} strokeOpacity={0.55} strokeWidth={1.2} />
      <g className="room-props">
        {PropsForKind && <PropsForKind ox={b.x0} oy={b.y0} />}
      </g>

      {/* Door frame highlights + floor thresholds drawn ABOVE props/walls */}
      {eastDoorAccents}
      {eastFloorThreshold}

      {/* Wall plate behind the title */}
      <polygon
        points={`${plateLeft.x},${plateLeft.y - WALL_H * 0.85}
                 ${plateRight.x},${plateRight.y - WALL_H * 0.85}
                 ${plateRight.x},${plateRight.y - WALL_H * 0.72}
                 ${plateLeft.x},${plateLeft.y - WALL_H * 0.72}`}
        fill={accent}
        fillOpacity={0.08}
        stroke={accent}
        strokeOpacity={0.35}
        strokeWidth={0.4}
      />
      <text
        x={0} y={0}
        textAnchor="middle"
        dominantBaseline="middle"
        transform={`matrix(1, 0.5, 0, 1, ${titleX}, ${titleY})`}
        fontFamily="JetBrains Mono, monospace"
        fontSize={5.6}
        fontWeight={700}
        letterSpacing={1.6}
        fill={accent}
        fillOpacity={0.95}
      >
        {room.name.toUpperCase()}
      </text>
      <text
        x={0} y={0}
        textAnchor="middle"
        dominantBaseline="middle"
        transform={`matrix(1, 0.5, 0, 1, ${titleX}, ${subY})`}
        fontFamily="JetBrains Mono, monospace"
        fontSize={2.6}
        letterSpacing={0.8}
        fill={accent}
        fillOpacity={0.55}
      >
        {room.occupant.toUpperCase()}
      </text>
    </g>
  );
}
