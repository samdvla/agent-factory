import React from "react";
import { iso } from "./geometry";

function IsoBox({
  x, y, w, d, h, fillTop, fillRight, fillLeft,
}: {
  x: number; y: number; w: number; d: number; h: number;
  fillTop: string; fillRight: string; fillLeft: string;
}) {
  const a = iso(x, y);
  const b = iso(x + w, y);
  const c = iso(x + w, y + d);
  const dd = iso(x, y + d);
  const top   = `${a.x},${a.y - h} ${b.x},${b.y - h} ${c.x},${c.y - h} ${dd.x},${dd.y - h}`;
  const right = `${b.x},${b.y - h} ${b.x},${b.y} ${c.x},${c.y} ${c.x},${c.y - h}`;
  const left  = `${dd.x},${dd.y - h} ${dd.x},${dd.y} ${c.x},${c.y} ${c.x},${c.y - h}`;
  return (
    <>
      <polygon points={left}  fill={fillLeft}  />
      <polygon points={right} fill={fillRight} />
      <polygon points={top}   fill={fillTop}   />
    </>
  );
}

function WallPanel({
  face, x0, y0, x1, y1, baseY, height, color,
}: {
  face: "south" | "east"; x0: number; y0: number; x1: number; y1: number;
  baseY: number; height: number; color: string;
}) {
  if (face === "south") {
    const a = iso(x0 + 0.2, y1 - 0.05), b = iso(x1 - 0.2, y1 - 0.05);
    const points = `${a.x},${a.y - baseY} ${b.x},${b.y - baseY} ${b.x},${b.y - baseY - height} ${a.x},${a.y - baseY - height}`;
    return <polygon points={points} fill={color} />;
  }
  if (face === "east") {
    const a = iso(x1 - 0.05, y0 + 0.2), b = iso(x1 - 0.05, y1 - 0.2);
    const points = `${a.x},${a.y - baseY} ${b.x},${b.y - baseY} ${b.x},${b.y - baseY - height} ${a.x},${a.y - baseY - height}`;
    return <polygon points={points} fill={color} />;
  }
  return null;
}

const TOP = "#1f2a37", RIGHT = "#15202b", LEFT = "#1a2532";

// bridge (scene.js lines 122-135)
export function BridgeProps({ ox, oy }: { ox: number; oy: number }) {
  const ce = iso(ox + 3, oy + 3.2);
  return (
    <g>
      <IsoBox x={ox + 2} y={oy + 2.2} w={2} d={2} h={8} fillTop="#243140" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 2.4} y={oy + 2.6} w={1.2} d={1.2} h={12} fillTop="#2c3a4d" fillRight="#1f2a37" fillLeft="#243140" />
      <ellipse cx={ce.x} cy={ce.y - 26} rx={22} ry={6} fill="rgba(245,166,35,0.18)" />
      <ellipse cx={ce.x} cy={ce.y - 32} rx={14} ry={3.5} fill="rgba(245,166,35,0.32)" />
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={18} height={28} color="rgba(245, 166, 35, 0.18)" />
      <IsoBox x={ox + 1.3} y={oy + 3.5} w={0.6} d={0.6} h={6} fillTop="#2a3849" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 4.1} y={oy + 3.5} w={0.6} d={0.6} h={6} fillTop="#2a3849" fillRight="#1a2532" fillLeft="#1f2a37" />
    </g>
  );
}

