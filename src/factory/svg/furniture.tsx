// Reusable iso-perspective furniture pieces. Every prop in the factory
// should compose from these primitives so the room library stays
// consistent and we can swap art uniformly.

import { memo } from "react";
import { iso } from "./geometry";

// ---------- Core box primitive ----------

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

export { IsoBox };

// Stylistic palette. Keep tight so different rooms share visual language.
export const SURFACE = {
  metalTop:    "var(--bg-3)",
  metalRight:  "var(--bg-1)",
  metalLeft:   "var(--bg-2)",
  darkTop:     "var(--bg-2)",
  darkRight:   "var(--bg-0)",
  darkLeft:    "var(--bg-1)",
  woodTop:     "#5a3a22",
  woodRight:   "#1a1208",
  woodLeft:    "#2a1d10",
  woodLight:   "#7a5232",
  fabricTop:   "var(--bg-2)",
  fabricRight: "var(--bg-1)",
  fabricLeft:  "var(--bg-2)",
  screen:      "var(--bg-0)",
  screenSide:  "var(--bg-0)",
};

// ---------- Office chair (high-back, leather) ----------

function OfficeChair__base({
  x, y, accent = "var(--bg-3)",
}: { x: number; y: number; accent?: string }) {
  // Chair faces south (toward the viewer). Back is at smaller y so it
  // renders behind the seat in iso depth.
  return (
    <>
      <IsoBox x={x} y={y} w={0.6} d={0.12} h={11}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x} y={y + 0.12} w={0.6} d={0.55} h={3.5}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.fabricLeft} />
    </>
  );
}

// ---------- Meeting / visitor chair (lower back) ----------

function MeetingChair__base({
  x, y, accent = "var(--bg-3)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.55} d={0.1} h={6.5}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x} y={y + 0.1} w={0.55} d={0.5} h={3}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.fabricLeft} />
    </>
  );
}

// ---------- Executive desk with monitor + keyboard + mug ----------

function ExecutiveDesk__base({
  x, y, w = 1.6, d = 1.0, accent = "rgba(245, 166, 35, 0.7)",
  withNameplate = true,
}: {
  x: number; y: number; w?: number; d?: number;
  accent?: string; withNameplate?: boolean;
}) {
  return (
    <>
      {/* Desk slab */}
      <IsoBox x={x} y={y} w={w} d={d} h={5.5}
        fillTop={SURFACE.woodLight} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      {/* Inset top for definition */}
      <IsoBox x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} h={5.7}
        fillTop={SURFACE.woodTop} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      {/* Monitor stand + screen */}
      <IsoBox x={x + 0.35} y={y + 0.25} w={w - 0.85} d={0.18} h={6.7}
        fillTop={SURFACE.screen} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + 0.35} y={y + 0.25} w={w - 0.85} d={0.05} h={11.5}
        fillTop={accent} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      {/* Keyboard */}
      <IsoBox x={x + 0.3} y={y + 0.55} w={w - 0.7} d={0.22} h={6.4}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Mug */}
      <IsoBox x={x + w - 0.25} y={y + 0.5} w={0.16} d={0.16} h={6.9}
        fillTop="var(--ink-1)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Nameplate */}
      {withNameplate && (
        <IsoBox x={x + 0.2} y={y + d - 0.18} w={w - 0.4} d={0.08} h={6.0}
          fillTop={accent} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      )}
    </>
  );
}

// ---------- Sofa (3-seater with arms + cushions) ----------

function Sofa__base({
  x, y, w = 1.8, accent = "rgba(245, 166, 35, 0.5)",
}: { x: number; y: number; w?: number; accent?: string }) {
  // Drawing order matters for iso depth: back panel first (smallest y),
  // then arms, then seat, then cushions on top.
  const backY = y;
  const armY  = y + 0.15;
  const seatY = y + 0.2;
  const cushionY = y + 0.25;
  const seatD = 0.7;

  return (
    <>
      {/* Back panel */}
      <IsoBox x={x} y={backY} w={w} d={0.18} h={7.5}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Left arm */}
      <IsoBox x={x} y={armY} w={0.18} d={seatD - 0.05} h={4.5}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Right arm */}
      <IsoBox x={x + w - 0.18} y={armY} w={0.18} d={seatD - 0.05} h={4.5}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Seat base */}
      <IsoBox x={x + 0.18} y={seatY} w={w - 0.36} d={seatD} h={2.7}
        fillTop={SURFACE.fabricTop} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Cushions — split into two halves */}
      <IsoBox x={x + 0.22} y={cushionY} w={(w - 0.44) / 2 - 0.04} d={seatD - 0.1} h={3.6}
        fillTop={accent} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.22 + (w - 0.44) / 2 + 0.04} y={cushionY} w={(w - 0.44) / 2 - 0.04} d={seatD - 0.1} h={3.6}
        fillTop={accent} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
    </>
  );
}

