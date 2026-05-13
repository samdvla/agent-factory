import type { ReactNode } from "react";
import { TW } from "../geometry";

// Iso "up" component — Z=1 world unit maps to (TW/2) screen-pixels up, which
// matches the handoff's `project(x,y,z,U)` shape with U = TW/2. World X/Y stay
// in the same units as the rest of the SVG floor (1 unit = TW/2 px horizontal).
export const U = TW / 2;

export function iso3(x: number, y: number, z = 0) {
  return { x: (x - y) * U, y: (x + y) * (U / 2) - z * U };
}

export function mix(a: string, b: string, amount: number): string {
  const parse = (h: string) => {
    const s = h.startsWith("#") ? h.slice(1) : h;
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const r = Math.round(ar + (br - ar) * amount);
  const g = Math.round(ag + (bg - ag) * amount);
  const bl = Math.round(ab + (bb - ab) * amount);
  return "#" + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
}

export const lighter = (c: string, a: number) => mix(c, "#ffffff", a);
export const darker = (c: string, a: number) => mix(c, "#000000", a);

export function shade(color: string, face: "top" | "right" | "left" | "front" | "back" | "bottom"): string {
  switch (face) {
    case "top": return mix(color, "#ffffff", 0.18);
    case "right": return mix(color, "#000000", 0.08);
    case "left": return mix(color, "#000000", 0.22);
    case "front": return mix(color, "#000000", 0.04);
    case "back": return mix(color, "#000000", 0.28);
    case "bottom": return mix(color, "#000000", 0.35);
  }
}

const fmt = (n: number) => n.toFixed(2);
export const pts = (arr: Array<{ x: number; y: number }>) =>
  arr.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");

// ───── Box: three visible faces of an axis-aligned cuboid (TOP/RIGHT/LEFT). ─────
export function Box({
  x = 0, y = 0, z = 0, w = 1, d = 1, h = 1, color = "#cccccc",
  colors,
}: {
  x?: number; y?: number; z?: number;
  w?: number; d?: number; h?: number;
  color?: string;
  colors?: { top?: string; left?: string; right?: string };
}) {
  const p = (px: number, py: number, pz: number) => iso3(x + px, y + py, z + pz);
  const t = {
    nw: p(0, 0, h), ne: p(w, 0, h),
    se: p(w, d, h), sw: p(0, d, h),
  };
  const b = {
    nw: p(0, 0, 0), ne: p(w, 0, 0),
    se: p(w, d, 0), sw: p(0, d, 0),
  };
  const cTop = colors?.top ?? shade(color, "top");
  const cRight = colors?.right ?? shade(color, "right");
  const cLeft = colors?.left ?? shade(color, "left");
  return (
    <g>
      <polygon points={pts([b.nw, b.sw, t.sw, t.nw])} fill={cLeft} />
      <polygon points={pts([b.nw, b.ne, t.ne, t.nw])} fill={cRight} />
      <polygon points={pts([t.nw, t.ne, t.se, t.sw])} fill={cTop} />
    </g>
  );
}

// ───── Platform: a raised pad under the room with bevel + soft drop-shadow. ─────
export function Platform({
  x = -0.7, y = -0.7, w = 7.4, d = 7.4,
  thickness = 0.32,
  color = "#fbfafa",
  shadow = true,
}: {
  x?: number; y?: number; w?: number; d?: number;
  thickness?: number;
  color?: string;
  shadow?: boolean;
}) {
  const p = (px: number, py: number, pz: number) => iso3(x + px, y + py, pz);
  const cTop = lighter(color, 0.04);
  const cFrontRight = mix(color, "#000000", 0.18);
  const cFrontLeft = mix(color, "#000000", 0.10);
  const center = iso3(x + w / 2, y + d / 2, -0.05);
  const shadowRx = (w + d) * U * 0.4;
  const shadowRy = shadowRx * 0.32;
  return (
    <g>
      {shadow && (
        <ellipse
          cx={center.x}
          cy={center.y + 6}
          rx={shadowRx}
          ry={shadowRy}
          fill="rgba(0,0,0,0.18)"
          filter="url(#iso-plat-blur)"
        />
      )}
      <polygon points={pts([p(0, d, 0), p(w, d, 0), p(w, d, thickness), p(0, d, thickness)])} fill={cFrontRight} />
      <polygon points={pts([p(w, 0, 0), p(w, d, 0), p(w, d, thickness), p(w, 0, thickness)])} fill={cFrontLeft} />
      <polygon points={pts([p(0, 0, thickness), p(w, 0, thickness), p(w, d, thickness), p(0, d, thickness)])} fill={cTop} />
    </g>
  );
}

// ───── FloorRect: flat rectangle at low Z (rug/mat). ─────
export function FloorRect({
  x = 0, y = 0, w = 1, d = 1, color = "#dddddd", opacity = 1,
}: {
  x?: number; y?: number; w?: number; d?: number;
  color?: string; opacity?: number;
}) {
  const p = (px: number, py: number) => iso3(x + px, y + py, 0.005);
  return <polygon points={pts([p(0, 0), p(w, 0), p(w, d), p(0, d)])} fill={color} opacity={opacity} />;
}

// ───── FloorLightPool: soft elliptical glow on the floor under a pendant. ─────
export function FloorLightPool({
  x = 0, y = 0, rx = 1.4, ry = 1.0, color = "#fde68a", opacity = 0.45,
}: {
  x?: number; y?: number; rx?: number; ry?: number;
  color?: string; opacity?: number;
}) {
  const c = iso3(x, y, 0.015);
  return (
    <ellipse
      cx={c.x}
      cy={c.y}
      rx={rx * U}
      ry={ry * U * 0.5}
      fill={color}
      opacity={opacity}
      filter="url(#iso-pool-blur)"
    />
  );
}

// ───── Cylinder: side band + top ellipse. ─────
export function Cylinder({
  x = 0, y = 0, z = 0, r = 0.3, h = 0.4, color = "#cccccc",
}: {
  x?: number; y?: number; z?: number;
  r?: number; h?: number; color?: string;
}) {
  const bot = iso3(x, y, z);
  const top = iso3(x, y, z + h);
  const rx = r * U;
  const ry = r * U * 0.5;
  const cTop = shade(color, "top");
  const cSide = shade(color, "right");
  return (
    <g>
      <path
        d={`M ${fmt(bot.x - rx)} ${fmt(bot.y)} A ${fmt(rx)} ${fmt(ry)} 0 0 0 ${fmt(bot.x + rx)} ${fmt(bot.y)} L ${fmt(bot.x + rx)} ${fmt(top.y)} A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(bot.x - rx)} ${fmt(top.y)} Z`}
        fill={cSide}
      />
      <ellipse cx={top.x} cy={top.y} rx={rx} ry={ry} fill={cTop} />
    </g>
  );
}

// ───── Sphere: projected ellipse with a small highlight rim. ─────
export function Sphere({
  x = 0, y = 0, z = 0, r = 0.3, color = "#cccccc",
}: {
  x?: number; y?: number; z?: number;
  r?: number; color?: string;
}) {
  const c = iso3(x, y, z);
  const R = r * U;
  return (
    <g>
      <ellipse cx={c.x} cy={c.y} rx={R} ry={R} fill={shade(color, "top")} />
      <ellipse
        cx={c.x + R * 0.35}
        cy={c.y + R * 0.35}
        rx={R * 0.55}
        ry={R * 0.55}
        fill={shade(color, "right")}
        opacity={0.5}
      />
    </g>
  );
}

// ───── WallDecal: place content on either back wall plane (in wall-local coords). ─────
// `wall='left'` is the wall along y=0; `wall='right'` is the wall along x=0.
// `u` runs along the wall, `v` runs up. Children draw in pixel space with the
// origin at (u,v) and the appropriate skew applied so they stick to the wall.
export function WallDecal({
  wall = "left",
  u = 0,
  v = 0,
  children,
}: {
  wall?: "left" | "right";
  u?: number;
  v?: number;
  children: ReactNode;
}) {
  const p = wall === "left" ? iso3(u, 0, v) : iso3(0, u, v);
  // 26.57° = atan(1/2), the iso tilt
  const skew = wall === "left" ? "skewY(26.57)" : "skewY(-26.57)";
  return <g transform={`translate(${fmt(p.x)} ${fmt(p.y)}) ${skew}`}>{children}</g>;
}

// ───── Plane: arbitrary 4-corner polygon in world coords. ─────
export function Plane({
  corners,
  color = "#ffffff",
  opacity = 1,
}: {
  corners: Array<[number, number, number]>;
  color?: string;
  opacity?: number;
}) {
  const projected = corners.map(([x, y, z]) => iso3(x, y, z));
  return <polygon points={pts(projected)} fill={color} opacity={opacity} />;
}

// SVG filter defs used by Platform/FloorLightPool. Mount once near the top of
// the SVG so any iso component below can `filter="url(#iso-*)"` it.
export function IsoDefs() {
  return (
    <defs>
      <filter id="iso-plat-blur" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="4" />
      </filter>
      <filter id="iso-pool-blur" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="3" />
      </filter>
      <filter id="iso-soft-blur" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="1.5" />
      </filter>
      <linearGradient id="iso-wall-grad-bottom" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="rgba(0,0,0,0.18)" />
        <stop offset="1" stopColor="rgba(0,0,0,0)" />
      </linearGradient>
    </defs>
  );
}
