import { useFactoryStore } from "../state/factoryStore";
import {
  floorPoly, wallNorthPoly, wallEastPoly, getRoomBounds, iso, ROOM_W, WALL_H,
} from "./geometry";
import { DoorSet } from "./layout";
import { composeRoom } from "./kit/composer";

const DOOR_W = 1.0;
const DOOR_H = WALL_H * 0.66;

export default function RoomShell({ roomId, doors: doorsProp }: { roomId: string; doors?: DoorSet }) {
  const room = useFactoryStore((s) => s.rooms[roomId]);
  const roomState = useFactoryStore((s) => {
    const r = s.rooms[roomId];
    if (!r) return "idle";
    const occupants = (r.occupants ?? []).map((id) => s.agents[id]?.state).filter(Boolean);
    if (occupants.includes("crashed")) return "crashed";
    if (occupants.includes("working")) return "working";
    if (occupants.includes("walking")) return "walking";
    if (occupants.includes("awaiting")) return "awaiting";
    return "idle";
  });
  if (!room) return null;
  const accent = room.kit?.accent ?? "#5fd4f0";
  const b = getRoomBounds(roomId);
  if (!b) return null;
  const doors = doorsProp ?? { north: false, east: false, south: false, west: false };

  const gridLines: React.ReactNode[] = [];
  for (let i = 1; i < ROOM_W; i++) {
    const a = iso(b.x0 + i, b.y0), c = iso(b.x0 + i, b.y1);
    gridLines.push(<line key={`v${i}`} x1={a.x} y1={a.y} x2={c.x} y2={c.y}
      stroke="#1f2a37" strokeWidth={0.5} strokeOpacity={0.6} />);
    const e = iso(b.x0, b.y0 + i), f = iso(b.x1, b.y0 + i);
    gridLines.push(<line key={`h${i}`} x1={e.x} y1={e.y} x2={f.x} y2={f.y}
      stroke="#1f2a37" strokeWidth={0.5} strokeOpacity={0.6} />);
  }

  const stripA = iso(b.x0 + 0.05, b.y1 - 0.05);
  const stripB = iso(b.x1 - 0.05, b.y1 - 0.05);
  const wallMid = iso((b.x0 + b.x1) / 2, b.y0);
  const titleX = wallMid.x;
  const titleY = wallMid.y - WALL_H * 0.78;
  const subY = wallMid.y - WALL_H * 0.66;
  const plateLeft = iso(b.x0 + 0.4, b.y0);
  const plateRight = iso(b.x1 - 0.4, b.y0);
  const glowPad = 0.15;
  const glowPolyPts = floorPoly(b.x0 - glowPad, b.y0 - glowPad, b.x1 + glowPad, b.y1 + glowPad);

  const eastWalls: React.ReactNode[] = [];
  const eastDoorAccents: React.ReactNode[] = [];
  const eastFloorThreshold: React.ReactNode[] = [];
  if (doors.east) {
    const dStart = (b.y0 + b.y1) / 2 - DOOR_W / 2;
    const dEnd = dStart + DOOR_W;
    eastWalls.push(
      <polygon key="e1" className="room-wall room-wall-e"
        points={wallEastPoly(b.x0, b.y0, b.x1, dStart, WALL_H)}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
      <polygon key="e2" className="room-wall room-wall-e"
        points={wallEastPoly(b.x0, dEnd, b.x1, b.y1, WALL_H)}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
    );
    const lA = iso(b.x1, dStart), lB = iso(b.x1, dEnd);
    eastWalls.push(
      <polygon key="el" className="room-wall room-wall-e door-lintel"
        points={`${lA.x},${lA.y - DOOR_H} ${lB.x},${lB.y - DOOR_H} ${lB.x},${lB.y - WALL_H} ${lA.x},${lA.y - WALL_H}`}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
    );
    eastDoorAccents.push(
      <line key="el-edge1" x1={lA.x} y1={lA.y} x2={lA.x} y2={lA.y - DOOR_H} stroke={accent} strokeOpacity={0.8} strokeWidth={0.6} />,
      <line key="el-edge2" x1={lB.x} y1={lB.y} x2={lB.x} y2={lB.y - DOOR_H} stroke={accent} strokeOpacity={0.8} strokeWidth={0.6} />,
      <line key="el-lintel" x1={lA.x} y1={lA.y - DOOR_H} x2={lB.x} y2={lB.y - DOOR_H} stroke={accent} strokeOpacity={0.8} strokeWidth={0.6} />,
    );
    const tA = iso(b.x1, dStart), tB = iso(b.x1, dEnd);
    eastFloorThreshold.push(
      <line key="ethr" x1={tA.x} y1={tA.y} x2={tB.x} y2={tB.y} stroke={accent} strokeOpacity={0.55} strokeWidth={1.5} />,
    );
  } else {
    eastWalls.push(
      <polygon key="e" className="room-wall room-wall-e"
        points={wallEastPoly(b.x0, b.y0, b.x1, b.y1, WALL_H)}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />,
    );
  }

  const northWalls: React.ReactNode[] = [
    <polygon key="n" className="room-wall room-wall-n"
      points={wallNorthPoly(b.x0, b.y0, b.x1, b.y0, WALL_H)}
      fill="#0d141c" stroke="#1a2532" strokeWidth={0.5} />,
  ];

  const opacity = room.dissolving ? 0 : 1;
  return (
    <g className={`iso-room is-${roomState}${room.dissolving ? " is-dissolving" : ""}`}
       data-room={roomId} data-name={room.name} data-occupant={room.occupant}
       style={{ opacity, transition: "opacity 800ms ease-out" }}>
      <polygon className="room-glow" points={glowPolyPts} fill={accent} fillOpacity={0.06} />
      <polygon className="room-floor"
        points={floorPoly(b.x0, b.y0, b.x1, b.y1)}
        fill="#0f1620" stroke="#1a2532" strokeWidth={0.6} />
      {northWalls}
      {eastWalls}
      {gridLines}
      <line x1={stripA.x} y1={stripA.y} x2={stripB.x} y2={stripB.y}
        stroke={accent} strokeOpacity={0.55} strokeWidth={1.2} />
      <g className="room-props">
        {room.kit && composeRoom(room.kit, b.x0, b.y0)}
      </g>
      {eastDoorAccents}
      {eastFloorThreshold}
      <polygon
        points={`${plateLeft.x},${plateLeft.y - WALL_H * 0.85}
                 ${plateRight.x},${plateRight.y - WALL_H * 0.85}
                 ${plateRight.x},${plateRight.y - WALL_H * 0.72}
                 ${plateLeft.x},${plateLeft.y - WALL_H * 0.72}`}
        fill={accent} fillOpacity={0.08}
        stroke={accent} strokeOpacity={0.35} strokeWidth={0.4} />
      <text transform={`matrix(1, 0.5, 0, 1, ${titleX}, ${titleY})`}
        textAnchor="middle" dominantBaseline="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={5.6} fontWeight={700} letterSpacing={1.6}
        fill={accent} fillOpacity={0.95}>
        {room.name.toUpperCase()}
      </text>
      <text transform={`matrix(1, 0.5, 0, 1, ${titleX}, ${subY})`}
        textAnchor="middle" dominantBaseline="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={2.6} letterSpacing={0.8}
        fill={accent} fillOpacity={0.55}>
        {room.occupant.toUpperCase()}
      </text>
    </g>
  );
}