// ---------- Coffee table ----------

function CoffeeTable__base({
  x, y, w = 0.9, d = 0.45,
}: { x: number; y: number; w?: number; d?: number }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={2.0}
        fillTop={SURFACE.woodLight} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      <IsoBox x={x + 0.06} y={y + 0.06} w={w - 0.12} d={d - 0.12} h={2.2}
        fillTop={SURFACE.woodTop} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
    </>
  );
}

// ---------- Filing cabinet ----------

function FilingCabinet__base({
  x, y, accent = "rgba(245, 166, 35, 0.45)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.7} d={1.0} h={11}
        fillTop={SURFACE.darkTop} fillRight={SURFACE.darkRight} fillLeft="var(--bg-3)" />
      {/* Drawer accent strips on the south face — three thin handles */}
      <IsoBox x={x + 0.18} y={y + 0.95} w={0.34} d={0.06} h={3}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.18} y={y + 0.95} w={0.34} d={0.06} h={6.5}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.18} y={y + 0.95} w={0.34} d={0.06} h={10}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
    </>
  );
}

// ---------- Bookshelf ----------

function Bookshelf__base({
  x, y, w = 0.55, depth = 1.6, h = 14,
  spineColors = ["#5fd4f0", "#f5a623", "#ff6b9d", "#c4d943", "#b393f5", "#6bd968"],
}: {
  x: number; y: number; w?: number; depth?: number; h?: number;
  spineColors?: string[];
}) {
  // Frame as a tall thin box, books are protrusions along the front face
  // spaced down its depth.
  const bookCount = spineColors.length;
  const slot = (depth - 0.2) / bookCount;
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={depth} h={h}
        fillTop={SURFACE.darkTop} fillRight={SURFACE.darkRight} fillLeft={SURFACE.fabricLeft} />
      {spineColors.map((col, i) => {
        const bookY = y + 0.1 + i * slot;
        const bookH = h * (0.5 + 0.45 * Math.abs(Math.sin(i * 1.7)));
        return (
          <IsoBox key={i}
            x={x + 0.04} y={bookY} w={w - 0.05} d={slot * 0.85} h={bookH}
            fillTop={col} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
        );
      })}
    </>
  );
}

// ---------- Potted plant ----------

function Plant__base({
  x, y, leafColor = "rgba(94, 208, 168, 0.65)",
}: { x: number; y: number; leafColor?: string }) {
  const center = iso(x + 0.2, y + 0.2);
  return (
    <>
      {/* Pot */}
      <IsoBox x={x} y={y} w={0.4} d={0.4} h={2.8}
        fillTop="#3a2a1a" fillRight={SURFACE.woodRight} fillLeft="#251810" />
      {/* Pot rim */}
      <IsoBox x={x - 0.03} y={y - 0.03} w={0.46} d={0.46} h={3.0}
        fillTop="#5a3a22" fillRight={SURFACE.woodRight} fillLeft="#251810" />
      {/* Layered foliage */}
      <ellipse cx={center.x} cy={center.y - 6}  rx={5.2} ry={1.7} fill={leafColor} opacity={0.55} />
      <ellipse cx={center.x - 1.2} cy={center.y - 9}  rx={4.4} ry={1.4} fill={leafColor} opacity={0.75} />
      <ellipse cx={center.x + 1.2} cy={center.y - 11.5} rx={3.6} ry={1.2} fill={leafColor} opacity={0.6} />
      <ellipse cx={center.x} cy={center.y - 14}    rx={2.6} ry={0.9} fill={leafColor} opacity={0.85} />
    </>
  );
}

// ---------- Floor rug ----------

function FloorRug__base({
  x0, y0, x1, y1, color = "rgba(245, 166, 35, 0.06)", border = "rgba(245, 166, 35, 0.25)",
}: {
  x0: number; y0: number; x1: number; y1: number;
  color?: string; border?: string;
}) {
  const a = iso(x0, y0), b = iso(x1, y0), c = iso(x1, y1), dd = iso(x0, y1);
  const points = `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${dd.x},${dd.y}`;
  return <polygon points={points} fill={color} stroke={border} strokeWidth={0.4} />;
}

// ---------- Conference / strategy table ----------

