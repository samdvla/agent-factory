import { useFactoryStore } from "../state/factoryStore";
import { computeCorridors } from "./layout";
import { iso } from "./geometry";

function floorPoly(x0: number, y0: number, x1: number, y1: number) {
  const a = iso(x0, y0), b = iso(x1, y0), c = iso(x1, y1), d = iso(x0, y1);
  return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`;
}

export default function Corridors() {
  const rooms = useFactoryStore((s) => s.rooms);
  const strips = computeCorridors(Object.values(rooms));

  return (
    <g className="corridors">
      {strips.map((c, i) => {
        const horizontal = c.x1 - c.x0 >= c.y1 - c.y0;
        const stripA = horizontal
          ? iso(c.x0 + 0.2, (c.y0 + c.y1) / 2)
          : iso((c.x0 + c.x1) / 2, c.y0 + 0.2);
        const stripB = horizontal
          ? iso(c.x1 - 0.2, (c.y0 + c.y1) / 2)
          : iso((c.x0 + c.x1) / 2, c.y1 - 0.2);
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
            <polygon points={floorPoly(c.x0, c.y0, c.x1, c.y1)}
              fill="#070b11" stroke="rgba(95, 212, 240, 0.12)" strokeWidth={0.4} />
            <line x1={stripA.x} y1={stripA.y} x2={stripB.x} y2={stripB.y}
              stroke="rgba(95, 212, 240, 0.45)" strokeWidth={0.45}
              strokeDasharray="3,2.4" strokeLinecap="round" />
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
