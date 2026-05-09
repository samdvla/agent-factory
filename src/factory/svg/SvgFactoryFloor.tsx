import { useRef } from "react";
import { ROOMS } from "../state/fixtures";
import { GAP, ROOM_W, ROOM_H, WALL_H, iso } from "./geometry";
import RoomShell from "./RoomShell";
import AvatarLayer from "./AvatarLayer";

function computeViewBox(): string {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  Object.values(ROOMS).forEach((r) => {
    const x0 = r.col * (ROOM_W + GAP);
    const y0 = r.row * (ROOM_H + GAP);
    const x1 = x0 + ROOM_W;
    const y1 = y0 + ROOM_H;
    [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)].forEach((p) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y - WALL_H);
      maxY = Math.max(maxY, p.y);
    });
  });
  const pad = 60;
  return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
}

export default function SvgFactoryFloor() {
  const svgRef = useRef<SVGSVGElement>(null);
  const vb = computeViewBox();

  const ordered = Object.keys(ROOMS).sort((a, b) => {
    const ra = ROOMS[a], rb = ROOMS[b];
    return (ra.row + ra.col) - (rb.row + rb.col);
  });

  return (
    <div
      className="stage"
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}
    >
      <svg
        ref={svgRef}
        id="iso-svg"
        className="stage-svg"
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <defs>
          <radialGradient id="ground-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#5fd4f0" stopOpacity={0.06} />
            <stop offset="100%" stopColor="#5fd4f0" stopOpacity={0} />
          </radialGradient>
        </defs>
        {ordered.map((id) => (
          <RoomShell key={id} roomId={id} />
        ))}
      </svg>
      <AvatarLayer svgRef={svgRef} />
    </div>
  );
}