// analyst (scene.js lines 137-148)
export function AnalystProps({ ox, oy }: { ox: number; oy: number }) {
  return (
    <g>
      <IsoBox x={ox + 1.5} y={oy + 3}   w={3}   d={1.4} h={8}  fillTop={TOP} fillRight={RIGHT} fillLeft={LEFT} />
      <IsoBox x={ox + 1.8} y={oy + 3.1} w={1}   d={0.4} h={12} fillTop="#101820" fillRight="#0c141b" fillLeft="#0e161e" />
      <IsoBox x={ox + 1.8} y={oy + 3.1} w={1}   d={0.1} h={22} fillTop="rgba(95, 212, 240, 0.55)" fillRight="#0c141b" fillLeft="#0e161e" />
      <IsoBox x={ox + 3.2} y={oy + 3.1} w={1}   d={0.4} h={12} fillTop="#101820" fillRight="#0c141b" fillLeft="#0e161e" />
      <IsoBox x={ox + 3.2} y={oy + 3.1} w={1}   d={0.1} h={22} fillTop="rgba(95, 212, 240, 0.55)" fillRight="#0c141b" fillLeft="#0e161e" />
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={14} height={32} color="rgba(95, 212, 240, 0.18)" />
      <WallPanel face="east"  x0={ox + 5.5} y0={oy + 1.8} x1={ox + 6} y1={oy + 4.4} baseY={10} height={6} color="rgba(95, 212, 240, 0.12)" />
      <WallPanel face="east"  x0={ox + 5.5} y0={oy + 1.8} x1={ox + 6} y1={oy + 4.4} baseY={22} height={6} color="rgba(95, 212, 240, 0.12)" />
    </g>
  );
}

// fab (scene.js lines 149-164)
export function FabProps({ ox, oy }: { ox: number; oy: number }) {
  const swatches: React.ReactNode[] = [];
  for (let i = 0; i < 6; i++) {
    const xs = ox + 0.6 + i * 0.85;
    const colors = ["rgba(255,107,157,0.4)", "rgba(95,212,240,0.4)", "rgba(245,166,35,0.4)"];
    swatches.push(
      <WallPanel key={i}
        face="south" x0={xs} y0={oy} x1={xs + 0.6} y1={oy + 0.5}
        baseY={22 + (i % 2) * 4} height={6} color={colors[i % 3]} />
    );
  }
  return (
    <g>
      <IsoBox x={ox + 1.4} y={oy + 3}   w={2.4} d={1.4} h={8}  fillTop={TOP} fillRight={RIGHT} fillLeft={LEFT} />
      <IsoBox x={ox + 1.8} y={oy + 3.2} w={1.6} d={0.9} h={10} fillTop="rgba(255, 107, 157, 0.45)" fillRight="#1a2532" fillLeft="#1f2a37" />
      <WallPanel face="south" x0={ox + 0.4} y0={oy} x1={ox + 5.6} y1={oy + 0.5} baseY={14} height={30} color="rgba(255, 107, 157, 0.18)" />
      {swatches}
      <IsoBox x={ox + 4.2} y={oy + 3}   w={1}   d={1.2} h={16} fillTop="#243140" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 4.3} y={oy + 3.1} w={0.8} d={1}   h={4}  fillTop="rgba(255, 107, 157, 0.35)" fillRight="#1a2532" fillLeft="#1f2a37" />
    </g>
  );
}

// dispatch (scene.js lines 165-175)
export function DispatchProps({ ox, oy }: { ox: number; oy: number }) {
  const monitors: React.ReactNode[] = [];
  for (let i = 0; i < 3; i++) {
    monitors.push(
      <IsoBox key={i}
        x={ox + 1.2 + i * 1.3} y={oy + 3.05} w={1} d={0.3} h={14}
        fillTop="rgba(107, 217, 104, 0.45)" fillRight="#0c141b" fillLeft="#0e161e" />
    );
  }
  return (
    <g>
      <IsoBox x={ox + 1} y={oy + 3}   w={4}   d={1.2} h={8} fillTop={TOP} fillRight={RIGHT} fillLeft={LEFT} />
      {monitors}
      <IsoBox x={ox + 4.4} y={oy + 3.2} w={0.6} d={0.7} h={4} fillTop="#2a3849" fillRight="#1a2532" fillLeft="#1f2a37" />
      <WallPanel face="south" x0={ox + 1} y0={oy} x1={ox + 5} y1={oy + 0.5} baseY={22} height={6} color="rgba(107, 217, 104, 0.15)" />
    </g>
  );
}

