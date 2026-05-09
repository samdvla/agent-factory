import { ROOMS, ROLES } from "../state/fixtures";
import { floorPoly, wallNorthPoly, wallEastPoly, getRoomBounds, iso, ROOM_W, WALL_H } from "./geometry";
import { PROPS_BY_KIND } from "./RoomProps";

export default function RoomShell({ roomId }: { roomId: string }) {
  const room = ROOMS[roomId];
  const role = Object.values(ROLES).find((r) => r.room === roomId);
  const accent = role?.hex ?? "#5fd4f0";
  const b = getRoomBounds(roomId);
  const PropsForKind = PROPS_BY_KIND[room.kind];

  const gridLines: React.ReactNode[] = [];
  for (let i = 1; i < ROOM_W; i++) {
    const a = iso(b.x0 + i, b.y0), c = iso(b.x0 + i, b.y1);
    gridLines.push(
      <line key={`v${i}`} x1={a.x} y1={a.y} x2={c.x} y2={c.y}
        stroke="#1f2a37" strokeWidth={0.5} strokeOpacity={0.6} />
    );
    const e = iso(b.x0, b.y0 + i), f = iso(b.x1, b.y0 + i);
    gridLines.push(
      <line key={`h${i}`} x1={e.x} y1={e.y} x2={f.x} y2={f.y}
        stroke="#1f2a37" strokeWidth={0.5} strokeOpacity={0.6} />
    );
  }

  const stripA = iso(b.x0 + 0.05, b.y1 - 0.05);
  const stripB = iso(b.x1 - 0.05, b.y1 - 0.05);
  const labelC = iso((b.x0 + b.x1) / 2, b.y1 - 0.4);

  const glowPad = 0.15;
  const glowPolyPts = floorPoly(b.x0 - glowPad, b.y0 - glowPad, b.x1 + glowPad, b.y1 + glowPad);

  return (
    <g className="iso-room" data-room={roomId} data-name={room.name} data-occupant={room.occupant}>
      <polygon className="room-glow"
        points={glowPolyPts} fill={accent} fillOpacity={0.06} />
      <polygon className="room-floor"
        points={floorPoly(b.x0, b.y0, b.x1, b.y1)}
        fill="#0f1620" stroke="#1a2532" strokeWidth={0.6} />
      <polygon className="room-wall room-wall-n"
        points={wallNorthPoly(b.x0, b.y0, b.x1, b.y1, WALL_H)}
        fill="#0d141c" stroke="#1a2532" strokeWidth={0.5} />
      <polygon className="room-wall room-wall-e"
        points={wallEastPoly(b.x0, b.y0, b.x1, b.y1, WALL_H)}
        fill="#0a1118" stroke="#1a2532" strokeWidth={0.5} />
      {gridLines}
      <line x1={stripA.x} y1={stripA.y} x2={stripB.x} y2={stripB.y}
        stroke={accent} strokeOpacity={0.55} strokeWidth={1.2} />
      <g className="room-props">
        {PropsForKind && <PropsForKind ox={b.x0} oy={b.y0} />}
      </g>
      <text x={labelC.x} y={labelC.y} textAnchor="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={6.5} letterSpacing={1.2}
        fill={accent} fillOpacity={0.7}
        style={{ textTransform: "uppercase" }}>
        {room.name.toUpperCase()}
      </text>
    </g>
  );
}
