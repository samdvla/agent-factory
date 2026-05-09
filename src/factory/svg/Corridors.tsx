import { iso } from "./geometry";

type Strip = { x0: number; y0: number; x1: number; y1: number };

// Gaps between rooms (ROOM_W=6, GAP=1, so gaps occur at indices 6..7, 13..14).
// Layout:
//   strategy(0,0)  research(1,0)  design(2,0)
//   listing(0,1)   cs(1,1)        finance(2,1)
//                  silab(1,2)
const CORRIDORS: Strip[] = [
  // Horizontal hallway between row 0 and row 1 — full width
  { x0: 0,  y0: 6,  x1: 20, y1: 7 },
  // Horizontal hallway between row 1 and row 2 — slab under cs↔silab
  { x0: 7,  y0: 13, x1: 13, y1: 14 },
  // Vertical hallway between col 0 and col 1 — runs the full height of the
  // facility so silab has a connected west-side hallway too
  { x0: 6,  y0: 0,  x1: 7,  y1: 20 },
  // Vertical hallway between col 1 and col 2 — same, gives silab an east
  // hallway and a real east-door path back to the rest of the floor
  { x0: 13, y0: 0,  x1: 14, y1: 20 },
];

function floorPoly(x0: number, y0: number, x1: number, y1: number) {
  const a = iso(x0, y0), b = iso(x1, y0), c = iso(x1, y1), d = iso(x0, y1);
  return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`;
}

export default function Corridors() {
  return (
    <g className="corridors">
      {CORRIDORS.map((c, i) => {
        const horizontal = c.x1 - c.x0 >= c.y1 - c.y0;
        // Center stripe along the corridor
        const stripA = horizontal
          ? iso(c.x0 + 0.2, (c.y0 + c.y1) / 2)
          : iso((c.x0 + c.x1) / 2, c.y0 + 0.2);
        const stripB = horizontal
          ? iso(c.x1 - 0.2, (c.y0 + c.y1) / 2)
          : iso((c.x0 + c.x1) / 2, c.y1 - 0.2);
        // A few embedded floor lights along the run
        const lights: { x: number; y: number }[] = [];
        const segments = horizontal ? Math.floor(c.x1 - c.x0) : Math.floor(c.y1 - c.y0);
        for (let s = 1; s < segments; s += 2) {
          if (horizontal) {
            const p = iso(c.x0 + s, (c.y0 + c.y1) / 2);
            lights.push({ x: p.x, y: p.y });
          } else {
            const p = iso((c.x0 + c.x1) / 2, c.y0 + s);
            lights.push({ x: p.x, y: p.y });
          }
        }
        return (
          <g key={i} className="corridor">
            {/* Subtle floor */}
            <polygon
              points={floorPoly(c.x0, c.y0, c.x1, c.y1)}
              fill="#070b11"
              stroke="rgba(95, 212, 240, 0.12)"
              strokeWidth={0.4}
            />
            {/* Center dashed stripe */}
            <line
              x1={stripA.x} y1={stripA.y} x2={stripB.x} y2={stripB.y}
              stroke="rgba(95, 212, 240, 0.45)"
              strokeWidth={0.45}
              strokeDasharray="3,2.4"
              strokeLinecap="round"
            />
            {/* Embedded floor lights */}
            {lights.map((L, li) => (
              <g key={li}>
                <circle cx={L.x} cy={L.y} r={1.6} fill="rgba(95, 212, 240, 0.22)" />
                <circle cx={L.x} cy={L.y} r={0.7} fill="rgba(95, 212, 240, 0.85)" />
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
}