function ConferenceTable__base({
  x, y, w = 2.4, d = 1.4, glowColor = "rgba(245, 166, 35, 0.45)",
}: { x: number; y: number; w?: number; d?: number; glowColor?: string }) {
  return (
    <>
      {/* Heavy slab base */}
      <IsoBox x={x} y={y} w={w} d={d} h={3.0}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft="var(--bg-2)" />
      {/* Inset glow tabletop */}
      <IsoBox x={x + 0.1} y={y + 0.1} w={w - 0.2} d={d - 0.2} h={3.2}
        fillTop={glowColor} fillRight={SURFACE.fabricRight} fillLeft="var(--bg-2)" />
      {/* A small holo display rises from the centre of the table */}
      <IsoBox x={x + w / 2 - 0.32} y={y + d / 2 - 0.04} w={0.64} d={0.08} h={6.5}
        fillTop="var(--bg-0)" fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + w / 2 - 0.32} y={y + d / 2 - 0.04} w={0.64} d={0.025} h={9.4}
        fillTop={glowColor} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
    </>
  );
}

// ---------- Holo command table (kept for war-room style use) ----------

function HoloTable__base({
  x, y, accent = "rgba(245,166,35,0.55)",
}: { x: number; y: number; accent?: string }) {
  const ce = iso(x + 1, y + 1);
  return (
    <>
      <IsoBox x={x} y={y} w={2} d={2} h={6}
        fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      <IsoBox x={x - 0.15} y={y - 0.15} w={2.3} d={2.3} h={2.5}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft="var(--bg-2)" />
      <IsoBox x={x + 0.4} y={y + 0.4} w={1.2} d={1.2} h={12}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft="var(--bg-3)" />
      <ellipse cx={ce.x} cy={ce.y - 26} rx={22} ry={6}   fill={accent} opacity={0.35} />
      <ellipse cx={ce.x} cy={ce.y - 32} rx={14} ry={3.5} fill={accent} opacity={0.6} />
      <ellipse cx={ce.x} cy={ce.y - 36} rx={6}  ry={1.4} fill={accent} />
    </>
  );
}

// ---------- Workstation (compact desk + monitor + keyboard) ----------

function Workstation__base({
  x, y, w = 1.2, d = 0.9, accent = "rgba(95, 212, 240, 0.7)",
}: { x: number; y: number; w?: number; d?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={5.2}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.06} y={y + 0.06} w={w - 0.12} d={d - 0.12} h={5.4}
        fillTop="var(--bg-2)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.18} y={y + 0.15} w={w - 0.36} d={0.18} h={6.4}
        fillTop="var(--bg-0)" fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + 0.18} y={y + 0.15} w={w - 0.36} d={0.05} h={11}
        fillTop={accent} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + 0.18} y={y + 0.45} w={w - 0.36} d={0.22} h={6.0}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
    </>
  );
}

// ---------- Server rack (multi-tier with row indicators) ----------

function ServerRack__base({
  x, y, w = 1.0, d = 1.0, h = 16,
  accent = "rgba(179, 147, 245, 0.85)",
}: { x: number; y: number; w?: number; d?: number; h?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={h}
        fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      {/* Row LEDs cascading down the front face */}
      {Array.from({ length: 6 }).map((_, i) => (
        <IsoBox key={`r-${i}`}
          x={x + 0.08} y={y + 0.04 + i * 0.16}
          w={w - 0.16} d={0.08} h={h - 1.2 + Math.sin(i * 1.4) * 1.5}
          fillTop={accent} fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      ))}
    </>
  );
}

// ---------- Lab bench (long worktop with experimental gear) ----------

function LabBench__base({
  x, y, w = 1.6, d = 0.7,
  flaskColor = "rgba(179, 147, 245, 0.85)",
  scopeColor = "rgba(95, 212, 240, 0.85)",
}: { x: number; y: number; w?: number; d?: number;
     flaskColor?: string; scopeColor?: string }) {
  return (
    <>
      {/* Bench surface */}
      <IsoBox x={x} y={y} w={w} d={d} h={3.5}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} h={3.7}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Flask */}
      <IsoBox x={x + 0.2} y={y + 0.18} w={0.22} d={0.22} h={6.0}
        fillTop={flaskColor} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Microscope */}
      <IsoBox x={x + 0.55} y={y + 0.18} w={0.25} d={0.25} h={4.5}
        fillTop="var(--ink-1)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.6} y={y + 0.22} w={0.18} d={0.05} h={7.5}
        fillTop={scopeColor} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Scope readout */}
      <IsoBox x={x + 0.95} y={y + 0.18} w={0.4} d={0.18} h={5.5}
        fillTop="var(--bg-0)" fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + 0.95} y={y + 0.18} w={0.4} d={0.04} h={8.0}
        fillTop={scopeColor} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
    </>
  );
}

