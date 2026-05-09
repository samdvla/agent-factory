// Reusable iso-perspective furniture pieces. Every prop in the factory
// should compose from these primitives so the room library stays
// consistent and we can swap art uniformly.

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
  metalTop:    "#2a3849",
  metalRight:  "#15202b",
  metalLeft:   "#1a2532",
  darkTop:     "#1a2532",
  darkRight:   "#10171f",
  darkLeft:    "#15202b",
  woodTop:     "#5a3a22",
  woodRight:   "#1a1208",
  woodLeft:    "#2a1d10",
  woodLight:   "#7a5232",
  fabricTop:   "#1f2a37",
  fabricRight: "#15202b",
  fabricLeft:  "#1a2532",
  screen:      "#101820",
  screenSide:  "#0c141b",
};

// ---------- Office chair (high-back, leather) ----------

export function OfficeChair({
  x, y, accent = "#2a3849",
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

export function MeetingChair({
  x, y, accent = "#2a3849",
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

export function ExecutiveDesk({
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
        fillTop="#2a3849" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Mug */}
      <IsoBox x={x + w - 0.25} y={y + 0.5} w={0.16} d={0.16} h={6.9}
        fillTop="#cdd5df" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Nameplate */}
      {withNameplate && (
        <IsoBox x={x + 0.2} y={y + d - 0.18} w={w - 0.4} d={0.08} h={6.0}
          fillTop={accent} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      )}
    </>
  );
}

// ---------- Sofa (3-seater with arms + cushions) ----------

export function Sofa({
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
        fillTop="#243140" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Left arm */}
      <IsoBox x={x} y={armY} w={0.18} d={seatD - 0.05} h={4.5}
        fillTop="#243140" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Right arm */}
      <IsoBox x={x + w - 0.18} y={armY} w={0.18} d={seatD - 0.05} h={4.5}
        fillTop="#243140" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
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

export function CoffeeTable({
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

export function FilingCabinet({
  x, y, accent = "rgba(245, 166, 35, 0.45)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.7} d={1.0} h={11}
        fillTop={SURFACE.darkTop} fillRight={SURFACE.darkRight} fillLeft="#28344a" />
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

export function Bookshelf({
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

export function Plant({
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

export function FloorRug({
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

export function ConferenceTable({
  x, y, w = 2.4, d = 1.4, glowColor = "rgba(245, 166, 35, 0.45)",
}: { x: number; y: number; w?: number; d?: number; glowColor?: string }) {
  return (
    <>
      {/* Heavy slab base */}
      <IsoBox x={x} y={y} w={w} d={d} h={3.0}
        fillTop="#2c3a4d" fillRight={SURFACE.fabricRight} fillLeft="#1f2a37" />
      {/* Inset glow tabletop */}
      <IsoBox x={x + 0.1} y={y + 0.1} w={w - 0.2} d={d - 0.2} h={3.2}
        fillTop={glowColor} fillRight={SURFACE.fabricRight} fillLeft="#1f2a37" />
      {/* A small holo display rises from the centre of the table */}
      <IsoBox x={x + w / 2 - 0.32} y={y + d / 2 - 0.04} w={0.64} d={0.08} h={6.5}
        fillTop="#101820" fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + w / 2 - 0.32} y={y + d / 2 - 0.04} w={0.64} d={0.025} h={9.4}
        fillTop={glowColor} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
    </>
  );
}

// ---------- Holo command table (kept for war-room style use) ----------

export function HoloTable({
  x, y, accent = "rgba(245,166,35,0.55)",
}: { x: number; y: number; accent?: string }) {
  const ce = iso(x + 1, y + 1);
  return (
    <>
      <IsoBox x={x} y={y} w={2} d={2} h={6}
        fillTop="#1a2330" fillRight="#10171f" fillLeft="#15202b" />
      <IsoBox x={x - 0.15} y={y - 0.15} w={2.3} d={2.3} h={2.5}
        fillTop="#243140" fillRight={SURFACE.darkRight} fillLeft="#1f2a37" />
      <IsoBox x={x + 0.4} y={y + 0.4} w={1.2} d={1.2} h={12}
        fillTop="#2c3a4d" fillRight={SURFACE.darkRight} fillLeft="#243140" />
      <ellipse cx={ce.x} cy={ce.y - 26} rx={22} ry={6}   fill={accent} opacity={0.35} />
      <ellipse cx={ce.x} cy={ce.y - 32} rx={14} ry={3.5} fill={accent} opacity={0.6} />
      <ellipse cx={ce.x} cy={ce.y - 36} rx={6}  ry={1.4} fill={accent} />
    </>
  );
}

// ---------- Workstation (compact desk + monitor + keyboard) ----------

export function Workstation({
  x, y, w = 1.2, d = 0.9, accent = "rgba(95, 212, 240, 0.7)",
}: { x: number; y: number; w?: number; d?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={5.2}
        fillTop="#2a3849" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.06} y={y + 0.06} w={w - 0.12} d={d - 0.12} h={5.4}
        fillTop="#1f2a37" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.18} y={y + 0.15} w={w - 0.36} d={0.18} h={6.4}
        fillTop="#101820" fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + 0.18} y={y + 0.15} w={w - 0.36} d={0.05} h={11}
        fillTop={accent} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + 0.18} y={y + 0.45} w={w - 0.36} d={0.22} h={6.0}
        fillTop="#2a3849" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
    </>
  );
}

// ---------- Server rack (multi-tier with row indicators) ----------

export function ServerRack({
  x, y, w = 1.0, d = 1.0, h = 16,
  accent = "rgba(179, 147, 245, 0.85)",
}: { x: number; y: number; w?: number; d?: number; h?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={h}
        fillTop="#1a2532" fillRight="#0c141b" fillLeft="#15202b" />
      {/* Row LEDs cascading down the front face */}
      {Array.from({ length: 6 }).map((_, i) => (
        <IsoBox key={`r-${i}`}
          x={x + 0.08} y={y + 0.04 + i * 0.16}
          w={w - 0.16} d={0.08} h={h - 1.2 + Math.sin(i * 1.4) * 1.5}
          fillTop={accent} fillRight="#0c141b" fillLeft="#15202b" />
      ))}
    </>
  );
}

// ---------- Lab bench (long worktop with experimental gear) ----------

export function LabBench({
  x, y, w = 1.6, d = 0.7,
  flaskColor = "rgba(179, 147, 245, 0.85)",
  scopeColor = "rgba(95, 212, 240, 0.85)",
}: { x: number; y: number; w?: number; d?: number;
     flaskColor?: string; scopeColor?: string }) {
  return (
    <>
      {/* Bench surface */}
      <IsoBox x={x} y={y} w={w} d={d} h={3.5}
        fillTop="#243140" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} h={3.7}
        fillTop="#2a3849" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Flask */}
      <IsoBox x={x + 0.2} y={y + 0.18} w={0.22} d={0.22} h={6.0}
        fillTop={flaskColor} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Microscope */}
      <IsoBox x={x + 0.55} y={y + 0.18} w={0.25} d={0.25} h={4.5}
        fillTop="#cdd5df" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.6} y={y + 0.22} w={0.18} d={0.05} h={7.5}
        fillTop={scopeColor} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Scope readout */}
      <IsoBox x={x + 0.95} y={y + 0.18} w={0.4} d={0.18} h={5.5}
        fillTop="#101820" fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
      <IsoBox x={x + 0.95} y={y + 0.18} w={0.4} d={0.04} h={8.0}
        fillTop={scopeColor} fillRight={SURFACE.screenSide} fillLeft={SURFACE.screenSide} />
    </>
  );
}

// ---------- Drafting table ----------

export function DraftingTable({
  x, y, w = 1.0, d = 0.7, paperColor = "#e6edf3",
  doodleColor = "rgba(255, 107, 157, 0.7)",
}: { x: number; y: number; w?: number; d?: number;
     paperColor?: string; doodleColor?: string }) {
  const center = iso(x + w / 2, y + d / 2);
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={3.5}
        fillTop="#243140" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} h={4.0}
        fillTop={paperColor} fillRight="#aab4c0" fillLeft="#cdd5df" />
      <ellipse cx={center.x} cy={center.y - 4.6} rx={4} ry={1.2} fill={doodleColor} />
      <ellipse cx={center.x + 1} cy={center.y - 4.4} rx={2} ry={0.6} fill="rgba(245, 166, 35, 0.7)" />
    </>
  );
}