// comms (scene.js lines 176-186)
export function CommsProps({ ox, oy }: { ox: number; oy: number }) {
  const chatWindows: React.ReactNode[] = [];
  for (let i = 0; i < 3; i++) {
    chatWindows.push(
      <WallPanel key={i}
        face="south" x0={ox + 1 + i * 1.3} y0={oy} x1={ox + 1.9 + i * 1.3} y1={oy + 0.5}
        baseY={18} height={14} color="rgba(106, 169, 255, 0.18)" />
    );
  }
  return (
    <g>
      <IsoBox x={ox + 2}   y={oy + 3}    w={2}   d={1.2} h={8}  fillTop={TOP} fillRight={RIGHT} fillLeft={LEFT} />
      <IsoBox x={ox + 2.2} y={oy + 3.05} w={1.6} d={0.3} h={12} fillTop="rgba(106, 169, 255, 0.5)" fillRight="#0c141b" fillLeft="#0e161e" />
      <IsoBox x={ox + 2.1} y={oy + 3.7}  w={0.4} d={0.3} h={4}  fillTop="#2a3849" fillRight="#1a2532" fillLeft="#1f2a37" />
      {chatWindows}
    </g>
  );
}

// control (scene.js lines 187-197)
export function ControlProps({ ox, oy }: { ox: number; oy: number }) {
  return (
    <g>
      <IsoBox x={ox + 1.6} y={oy + 3}   w={2.8} d={1.4} h={8}  fillTop={TOP} fillRight={RIGHT} fillLeft={LEFT} />
      <IsoBox x={ox + 1.8} y={oy + 3.1} w={2.4} d={0.4} h={12} fillTop="#101820" fillRight="#0c141b" fillLeft="#0e161e" />
      <IsoBox x={ox + 1.8} y={oy + 3.1} w={2.4} d={0.1} h={22} fillTop="rgba(196, 217, 67, 0.55)" fillRight="#0c141b" fillLeft="#0e161e" />
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={16} height={4} color="rgba(196, 217, 67, 0.18)" />
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 2.6} y1={oy + 0.5} baseY={16} height={4} color="rgba(196, 217, 67, 0.55)" />
      <WallPanel face="east"  x0={ox + 5.5} y0={oy + 2.5} x1={ox + 6} y1={oy + 4} baseY={14} height={18} color="rgba(196, 217, 67, 0.18)" />
    </g>
  );
}

// rd (scene.js lines 198-213)
export function RdProps({ ox, oy }: { ox: number; oy: number }) {
  const ce = iso(ox + 3, oy + 4);
  const racks: React.ReactNode[] = [];
  for (let i = 0; i < 4; i++) {
    racks.push(
      <IsoBox key={i}
        x={ox + 4} y={oy + 3} w={1} d={0.04} h={6 + i * 5}
        fillTop="rgba(179, 147, 245, 0.55)" fillRight="#0c141b" fillLeft="#15202b" />
    );
  }
  return (
    <g>
      <IsoBox x={ox + 1}   y={oy + 3}   w={1.4} d={1.4} h={8}  fillTop={TOP} fillRight={RIGHT} fillLeft={LEFT} />
      <IsoBox x={ox + 1.1} y={oy + 3.1} w={1.2} d={0.35} h={12} fillTop="rgba(179, 147, 245, 0.45)" fillRight="#0c141b" fillLeft="#0e161e" />
      <IsoBox x={ox + 4}   y={oy + 3}   w={1}   d={1.6} h={22} fillTop="#1a2532" fillRight="#0c141b" fillLeft="#15202b" />
      {racks}
      <ellipse cx={ce.x} cy={ce.y - 18} rx={12} ry={3}  fill="rgba(179, 147, 245, 0.35)" />
      <ellipse cx={ce.x} cy={ce.y - 24} rx={8}  ry={2}  fill="rgba(179, 147, 245, 0.5)"  />
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={18} height={24} color="rgba(179, 147, 245, 0.16)" />
    </g>
  );
}

export const PROPS_BY_KIND: Record<string, React.FC<{ ox: number; oy: number }>> = {
  bridge:   BridgeProps,
  analyst:  AnalystProps,
  fab:      FabProps,
  dispatch: DispatchProps,
  comms:    CommsProps,
  control:  ControlProps,
  rd:       RdProps,
};