// ---------- Drafting table ----------

function DraftingTable__base({
  x, y, w = 1.0, d = 0.7, paperColor = "var(--ink-0)",
  doodleColor = "rgba(255, 107, 157, 0.7)",
}: { x: number; y: number; w?: number; d?: number;
     paperColor?: string; doodleColor?: string }) {
  const center = iso(x + w / 2, y + d / 2);
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={3.5}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} h={4.0}
        fillTop={paperColor} fillRight="var(--ink-2)" fillLeft="var(--ink-1)" />
      <ellipse cx={center.x} cy={center.y - 4.6} rx={4} ry={1.2} fill={doodleColor} />
      <ellipse cx={center.x + 1} cy={center.y - 4.4} rx={2} ry={0.6} fill="rgba(245, 166, 35, 0.7)" />
    </>
  );
}

// ---------- Printer / multi-function unit ----------

function Printer__base({
  x, y, accent = "rgba(94, 208, 168, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.7} d={0.55} h={3.5}
        fillTop="var(--bg-2)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.6} d={0.45} h={4.2}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Paper output tray */}
      <IsoBox x={x + 0.08} y={y + 0.42} w={0.55} d={0.12} h={3.6}
        fillTop="var(--ink-0)" fillRight="var(--ink-2)" fillLeft="var(--ink-1)" />
      {/* Status LED */}
      <IsoBox x={x + 0.55} y={y + 0.08} w={0.08} d={0.08} h={4.6}
        fillTop={accent} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
    </>
  );
}

// ---------- Whiteboard / pinboard (free-standing, faces south) ----------

function Whiteboard__base({
  x, y, w = 1.6, accent = "rgba(95, 212, 240, 0.55)",
}: { x: number; y: number; w?: number; accent?: string }) {
  return (
    <>
      {/* Stand */}
      <IsoBox x={x + 0.08} y={y + 0.4} w={0.05} d={0.05} h={5}
        fillTop={SURFACE.darkTop} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + w - 0.13} y={y + 0.4} w={0.05} d={0.05} h={5}
        fillTop={SURFACE.darkTop} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Board face */}
      <IsoBox x={x} y={y + 0.4} w={w} d={0.06} h={9}
        fillTop="var(--ink-1)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Diagram strokes */}
      <IsoBox x={x + 0.15} y={y + 0.42} w={w * 0.6} d={0.02} h={8.4}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.15} y={y + 0.42} w={w * 0.4} d={0.02} h={7.8}
        fillTop="rgba(245, 166, 35, 0.65)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.15} y={y + 0.42} w={w * 0.7} d={0.02} h={7.2}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
    </>
  );
}

// ---------- Stack of papers / report pile ----------

function PaperStack__base({
  x, y, w = 0.4, d = 0.3, h = 1.4,
  topAccent = "rgba(245, 166, 35, 0.5)",
}: { x: number; y: number; w?: number; d?: number; h?: number; topAccent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={h}
        fillTop="var(--ink-0)" fillRight="var(--ink-2)" fillLeft="var(--ink-1)" />
      {/* Tinted top sheet (a colored cover/folder) */}
      <IsoBox x={x + 0.02} y={y + 0.02} w={w - 0.04} d={d - 0.04} h={h + 0.05}
        fillTop={topAccent} fillRight="var(--ink-2)" fillLeft="var(--ink-1)" />
    </>
  );
}

// ---------- Shipping boxes (cardboard pile) ----------

function ShippingBoxes__base({
  x, y,
}: { x: number; y: number }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.7} d={0.7} h={3}
        fillTop="#9c7d52" fillRight="#5a4a32" fillLeft="#705842" />
      <IsoBox x={x + 0.08} y={y + 0.08} w={0.55} d={0.55} h={5.6}
        fillTop="#a88a5e" fillRight="#5a4a32" fillLeft="#705842" />
      <IsoBox x={x + 0.16} y={y + 0.16} w={0.42} d={0.42} h={7.8}
        fillTop="#b59765" fillRight="#5a4a32" fillLeft="#705842" />
      {/* Tape strips on top */}
      <IsoBox x={x + 0.05} y={y + 0.32} w={0.6} d={0.06} h={3.2}
        fillTop="rgba(245, 166, 35, 0.5)" fillRight="#5a4a32" fillLeft="#705842" />
    </>
  );
}