// ---------- Printer / multi-function unit ----------

export function Printer({
  x, y, accent = "rgba(94, 208, 168, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.7} d={0.55} h={3.5}
        fillTop="#1f2a37" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.6} d={0.45} h={4.2}
        fillTop="#2a3849" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
      {/* Paper output tray */}
      <IsoBox x={x + 0.08} y={y + 0.42} w={0.55} d={0.12} h={3.6}
        fillTop="#e6edf3" fillRight="#aab4c0" fillLeft="#cdd5df" />
      {/* Status LED */}
      <IsoBox x={x + 0.55} y={y + 0.08} w={0.08} d={0.08} h={4.6}
        fillTop={accent} fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
    </>
  );
}

// ---------- Whiteboard / pinboard (free-standing, faces south) ----------

export function Whiteboard({
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
        fillTop="#cdd5df" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
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

export function PaperStack({
  x, y, w = 0.4, d = 0.3, h = 1.4,
  topAccent = "rgba(245, 166, 35, 0.5)",
}: { x: number; y: number; w?: number; d?: number; h?: number; topAccent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={h}
        fillTop="#e6edf3" fillRight="#aab4c0" fillLeft="#cdd5df" />
      {/* Tinted top sheet (a colored cover/folder) */}
      <IsoBox x={x + 0.02} y={y + 0.02} w={w - 0.04} d={d - 0.04} h={h + 0.05}
        fillTop={topAccent} fillRight="#aab4c0" fillLeft="#cdd5df" />
    </>
  );
}

// ---------- Shipping boxes (cardboard pile) ----------

export function ShippingBoxes({
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

export function Globe({
  x, y, accent = "rgba(95, 212, 240, 0.7)",
}: { x: number; y: number; accent?: string }) {
  const c = iso(x + 0.2, y + 0.2);
  return (
    <>
      {/* Stand base */}
      <IsoBox x={x + 0.1} y={y + 0.1} w={0.2} d={0.2} h={2.2}
        fillTop="#3a2a1a" fillRight={SURFACE.woodRight} fillLeft="#251810" />
      {/* Globe sphere (approximated with circles) */}
      <ellipse cx={c.x} cy={c.y - 5} r={2.6} fill="#1a2532" />
      <circle cx={c.x} cy={c.y - 5} r={2.6} fill="#1a2532" stroke={accent} strokeWidth={0.4} />
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

export function Telephone({
  x, y, accent = "rgba(106, 169, 255, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.4} d={0.3} h={1.0}
        fillTop="#1a2532" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.04} y={y + 0.04} w={0.32} d={0.22} h={1.2}
        fillTop={accent} fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      {/* Handset cradle */}
      <IsoBox x={x - 0.05} y={y + 0.2} w={0.5} d={0.1} h={1.6}
        fillTop="#2a3849" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
    </>
  );
}

// ---------- Binder stack (colored office binders) ----------

export function BinderStack({
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

export function TestTubes({
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
        fillTop="#243140" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
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

export function ControlPanel({
  x, y, w = 0.6, d = 0.3, h = 4.5,
  accent = "rgba(179, 147, 245, 0.85)",
}: {
  x: number; y: number; w?: number; d?: number; h?: number; accent?: string;
}) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={d} h={h}
        fillTop="#1a2532" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
      <IsoBox x={x + 0.04} y={y + 0.04} w={w - 0.08} d={d - 0.08} h={h + 0.2}
        fillTop="#243140" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
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

export function PenJar({
  x, y, accent = "rgba(255, 107, 157, 0.7)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.2} d={0.2} h={1.4}
        fillTop="#243140" fillRight={SURFACE.darkRight} fillLeft={SURFACE.darkLeft} />
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

export function WallClock({
  x, y0, accent = "rgba(245, 166, 35, 0.85)",
}: { x: number; y0: number; accent?: string }) {
  // Position the face on the south face of the back wall
  const center = iso(x, y0 + 0.05);
  return (
    <>
      <ellipse cx={center.x} cy={center.y - 38} rx={2.2} ry={2.2}
        fill="#0a0e15" stroke={accent} strokeWidth={0.4} />
      {/* Hands */}
      <line x1={center.x} y1={center.y - 38} x2={center.x + 0.2} y2={center.y - 39.4}
        stroke={accent} strokeWidth={0.35} />
      <line x1={center.x} y1={center.y - 38} x2={center.x + 1.4} y2={center.y - 37.6}
        stroke={accent} strokeWidth={0.3} />
    </>
  );
}

// ---------- Color sample rack (creative supply tower) ----------

export function ColorRack({
  x, y, palette = ["#ff6b9d", "#5fd4f0", "#f5a623", "#c4d943", "#b393f5"],
}: { x: number; y: number; palette?: string[] }) {
  return (
    <>
      <IsoBox x={x} y={y} w={1.0} d={1.0} h={14}
        fillTop="#243140" fillRight={SURFACE.fabricRight} fillLeft={SURFACE.fabricLeft} />
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
export function LongCounter({
  x, y, w = 5, d = 1.2, accent = "#2a3849",
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
export function OpenDeskRow({
  x, y, count = 4, gap = 0.05, accent = "#2a3849",
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
export function PhoneBank({
  x, y, count = 4, accent = "rgba(106, 169, 255, 0.85)",
}: { x: number; y: number; count?: number; accent?: string }) {
  const items: React.ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    items.push(
      <IsoBox key={`p${i}`}
        x={x + i * 0.5} y={y} w={0.4} d={0.18} h={3.4}
        fillTop="#1a2532" fillRight="#10171f" fillLeft="#15202b" />,
      <IsoBox key={`h${i}`}
        x={x + 0.05 + i * 0.5} y={y + 0.04} w={0.3} d={0.08} h={3.8}
        fillTop={accent} fillRight="#1a2532" fillLeft="#15202b" />,
    );
  }
  return <>{items}</>;
}

export function Headset({
  x, y, accent = "rgba(106, 169, 255, 0.95)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.32} d={0.18} h={2.2}
        fillTop={accent} fillRight="#1a2532" fillLeft="#15202b" />
      <IsoBox x={x + 0.04} y={y + 0.02} w={0.06} d={0.14} h={3.2}
        fillTop="#cdd5df" fillRight="#1a2532" fillLeft="#15202b" />
      <IsoBox x={x + 0.22} y={y + 0.02} w={0.06} d={0.14} h={3.2}
        fillTop="#cdd5df" fillRight="#1a2532" fillLeft="#15202b" />
    </>
  );
}

export function CallQueueBoard({
  x, y, accent = "rgba(106, 169, 255, 0.9)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={1.4} d={0.06} h={4.6}
        fillTop="#101820" fillRight="#0c141b" fillLeft="#10171f" />
      <IsoBox x={x + 0.08} y={y + 0.01} w={1.24} d={0.04} h={5.0}
        fillTop={accent} fillRight="#0c141b" fillLeft="#10171f" />
    </>
  );
}

// ---------- Dev / automation ----------

export function TerminalRack({
  x, y, w = 1.6, accent = "rgba(95, 212, 240, 0.85)",
}: { x: number; y: number; w?: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={0.18} h={11}
        fillTop="#101820" fillRight="#0c141b" fillLeft="#10171f" />
      <IsoBox x={x + 0.05} y={y + 0.02} w={w - 0.1} d={0.14} h={11.5}
        fillTop={accent} fillRight="#0c141b" fillLeft="#10171f" />
    </>
  );
}

export function CableTray({
  x, y, w = 2,
}: { x: number; y: number; w?: number }) {
  return (
    <IsoBox x={x} y={y} w={w} d={0.15} h={0.6}
      fillTop="#1a2532" fillRight="#10171f" fillLeft="#15202b" />
  );
}

// ---------- Legal / compliance ----------

export function LawBookshelf({
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

export function FileSafe({
  x, y, accent = "rgba(196, 217, 67, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.7} d={0.7} h={6}
        fillTop="#1a2532" fillRight="#0e161e" fillLeft="#15202b" />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.6} d={0.6} h={6.2}
        fillTop="#243140" fillRight="#0e161e" fillLeft="#15202b" />
      <IsoBox x={x + 0.3} y={y + 0.05} w={0.1} d={0.1} h={6.5}
        fillTop={accent} fillRight="#0e161e" fillLeft="#15202b" />
    </>
  );
}

export function DocStamp({
  x, y, accent = "rgba(245, 166, 35, 0.9)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.3} d={0.3} h={1.5}
        fillTop={SURFACE.woodTop} fillRight={SURFACE.woodRight} fillLeft={SURFACE.woodLeft} />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.2} d={0.2} h={2.4}
        fillTop="#1a2532" fillRight="#10171f" fillLeft="#15202b" />
      <IsoBox x={x + 0.05} y={y + 0.05} w={0.2} d={0.2} h={2.7}
        fillTop={accent} fillRight="#10171f" fillLeft="#15202b" />
    </>
  );
}

// ---------- Archive ----------

export function ArchiveWall({
  x, y, w = 4, h = 12,
}: { x: number; y: number; w?: number; h?: number }) {
  const cells: React.ReactNode[] = [];
  const cols = Math.floor(w / 0.5);
  const rows = 5;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      cells.push(
        <IsoBox key={`a${c}-${r}`}
          x={x + c * 0.5} y={y + 0.05 + r * 0.04} w={0.45} d={0.2} h={(h / rows) - 0.4}
          fillTop="#243140" fillRight="#15202b" fillLeft="#1a2532" />,
      );
    }
  }
  return (
    <>
      <IsoBox x={x} y={y} w={w} d={0.4} h={h}
        fillTop="#1a2532" fillRight="#10171f" fillLeft="#15202b" />
      {cells}
    </>
  );
}

export function Carousel({
  x, y,
}: { x: number; y: number }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.9} d={0.9} h={4.5}
        fillTop="#1a2532" fillRight="#10171f" fillLeft="#15202b" />
      <IsoBox x={x + 0.1} y={y + 0.1} w={0.7} d={0.7} h={5}
        fillTop="#243140" fillRight="#10171f" fillLeft="#15202b" />
      <IsoBox x={x + 0.4} y={y + 0.1} w={0.04} d={0.04} h={6}
        fillTop="#cdd5df" fillRight="#10171f" fillLeft="#15202b" />
    </>
  );
}

// ---------- Strategic / financial dashboards ----------

export function WarMap({
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

export function TokenMeter({
  x, y, accent = "rgba(196, 217, 67, 0.85)",
}: { x: number; y: number; accent?: string }) {
  return (
    <>
      <IsoBox x={x} y={y} w={0.9} d={0.1} h={3.6}
        fillTop="#1a2532" fillRight="#10171f" fillLeft="#15202b" />
      <IsoBox x={x + 0.05} y={y + 0.02} w={0.6} d={0.06} h={3.9}
        fillTop={accent} fillRight="#10171f" fillLeft="#15202b" />
    </>
  );
}

export function KpiPanel({
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