// ---------- Globe on a stand ----------

function Globe__base({
  x, y, accent = "rgba(95, 212, 240, 0.7)",
}: { x: number; y: number; accent?: string }) {
  const c = iso(x + 0.2, y + 0.2);
  return (
    <>
      {/* Stand base */}
      <IsoBox x={x + 0.1} y={y + 0.1} w={0.2} d={0.2} h={2.2}
        fillTop="#3a2a1a" fillRight={SURFACE.woodRight} fillLeft="#251810" />
      {/* Globe sphere (approximated with circles) */}
      <ellipse cx={c.x} cy={c.y - 5} r={2.6} fill="var(--bg-2)" />
      <circle cx={c.x} cy={c.y - 5} r={2.6} fill="var(--bg-2)" stroke={accent} strokeWidth={0.4} />
      {/* Equator + meridian lines */}
      <ellipse cx={c.x} cy={c.y - 5} rx={2.6} ry={0.9} fill="none" stroke={accent} strokeWidth={0.25} />
      <ellipse cx={c.x} cy={c.y - 5} rx={1.3} ry={2.6} fill="none" stroke={accent} strokeWidth={0.25} />
      {/* Continents hint */}
      <ellipse cx={c.x - 0.5} cy={c.y - 5.4} rx={0.9} ry={0.6} fill={accent} opacity={0.55} />
      <ellipse cx={c.x + 0.8} cy={c.y - 4.6} rx={0.7} ry={0.4} fill={accent} opacity={0.55} />
    </>
  );
}

// ---------- Telephone (multi-line desk phone) ----------

function Telephone__base({
  x, y, accent = "rgba(106, 169, 255, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.4} d={0.3} h={1.0}
        fillTop="var(--bg-2)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.04} y={y + 0.04} w={0.32} d={0.22} h={1.2}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Handset cradle */}
      <IsoBox x={x - 0.05} y={y + 0.2} w={0.5} d={0.1} h={1.6}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
    </>
  );
}

// ---------- Binder stack (colored office binders) ----------

function BinderStack__base({
  x, y, w = 0.4, d = 0.5,
  colors = ["#5fd4f0", "#f5a623", "#ff6b9d", "#c4d943"],
}: {
  x: number; y: number; w?: number; d?: number; colors?: string[];
}) {
  return (
    <>
      {colors.map((color, i) => (
        <IsoBox key={i}
          x={x + 0.02} y={y + 0.02 + i * (d / colors.length - 0.01)}
          w={w - 0.04} d={d / colors.length * 0.9} h={5 + (i % 2) * 0.6}
          fillTop={color} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      ))}
    </>
  );
}

// ---------- Test tube rack ----------

function TestTubes__base({
  x, y,
  colors = [
    "rgba(95, 212, 240, 0.85)",
    "rgba(94, 208, 168, 0.85)",
    "rgba(245, 166, 35, 0.85)",
    "rgba(255, 107, 157, 0.85)",
  ],
}: { x: number; y: number; colors?: string[] }) {
  return (
    <>
      {/* Rack base */}
      <IsoBox x={x} y={y} w={0.55} d={0.18} h={1.0}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {colors.map((color, i) => (
        <IsoBox key={i}
          x={x + 0.05 + i * 0.11} y={y + 0.04}
          w={0.07} d={0.08} h={3.5 + (i % 2) * 0.6}
          fillTop={color} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      ))}
    </>
  );
}

// ---------- Control panel (lab / server side panel) ----------

function ControlPanel__base({
  x, y, w = 0.6, d = 0.3, h = 4.5,
  accent = "rgba(179, 147, 245, 0.85)",
}: {
  x: number; y: number; w?: number; d?: number; h?: number; accent?: string;
}) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={h}
        fillTop="var(--bg-2)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.04} y={y + 0.04} w={w - 0.08} d={d - 0.08} h={h + 0.2}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Indicator lights */}
      {[0, 1, 2].map((i) => (
        <IsoBox key={i}
          x={x + 0.08 + i * 0.16} y={y + 0.07}
          w={0.08} d={0.08} h={h + 0.5}
          fillTop={i === 1 ? "rgba(245,166,35,0.9)" : accent}
          fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      ))}
    </>
  );
}

// ---------- Pen / brush jar ----------

function PenJar__base({
  x, y, accent = "rgba(255, 107, 157, 0.7)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.2} d={0.2} h={1.4}
        fillTop="var(--bg-3)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Three pens sticking up */}
      <IsoBox x={x + 0.04} y={y + 0.04} w={0.04} d={0.04} h={3.2}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.1} y={y + 0.06} w={0.04} d={0.04} h={2.8}
        fillTop="rgba(95, 212, 240, 0.7)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.07} y={y + 0.12} w={0.04} d={0.04} h={3.5}
        fillTop="rgba(245, 166, 35, 0.7)" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
    </>
  );
}

// ---------- Wall clock (mounted on the back wall) ----------

function WallClock__base({
  x, y0, accent = "rgba(245, 166, 35, 0.85)",
}: { x: number; y0: number; accent?: string }) {
  // Position the face on the south face of the back wall
  const center = iso(x, y0 + 0.05);
  return (
    <>
      <ellipse cx={center.x} cy={center.y - 38} rx={2.2} ry={2.2}
        fill="var(--bg-0)" stroke={accent} strokeWidth={0.4} />
      {/* Hands */}
      <line x1={center.x} y1={center.y - 38} x2={center.x + 0.2} y2={center.y - 39.4}
        stroke={accent} strokeWidth={0.35} />
      <line x1={center.x} y1={center.y - 38} x2={center.x + 1.4} y2={center.y - 37.6}
        stroke={accent} strokeWidth={0.3} />
    </>
  );
}

// ---------- Color sample rack (creative supply tower) ----------

function ColorRack__base({
  x, y, palette = ["#ff6b9d", "#5fd4f0", "#f5a623", "#c4d943", "#b393f5"],
}: { x: number; y: number; palette?: string[] }) {
  return (
    <>
      <IsoBox x={x} y={y} w={1.0} d={1.0} h={14}
        fillTop="var(--bg-3)" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {palette.map((col, i) => (
        <IsoBox key={i}
          x={x + 0.1 + i * 0.16} y={y + 0.15}
          w={0.12} d={0.18} h={6 + i * 1.6}
          fillTop={col} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      ))}
    </>
  );
}

// ---------- Multi-station rooms ----------

// Long counter: one continuous worktop spanning N grid units. Used for
// call-center / triage rooms where many agents share a desk.
function LongCounter__base({
  x, y, w = 5, d = 1.2, accent = "var(--bg-3)",
}: { x: number; y: number; w?: number; d?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={5}
        fillTop={accent} fillRight={SURFACE.metalRight} fillLeft={SURFACE.metalLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} h={5.4}
        fillTop={SURFACE.metalTop} fillRight={SURFACE.metalRight} fillLeft={SURFACE.metalLeft} />
    </>
  );
}

// Open desk row: N workstations placed end-to-end at a single y.
function OpenDeskRow__base({
  x, y, count = 4, gap = 0.05, accent = "var(--bg-3)",
}: { x: number; y: number; count?: number; gap?: number; accent?: string }) {
  const each = 1.0;
  const items: React.ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    items.push(
      <IsoBox key={`d${i}`}
        x={x + i * (each + gap)} y={y} w={each} d={1.0} h={5.2}
        fillTop={accent} fillRight={SURFACE.metalRight} fillLeft={SURFACE.metalLeft} />,
    );
  }
  return <>{items}</>;
}

// Phone bank: vertical bank of phones on the back wall — each is a small
// rectangle with a colored handset accent.
function PhoneBank__base({
  x, y, count = 4, accent = "rgba(106, 169, 255, 0.85)",
}: { x: number; y: number; count?: number; accent?: string }) {
  const items: React.ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    items.push(
      <IsoBox key={`p${i}`}
        x={x + i * 0.5} y={y} w={0.4} d={0.18} h={3.4}
        fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />,
      <IsoBox key={`h${i}`}
        x={x + 0.05 + i * 0.5} y={y + 0.04} w={0.3} d={0.08} h={3.8}
        fillTop={accent} fillRight="var(--bg-2)" fillLeft="var(--bg-1)" />,
    );
  }
  return <>{items}</>;
}

function Headset__base({
  x, y, accent = "rgba(106, 169, 255, 0.95)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.32} d={0.18} h={2.2}
        fillTop={accent} fillRight="var(--bg-2)" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.04} y={y + 0.02} w={0.06} d={0.14} h={3.2}
        fillTop="var(--ink-1)" fillRight="var(--bg-2)" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.22} y={y + 0.02} w={0.06} d={0.14} h={3.2}
        fillTop="var(--ink-1)" fillRight="var(--bg-2)" fillLeft="var(--bg-1)" />
    </>
  );
}

function CallQueueBoard__base({
  x, y, accent = "rgba(106, 169, 255, 0.9)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={1.4} d={0.06} h={4.6}
        fillTop="var(--bg-0)" fillRight="var(--bg-0)" fillLeft="var(--bg-0)" />
      <IsoBox x={x + 0.08} y={y + 0.01} w={1.24} d={0.04} h={5.0}
        fillTop={accent} fillRight="var(--bg-0)" fillLeft="var(--bg-0)" />
    </>
  );
}

// ---------- Dev / automation ----------

function TerminalRack__base({
  x, y, w = 1.6, accent = "rgba(95, 212, 240, 0.85)",
}: { x: number; y: number; w?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={0.18} h={11}
        fillTop="var(--bg-0)" fillRight="var(--bg-0)" fillLeft="var(--bg-0)" />
      <IsoBox x={x + 0.05} y={y + 0.02} w={w - 0.1} d={0.14} h={11.5}
        fillTop={accent} fillRight="var(--bg-0)" fillLeft="var(--bg-0)" />
    </>
  );
}

function CableTray__base({
  x, y, w = 2,
}: { x: number; y: number; w?: number }) {
  return (
    <IsoBox x={x} y={y} w={w} d={0.15} h={0.6}
      fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
  );
}

// ---------- Legal / compliance ----------

function LawBookshelf__base({
  x, y, h = 14,
}: { x: number; y: number; h?: number }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.6} d={1.4} h={h}
        fillTop={SURFACE.woodTop} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.5} d={1.3} h={h - 1}
        fillTop="#3a2818" fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
    </>
  );
}

function FileSafe__base({
  x, y, accent = "rgba(196, 217, 67, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.7} d={0.7} h={6}
        fillTop="var(--bg-2)" fillRight="#0e161e" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.6} d={0.6} h={6.2}
        fillTop="var(--bg-3)" fillRight="#0e161e" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.3} y={y + 0.05} w={0.1} d={0.1} h={6.5}
        fillTop={accent} fillRight="#0e161e" fillLeft="var(--bg-1)" />
    </>
  );
}

function DocStamp__base({
  x, y, accent = "rgba(245, 166, 35, 0.9)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.3} d={0.3} h={1.5}
        fillTop={SURFACE.woodTop} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.2} d={0.2} h={2.4}
        fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.2} d={0.2} h={2.7}
        fillTop={accent} fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
    </>
  );
}

// ---------- Archive ----------

function ArchiveWall__base({
  x, y, w = 4, h = 12,
}: { x: number; y: number; w?: number; h?: number }) {
  const cells: React.ReactNode[] = [];
  const cols = Math.floor(w / 0.5);
  const rows = 5;
  const shelfH = h / rows;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      // Each cell sits on its own shelf elevation: cell r occupies the band
      // from (r * shelfH) to ((r + 1) * shelfH - 0.4). Tops drawn by IsoBox
      // land at h = (r + 1) * shelfH - 0.4, producing visually distinct rows.
      cells.push(
        <IsoBox key={`a${c}-${r}`}
          x={x + c * 0.5} y={y + 0.1} w={0.45} d={0.2}
          h={(r + 1) * shelfH - 0.4}
          fillTop="var(--bg-3)" fillRight="var(--bg-1)" fillLeft="var(--bg-2)" />,
      );
      // Thin shelf divider at the top of each band
      cells.push(
        <IsoBox key={`shelf-${c}-${r}`}
          x={x + c * 0.5} y={y + 0.05} w={0.45} d={0.3}
          h={(r + 1) * shelfH}
          fillTop="var(--bg-0)" fillRight="var(--bg-0)" fillLeft="#0e161e" />,
      );
    }
  }
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={0.4} h={h}
        fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      {cells}
    </>
  );
}

function Carousel__base({
  x, y,
}: { x: number; y: number }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.9} d={0.9} h={4.5}
        fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.1} y={y + 0.1} w={0.7} d={0.7} h={5}
        fillTop="var(--bg-3)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.4} y={y + 0.1} w={0.04} d={0.04} h={6}
        fillTop="var(--ink-1)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
    </>
  );
}

// ---------- Strategic / financial dashboards ----------

function WarMap__base({
  x, y, w = 3.2, accent = "rgba(245, 166, 35, 0.7)",
}: { x: number; y: number; w?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={0.08} h={5.2}
        fillTop="#0a1118" fillRight="#070b11" fillLeft="#0a1118" />
      <IsoBox x={x + 0.1} y={y + 0.01} w={w - 0.2} d={0.06} h={5.6}
        fillTop={accent} fillRight="#070b11" fillLeft="#0a1118" />
    </>
  );
}

function TokenMeter__base({
  x, y, accent = "rgba(196, 217, 67, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.9} d={0.1} h={3.6}
        fillTop="var(--bg-2)" fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
      <IsoBox x={x + 0.05} y={y + 0.02} w={0.6} d={0.06} h={3.9}
        fillTop={accent} fillRight="var(--bg-0)" fillLeft="var(--bg-1)" />
    </>
  );
}

function KpiPanel__base({
  x, y, w = 1.4, accent = "rgba(95, 212, 240, 0.85)",
}: { x: number; y: number; w?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={0.1} h={4.6}
        fillTop="#0a1118" fillRight="#070b11" fillLeft="#0a1118" />
      <IsoBox x={x + 0.05} y={y + 0.01} w={w - 0.1} d={0.08} h={5.0}
        fillTop={accent} fillRight="#070b11" fillLeft="#0a1118" />
    </>
  );
}


// React.memo wrappers around every furniture primitive. Props are primitives
// (x, y, w, d, h, accent strings), so the default shallow comparator skips
// re-renders cleanly when a memoized RoomShell passes the same coords twice.
export const OfficeChair = /*@__PURE__*/ memo(OfficeChair__base);
export const MeetingChair = /*@__PURE__*/ memo(MeetingChair__base);
export const ExecutiveDesk = /*@__PURE__*/ memo(ExecutiveDesk__base);
export const Sofa = /*@__PURE__*/ memo(Sofa__base);
export const CoffeeTable = /*@__PURE__*/ memo(CoffeeTable__base);
export const FilingCabinet = /*@__PURE__*/ memo(FilingCabinet__base);
export const Bookshelf = /*@__PURE__*/ memo(Bookshelf__base);
export const Plant = /*@__PURE__*/ memo(Plant__base);
export const FloorRug = /*@__PURE__*/ memo(FloorRug__base);
export const ConferenceTable = /*@__PURE__*/ memo(ConferenceTable__base);
export const HoloTable = /*@__PURE__*/ memo(HoloTable__base);
export const Workstation = /*@__PURE__*/ memo(Workstation__base);
export const ServerRack = /*@__PURE__*/ memo(ServerRack__base);
export const LabBench = /*@__PURE__*/ memo(LabBench__base);
export const DraftingTable = /*@__PURE__*/ memo(DraftingTable__base);
export const Printer = /*@__PURE__*/ memo(Printer__base);
export const Whiteboard = /*@__PURE__*/ memo(Whiteboard__base);
export const PaperStack = /*@__PURE__*/ memo(PaperStack__base);
export const ShippingBoxes = /*@__PURE__*/ memo(ShippingBoxes__base);
export const Globe = /*@__PURE__*/ memo(Globe__base);
export const Telephone = /*@__PURE__*/ memo(Telephone__base);
export const BinderStack = /*@__PURE__*/ memo(BinderStack__base);
export const TestTubes = /*@__PURE__*/ memo(TestTubes__base);
export const ControlPanel = /*@__PURE__*/ memo(ControlPanel__base);
export const PenJar = /*@__PURE__*/ memo(PenJar__base);
export const WallClock = /*@__PURE__*/ memo(WallClock__base);
export const ColorRack = /*@__PURE__*/ memo(ColorRack__base);
export const LongCounter = /*@__PURE__*/ memo(LongCounter__base);
export const OpenDeskRow = /*@__PURE__*/ memo(OpenDeskRow__base);
export const PhoneBank = /*@__PURE__*/ memo(PhoneBank__base);
export const Headset = /*@__PURE__*/ memo(Headset__base);
export const CallQueueBoard = /*@__PURE__*/ memo(CallQueueBoard__base);
export const TerminalRack = /*@__PURE__*/ memo(TerminalRack__base);
export const CableTray = /*@__PURE__*/ memo(CableTray__base);
export const LawBookshelf = /*@__PURE__*/ memo(LawBookshelf__base);
export const FileSafe = /*@__PURE__*/ memo(FileSafe__base);
export const DocStamp = /*@__PURE__*/ memo(DocStamp__base);
export const ArchiveWall = /*@__PURE__*/ memo(ArchiveWall__base);
export const Carousel = /*@__PURE__*/ memo(Carousel__base);
export const WarMap = /*@__PURE__*/ memo(WarMap__base);
export const TokenMeter = /*@__PURE__*/ memo(TokenMeter__base);
export const KpiPanel = /*@__PURE__*/ memo(KpiPanel__base);
