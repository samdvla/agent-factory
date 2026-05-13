import type { ReactNode } from "react";
import {
  Armchair, Bookshelf, Cabinet, Clock, Desk, DeskPhone,
  FloorLightPool, FloorRect, Headset, Keyboard, LabBench, Laptop, LDesk,
  Microscope, Monitor, Mouse, Mug, OfficeChair, OvalTable, Papers, Pedestal,
  Plant, Printer3D, Rug, ServerRack, SideTable, Stool,
  TallPlant, Treadmill, UltraWide, WallScreen, YogaMat,
} from "./furnitureV2";
import { WallDecal, iso3, U } from "./primitives";

const CHAIR_R = 0.33; // half a 0.66-unit chair

/** Helper: an iso chair centered on a `(cx, cy)` floor point. */
function ChairAt({
  cx, cy, accent, face = "back-left",
}: {
  cx: number; cy: number; accent: string;
  face?: "back-left" | "back-right" | "front-left" | "front-right";
}) {
  return <OfficeChair x={cx - CHAIR_R} y={cy - CHAIR_R} color="#1a1c22" accent={accent} face={face} />;
}

// ────────────────── STRATEGY ROOM (bridge) ──────────────────
export function StrategyRoom({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <Clock wall="right" u={4.4} v={2.0} size={0.55} />
      <Rug x={0.84} y={0.84} w={3.84} d={3.84} color={accent} opacity={0.12} />
      <FloorLightPool x={2.88} y={2.4} rx={1.56} ry={1.08} color="#fff5d6" opacity={0.35} />
      {/* Back-row + west chairs render BEFORE the table so the table top
          paints over the parts of them that are behind it in iso depth.
          Front-row + east chair stay after the table. */}
      <OfficeChair x={1.74} y={0.84} color="#1a1c22" accent={accent} face="front-left" />
      <OfficeChair x={2.64} y={0.84} color="#1a1c22" accent={accent} face="front-left" />
      <OfficeChair x={3.54} y={0.84} color="#1a1c22" accent={accent} face="front-left" />
      <OfficeChair x={0.84} y={1.92} color="#1a1c22" accent={accent} face="front-right" />
      <OvalTable x={1.5} y={1.56} w={2.76} d={1.68} color="#b8855a" />
      <OfficeChair x={4.2} y={1.92} color="#1a1c22" accent={accent} face="back-right" />
      <OfficeChair x={1.74} y={3.36} color="#1a1c22" accent={accent} face="back-left" />
      <OfficeChair x={2.64} y={3.36} color="#1a1c22" accent={accent} face="back-left" />
      <OfficeChair x={3.54} y={3.36} color="#1a1c22" accent={accent} face="back-left" />
      <TallPlant x={4.92} y={4.92} color="#4f8a4f" />
      <Plant x={5.04} y={0.36} color="#5fa057" />
    </>
  );
}

// ────────────────── OPS BAY (ops) ──────────────────
// row layout, c=3 → stations at (1.93, 3.2), (3.0, 3.2), (4.07, 3.2)
export function OpsBay({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <ServerRack x={0.3} y={0.4} accent={accent} />
      <ServerRack x={1.2} y={0.4} accent={accent} />
      <WallScreen wall="right" u={1.0} v={1.55} w={2.4} h={1.05} accent={accent} content="world" color="#0d1320" />
      <TallPlant x={4.9} y={0.4} color="#3f8a4f" pot="#23262c" />
      <Rug x={1.2} y={2.5} w={3.6} d={2.0} color={accent} opacity={0.14} />
      <FloorLightPool x={3.0} y={3.4} rx={1.8} ry={1.1} color={accent} opacity={0.18} />
      <Desk x={1.43} y={1.9} w={3.14} d={0.9} color="#2e303a" />
      <UltraWide x={1.5} y={1.95} z={1.3} w={1.6} accent={accent} content="multi" />
      <Monitor x={3.3} y={1.95} z={1.3} w={0.9} accent={accent} content="list" />
      <Keyboard x={2.0} y={2.45} z={1.3} w={1.2} accent={accent} />
      <Mouse x={3.4} y={2.5} z={1.3} />
      <Mug x={1.6} y={2.45} z={1.3} drink="#5a3a24" />
      <ChairAt cx={1.93} cy={3.2} accent={accent} face="back-left" />
      <ChairAt cx={3.0} cy={3.2} accent={accent} face="back-left" />
      <ChairAt cx={4.07} cy={3.2} accent={accent} face="back-left" />
    </>
  );
}

// ────────────────── LISTING DESK (copy) ──────────────────
// row layout, c=2 → stations at (2.2, 3.2), (3.8, 3.2)
// Copywriter workspace, not a shipping bay — the back wall holds reference
// material (bookshelves + filing cabinet) and a single wide desk fronts
// the seats. Replaces the previous box-stack-heavy layout.
export function ListingDesk({ accent }: { accent: string }): ReactNode {
  return (
    <>
      {/* Back wall — style guides + filing */}
      <Bookshelf x={0.4} y={0.4} w={1.4} d={0.4} h={2.0} color="#a87a52" books={accent} />
      <Cabinet x={2.0} y={0.4} color="#d8d8df" />
      <Bookshelf x={3.0} y={0.4} w={1.4} d={0.4} h={2.0} color="#a87a52" books={accent} />
      <TallPlant x={5.0} y={0.4} color="#3f8a4f" />
      {/* Floor */}
      <Rug x={1.0} y={2.5} w={3.8} d={2.0} color={accent} opacity={0.16} />
      <FloorLightPool x={3.0} y={3.4} rx={1.8} ry={1.1} color="#fff5d6" opacity={0.3} />
      {/* Single wide writing desk — laptop on one side, monitor on the
          other so both seats have something to face. */}
      <Desk x={1.5} y={1.9} w={3.0} d={0.85} color="#d6b58a" />
      <Laptop x={1.78} y={2.05} z={1.32} accent={accent} />
      <Monitor x={3.4} y={1.95} z={1.32} w={0.95} accent={accent} content="list" />
      <Papers x={2.65} y={2.42} z={1.32} accent="#666" />
      <Mug x={1.7} y={2.4} z={1.32} drink="#b08252" />
      <ChairAt cx={2.2} cy={3.2} accent={accent} face="back-left" />
      <ChairAt cx={3.8} cy={3.2} accent={accent} face="back-left" />
      <TallPlant x={5.0} y={4.9} color="#3f8a4f" />
    </>
  );
}

// ────────────────── RESEARCH LAB (analyst / rd) ──────────────────
// analyst: row layout, c=2 → (2.2, 3.2), (3.8, 3.2)
// rd: central layout, c=1 → (1.7, 4.6)
// One consolidated workstation: a wide lab bench (microscopes + analysis
// monitor + laptop) replaces the old "bench at the back wall + duplicate
// desk in the middle" pair so the chairs sit at a single, real workspace.
// The back wall takes books + filing storage to keep the lab identity.
export function ResearchLab({ accent, layout }: { accent: string; layout: "row" | "central" }): ReactNode {
  return (
    <>
      <WallScreen wall="right" u={1.0} v={1.55} w={2.0} h={1.0} accent={accent} content="grid" />
      {/* Back wall — research storage in place of the old lab-bench row */}
      <Bookshelf x={0.4} y={0.4} w={1.4} d={0.4} h={2.0} color="#b89866" books={accent} />
      <Cabinet x={2.0} y={0.4} color="#d8d8df" />
      <Bookshelf x={3.0} y={0.4} w={1.4} d={0.4} h={2.0} color="#b89866" books={accent} />
      <TallPlant x={5.0} y={0.4} color="#3f8a4f" />
      {/* Floor zone */}
      <Rug x={0.9} y={2.5} w={4.0} d={2.0} color={accent} opacity={0.13} />
      <FloorLightPool x={3.0} y={3.4} rx={1.8} ry={1.1} color="#dff0f4" opacity={0.35} />
      {/* Primary (single) workstation — wide lab bench with microscopes,
          an analysis ultrawide, a laptop, and reference papers/mug. */}
      <LabBench x={1.0} y={1.9} w={4.0} color="#e6eaed" />
      <Microscope x={1.25} y={2.0} z={1.32} accent={accent} />
      <Laptop x={2.0} y={2.05} z={1.32} accent={accent} />
      <UltraWide x={2.7} y={1.95} z={1.32} w={1.4} accent={accent} content="multi" />
      <Microscope x={4.35} y={2.0} z={1.32} accent={accent} />
      <Papers x={3.05} y={2.45} z={1.32} accent="#444" />
      <Mug x={1.45} y={2.45} z={1.32} drink="#5a3a24" />
      {/* Seats facing the bench */}
      {layout === "row" ? (
        <>
          <ChairAt cx={2.2} cy={3.2} accent={accent} face="back-left" />
          <ChairAt cx={3.8} cy={3.2} accent={accent} face="back-left" />
        </>
      ) : (
        <ChairAt cx={3.0} cy={3.4} accent={accent} face="back-left" />
      )}
      <TallPlant x={5.0} y={4.9} color="#3f8a4f" />
    </>
  );
}

// ────────────────── CS BOOTH (comms) ──────────────────
// perimeter layout, c=4 → south=[(1.6,4.6),(2.7,4.6),(3.8,4.6),(4.7,4.6)]
export function CsBooth({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <WallScreen wall="right" u={1.0} v={1.55} w={2.4} h={1.0} accent={accent} content="grid" />
      <Desk x={0.4} y={0.6} w={1.0} d={2.6} color="#d6b58a" />
      <Monitor x={0.65} y={1.4} z={1.3} w={0.8} accent={accent} content="chart" face="+x" />
      <DeskPhone x={0.55} y={2.6} z={1.3} accent={accent} />
      <Headset x={0.55} y={0.7} z={1.3} accent={accent} />
      <Mug x={1.0} y={0.8} z={1.3} drink="#5a3a24" />
      <Rug x={1.8} y={3.4} w={3.0} d={1.6} color={accent} opacity={0.14} />
      <FloorLightPool x={3.3} y={4.4} rx={1.5} ry={0.9} color="#fff5d6" opacity={0.3} />
      <SideTable x={4.0} y={3.8} color="#b89866" />
      <Mug x={4.1} y={3.9} z={1.1} drink="#b08252" />
      <Armchair x={2.0} y={3.4} color="#bcc6d2" face="back-left" />
      <Armchair x={2.0} y={4.5} color="#bcc6d2" face="back-left" />
      <ChairAt cx={1.6} cy={4.6} accent={accent} face="back-left" />
      <ChairAt cx={2.7} cy={4.6} accent={accent} face="back-left" />
      <ChairAt cx={3.8} cy={4.6} accent={accent} face="back-left" />
      <ChairAt cx={4.7} cy={4.6} accent={accent} face="back-left" />
      <TallPlant x={5.0} y={0.4} color="#3f8a4f" />
      <Plant x={5.0} y={4.9} color="#4f9a5f" />
    </>
  );
}

// ────────────────── SELF-IMPROVEMENT (unused tag pool; reused for legal-style retreat) ──────────────────
export function SelfImprovementRoom({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <WallScreen wall="right" u={1.0} v={1.55} w={1.8} h={1.0} accent={accent} content="chart" />
      <Treadmill x={0.4} y={0.3} accent={accent} />
      <Bookshelf x={1.4} y={0.4} w={1.4} d={0.4} h={2.0} color="#a87a52" books={accent} />
      <TallPlant x={4.9} y={0.4} color="#4f9a5f" />
      <Rug x={1.5} y={2.4} w={3.0} d={2.4} color={accent} opacity={0.12} />
      <FloorLightPool x={2.6} y={3.4} rx={1.5} ry={1.0} color="#f5e8ff" opacity={0.35} />
      <YogaMat x={1.9} y={3.0} color={accent} />
      <Armchair x={4.0} y={1.6} color="#c8b8d8" face="back-right" />
      <SideTable x={4.1} y={2.6} color="#8a7560" />
      <Mug x={4.2} y={2.7} z={1.1} drink="#5a3a24" />
      <Stool x={3.4} y={4.4} color={accent} />
      <TallPlant x={5.0} y={4.9} color="#3f8a4f" />
    </>
  );
}

// ────────────────── RENDER STUDIO (dev) ──────────────────
// row, c=2 → (2.2, 3.2), (3.8, 3.2)
export function RenderStudio({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <ServerRack x={0.3} y={0.4} accent={accent} />
      <ServerRack x={1.1} y={0.4} accent={accent} />
      <ServerRack x={1.9} y={0.4} accent={accent} />
      <ServerRack x={2.7} y={0.4} accent={accent} />
      <WallScreen wall="right" u={1.0} v={1.55} w={2.4} h={1.05} accent={accent} content="grid" color="#0a0d12" />
      <TallPlant x={4.9} y={0.4} color="#3f8a4f" />
      <Rug x={1.2} y={2.6} w={3.6} d={2.0} color={accent} opacity={0.12} />
      <FloorLightPool x={3.0} y={3.4} rx={1.7} ry={1.1} color={accent} opacity={0.16} />
      <Desk x={1.5} y={1.9} w={2.8} d={0.95} color="#23262c" />
      <UltraWide x={1.55} y={1.95} z={1.3} w={2.0} accent={accent} content="design" />
      <Keyboard x={2.0} y={2.5} z={1.3} w={1.3} accent={accent} />
      <Mouse x={3.4} y={2.55} z={1.3} />
      <Mug x={1.6} y={2.5} z={1.3} drink="#5a3a24" />
      <ChairAt cx={2.2} cy={3.2} accent={accent} face="back-left" />
      <ChairAt cx={3.8} cy={3.2} accent={accent} face="back-left" />
      <TallPlant x={5.0} y={4.9} color="#3f8a4f" />
    </>
  );
}

// ────────────────── DESIGN STUDIO (creative) ──────────────────
// central, c=1 → (1.7, 4.6)
export function DesignStudio({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <Printer3D x={0.3} y={0.3} accent={accent} />
      <Printer3D x={1.3} y={0.3} accent={accent} />
      <Cabinet x={2.4} y={0.4} color="#e2d8e8" />
      <Rug x={1.2} y={2.4} w={3.6} d={2.0} color={accent} opacity={0.13} />
      <FloorLightPool x={3.0} y={3.4} rx={1.6} ry={1.1} color="#fff5d6" opacity={0.32} />
      <LDesk x={1.5} y={1.7} color="#d6b58a" />
      <Laptop x={1.7} y={1.85} z={1.3} accent={accent} />
      <Monitor x={2.8} y={1.85} z={1.3} w={0.95} accent={accent} content="design" />
      <Papers x={2.55} y={2.35} z={1.32} accent={accent} />
      <Mug x={1.7} y={2.4} z={1.3} drink="#5a3a24" />
      <ChairAt cx={3.0} cy={3.4} accent={accent} face="back-left" />
      <Pedestal x={0.4} y={4.0} accent={accent} display="sphere" color="#f5ecf0" />
      <Pedestal x={1.4} y={4.0} accent={accent} display="vase" color="#f5ecf0" />
      <Pedestal x={4.5} y={4.0} accent={accent} display="figure" color="#f5ecf0" />
      <TallPlant x={5.0} y={0.4} color="#3f8a4f" />
    </>
  );
}

// ────────────────── FINANCE (custom) ──────────────────
// central layout, c=1 → (1.7, 4.6) or (4.3, 4.6)
export function FinanceRoom({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <WallScreen wall="right" u={1.0} v={1.55} w={2.4} h={1.0} accent={accent} content="chart" />
      <Cabinet x={0.4} y={0.4} color="#d2d4dc" w={0.84} d={0.6} h={1.6} />
      <Cabinet x={1.3} y={0.4} color="#d2d4dc" w={0.84} d={0.6} h={1.6} />
      <Bookshelf x={4.2} y={0.4} w={1.2} d={0.4} h={2.0} color="#a87a52" books={accent} />
      <Rug x={1.4} y={2.2} w={3.2} d={2.4} color={accent} opacity={0.13} />
      <FloorLightPool x={3.0} y={3.3} rx={1.6} ry={1.1} color="#fff5d6" opacity={0.32} />
      <Desk x={1.9} y={2.4} w={2.4} d={1.0} color="#23262c" />
      <Monitor x={2.05} y={2.5} z={1.3} w={1.0} accent={accent} content="chart" />
      <Monitor x={3.15} y={2.5} z={1.3} w={1.0} accent={accent} content="list" />
      <Papers x={2.5} y={3.1} z={1.32} accent="#666" />
      <Mug x={1.95} y={3.05} z={1.3} drink="#5a3a24" />
      <ChairAt cx={3.0} cy={3.4} accent={accent} face="back-left" />
      <TallPlant x={5.0} y={0.4} color="#3f8a4f" />
      <Plant x={5.0} y={4.9} color="#5fa057" />
    </>
  );
}

// ────────────────── LEGAL (custom) ──────────────────
// row, c=2 → (2.2, 3.2), (3.8, 3.2)
export function LegalRoom({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <Bookshelf x={0.3} y={0.4} w={1.4} d={0.4} h={2.2} color="#8a5a3a" books="#1f2c3d" />
      <Bookshelf x={1.8} y={0.4} w={1.4} d={0.4} h={2.2} color="#8a5a3a" books="#5a1c1c" />
      <Bookshelf x={3.3} y={0.4} w={1.4} d={0.4} h={2.2} color="#8a5a3a" books="#3a2c1c" />
      <Cabinet x={4.85} y={0.4} color="#d2d4dc" w={0.84} d={0.6} h={1.6} />
      <Rug x={1.2} y={2.6} w={3.6} d={2.0} color={accent} opacity={0.12} />
      <FloorLightPool x={3.0} y={3.4} rx={1.6} ry={1.0} color="#fff5d6" opacity={0.3} />
      <Desk x={1.6} y={1.9} w={1.4} d={0.85} color="#a06b3c" />
      <Desk x={3.1} y={1.9} w={1.4} d={0.85} color="#a06b3c" />
      <Laptop x={1.78} y={2.05} z={1.3} accent={accent} />
      <Monitor x={3.3} y={1.95} z={1.3} w={0.95} accent={accent} content="code" />
      <Papers x={2.4} y={2.4} z={1.34} accent="#444" />
      <Mug x={1.7} y={2.4} z={1.3} drink="#5a3a24" />
      <ChairAt cx={2.2} cy={3.2} accent={accent} face="back-left" />
      <ChairAt cx={3.8} cy={3.2} accent={accent} face="back-left" />
      <Plant x={5.0} y={4.9} color="#4f9a5f" />
    </>
  );
}

// ────────────────── ARCHIVE (custom) ──────────────────
// perimeter layout, c=1 → (1.6, 4.6) (first south position)
export function ArchiveRoom({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <Bookshelf x={0.3} y={0.4} w={1.2} d={0.4} h={2.4} color="#a47a4a" books={accent} />
      <Bookshelf x={1.6} y={0.4} w={1.2} d={0.4} h={2.4} color="#a47a4a" books="#5a3a24" />
      <Bookshelf x={2.9} y={0.4} w={1.2} d={0.4} h={2.4} color="#a47a4a" books="#3a4a78" />
      <Bookshelf x={4.2} y={0.4} w={1.2} d={0.4} h={2.4} color="#a47a4a" books={accent} />
      <FloorRect x={1.0} y={1.5} w={4.0} d={0.1} color="rgba(0,0,0,0.18)" />
      <Bookshelf x={0.3} y={2.4} w={0.4} d={1.6} h={2.0} color="#a47a4a" books={accent} />
      <Bookshelf x={5.3} y={2.4} w={0.4} d={1.6} h={2.0} color="#a47a4a" books="#5a3a24" />
      <Rug x={1.6} y={3.6} w={2.8} d={1.2} color={accent} opacity={0.12} />
      <FloorLightPool x={3.0} y={4.2} rx={1.5} ry={0.9} color="#fff5d6" opacity={0.28} />
      <Desk x={2.5} y={3.6} w={1.4} d={0.8} color="#a06b3c" />
      <Laptop x={2.7} y={3.7} z={1.3} accent={accent} />
      <Papers x={3.4} y={4.0} z={1.32} accent="#666" />
      <Mug x={2.6} y={4.0} z={1.3} drink="#5a3a24" />
      <ChairAt cx={1.6} cy={4.6} accent={accent} face="back-left" />
    </>
  );
}

// ────────────────── MARKETING STUDIO (marketing) ──────────────────
// row, c=2 → (2.2, 3.2), (3.8, 3.2)
// Content-creator loft: corkboard with pinned Pinterest-style tiles on the
// SIDE wall (back wall stays clear so the room-title plaque can read), a
// small trending-analytics monitor low on the back wall, a ring light on
// a tripod, and two creator desks with phones + laptops. Reads as a
// social-media production room rather than an office.
export function MarketingStudio({ accent }: { accent: string }): ReactNode {
  // Pinterest-style pin tiles: staggered masonry of coral/cream/accent
  // cards on a tan corkboard. Sized to fit on the side wall (5 U deep,
  // 2.8 U tall) without intruding into the title-plaque area.
  const board = {
    width: 3.0,   // U-units along the wall
    height: 1.35, // U-units tall
  };
  const cardColors = [accent, "#fff1e6", "#ffd2c2", accent, "#fdeadd", "#ffb8a8"];
  // Each tile: [u-offset, v-offset, w, h] in U units relative to the
  // board's bottom-left corner. Staggered to evoke a Pinterest masonry feed.
  const tiles: Array<[number, number, number, number]> = [
    [0.12, 0.15, 0.62, 0.85],
    [0.84, 0.15, 0.62, 0.50],
    [0.84, 0.75, 0.62, 0.25],
    [1.56, 0.15, 0.62, 0.35],
    [1.56, 0.60, 0.62, 0.40],
    [2.28, 0.15, 0.60, 0.85],
  ];

  return (
    <>
      {/* Corkboard with Pinterest pin tiles on the SIDE wall (well clear of
          the back-wall title plaque). The mirror transform matches the
          orientation other rooms use for right-wall decals. */}
      <WallDecal wall="right" u={0.6} v={1.0}>
        <g transform="scale(-1, 1)">
          {/* Board frame (warm cork brown) + face (tan cork) */}
          <rect x={-4} y={4} width={board.width * U + 8} height={-(board.height * U + 8)} fill="#6b3f1f" rx={3} />
          <rect x={0} y={0} width={board.width * U} height={-board.height * U} fill="#cf9866" rx={2} />
          {/* Subtle horizontal tan banding to read as cork texture */}
          {[0.25, 0.5, 0.75].map((p, i) => (
            <line
              key={`cork-${i}`}
              x1={2}
              x2={board.width * U - 2}
              y1={-board.height * U * p}
              y2={-board.height * U * p}
              stroke="#a8754a"
              strokeOpacity={0.35}
              strokeWidth={0.8}
            />
          ))}
          {/* Pin tiles + pushpin dot per tile */}
          {tiles.map(([uo, vo, w, h], i) => {
            const x = uo * U;
            const y = -(vo + h) * U;
            const ww = w * U;
            const hh = h * U;
            return (
              <g key={`pin-${i}`}>
                {/* Card shadow */}
                <rect x={x + 1.2} y={y + 1.6} width={ww} height={hh} fill="#000" fillOpacity={0.22} rx={1.4} />
                {/* Card body */}
                <rect x={x} y={y} width={ww} height={hh} fill={cardColors[i % cardColors.length]} rx={1.4} />
                {/* Subtle inner highlight on the card top edge */}
                <rect
                  x={x + 1}
                  y={y + 1}
                  width={ww - 2}
                  height={Math.min(3, hh * 0.18)}
                  fill="rgba(255,255,255,0.32)"
                  rx={1}
                />
                {/* Pushpin head — coral dot at the top center */}
                <circle cx={x + ww / 2} cy={y - 1.4} r={1.6} fill={accent} stroke="#3a1408" strokeWidth={0.4} />
                <circle cx={x + ww / 2 - 0.4} cy={y - 1.8} r={0.5} fill="#fff" opacity={0.7} />
              </g>
            );
          })}
        </g>
      </WallDecal>

      {/* Small trending-analytics screen LOW on the back wall, off to the
          right so it clears the bookshelf at low u and stays well below
          the title plaque (which sits high-center on the back wall). */}
      <WallScreen wall="left" u={2.6} v={0.45} w={1.7} h={0.85} accent={accent} content="chart" />

      {/* Floor — warm coral rug + cream light pool */}
      <Rug x={1.0} y={2.5} w={4.0} d={2.0} color={accent} opacity={0.16} />
      <FloorLightPool x={3.0} y={3.4} rx={1.9} ry={1.15} color="#ffe7d2" opacity={0.36} />

      {/* Magazine / lookbook rack on the back-left (looks like a stack of
          colorful trend-binders / mood-board references). */}
      <Bookshelf x={0.4} y={0.4} w={1.05} d={0.4} h={1.55} color="#c9805f" books="#fff1e6" />

      {/* Floor "branding shelf" — a tiny pedestal with a single ornament,
          stand-in for product props the marketing team styles. */}
      <Pedestal x={4.4} y={4.1} accent={accent} display="vase" color="#fff1e6" />

      {/* Wide shared content-creator desk for both stations */}
      <Desk x={1.4} y={1.9} w={3.2} d={0.9} color="#b8855a" />

      {/* Left station — laptop, phone-mock + mug */}
      <Laptop x={1.7} y={2.05} z={1.32} accent={accent} />
      <PhoneMock x={2.4} y={2.42} accent={accent} content="feed" />
      <Mug x={1.7} y={2.42} z={1.3} drink="#b08252" />

      {/* Right station — laptop, phone-mock + papers (storyboard) */}
      <Laptop x={3.4} y={2.05} z={1.32} accent={accent} />
      <PhoneMock x={4.1} y={2.42} accent={accent} content="story" />
      <Papers x={3.0} y={2.4} z={1.34} accent={accent} />

      {/* Ring light on a tripod — the signature content-creator prop */}
      <RingLight x={0.55} y={3.4} accent={accent} />

      {/* Seats facing the desk */}
      <ChairAt cx={2.2} cy={3.2} accent={accent} face="back-left" />
      <ChairAt cx={3.8} cy={3.2} accent={accent} face="back-left" />

      {/* Plants */}
      <TallPlant x={5.0} y={0.4} color="#3f8a4f" />
      <Plant x={5.0} y={4.9} color="#4f9a5f" />
    </>
  );
}

/**
 * Smartphone laid flat on a desk surface. Drawn in iso world space —
 * `(x, y)` is the floor footprint corner, `z` is the desk height. Width
 * `w` runs along x. The screen face shows either a vertical feed (rows of
 * pin-tiles) or a story carousel (single hero card). Marketing-specific
 * prop — feels like a Pinterest/TikTok preview rather than a desk phone.
 */
function PhoneMock({
  x, y, z = 1.31, w = 0.34, d = 0.7, accent, content = "feed",
}: {
  x: number; y: number; z?: number; w?: number; d?: number;
  accent: string; content?: "feed" | "story";
}) {
  const A = iso3(x, y, z);
  const B = iso3(x + w, y, z);
  const C = iso3(x + w, y + d, z);
  const D = iso3(x, y + d, z);
  const pts = `${A.x},${A.y} ${B.x},${B.y} ${C.x},${C.y} ${D.x},${D.y}`;
  // Bezel + inset screen — inset by 4% on every side
  const inset = 0.04;
  const A2 = iso3(x + w * inset, y + d * inset, z + 0.001);
  const B2 = iso3(x + w * (1 - inset), y + d * inset, z + 0.001);
  const C2 = iso3(x + w * (1 - inset), y + d * (1 - inset), z + 0.001);
  const D2 = iso3(x + w * inset, y + d * (1 - inset), z + 0.001);
  const pts2 = `${A2.x},${A2.y} ${B2.x},${B2.y} ${C2.x},${C2.y} ${D2.x},${D2.y}`;
  // Project a few content tile corners directly so they sit flat on the
  // screen plane. For "feed": three small rows of tiles. For "story":
  // one big hero rectangle with a play icon.
  const feedRows = 3;
  const feedCols = 2;
  const cells: ReactNode[] = [];
  if (content === "feed") {
    for (let r = 0; r < feedRows; r++) {
      for (let c = 0; c < feedCols; c++) {
        const u0 = inset + 0.04 + c * ((1 - 2 * inset - 0.08) / feedCols);
        const u1 = u0 + ((1 - 2 * inset - 0.08) / feedCols) - 0.03;
        const v0 = inset + 0.05 + r * ((1 - 2 * inset - 0.1) / feedRows);
        const v1 = v0 + ((1 - 2 * inset - 0.1) / feedRows) - 0.03;
        const P1 = iso3(x + w * u0, y + d * v0, z + 0.002);
        const P2 = iso3(x + w * u1, y + d * v0, z + 0.002);
        const P3 = iso3(x + w * u1, y + d * v1, z + 0.002);
        const P4 = iso3(x + w * u0, y + d * v1, z + 0.002);
        const fill = (r + c) % 2 === 0 ? accent : "#fff1e6";
        cells.push(
          <polygon
            key={`cell-${r}-${c}`}
            points={`${P1.x},${P1.y} ${P2.x},${P2.y} ${P3.x},${P3.y} ${P4.x},${P4.y}`}
            fill={fill}
            fillOpacity={0.85}
          />,
        );
      }
    }
  } else {
    const u0 = inset + 0.06, u1 = 1 - inset - 0.06;
    const v0 = inset + 0.18, v1 = 1 - inset - 0.18;
    const P1 = iso3(x + w * u0, y + d * v0, z + 0.002);
    const P2 = iso3(x + w * u1, y + d * v0, z + 0.002);
    const P3 = iso3(x + w * u1, y + d * v1, z + 0.002);
    const P4 = iso3(x + w * u0, y + d * v1, z + 0.002);
    cells.push(
      <polygon
        key="hero"
        points={`${P1.x},${P1.y} ${P2.x},${P2.y} ${P3.x},${P3.y} ${P4.x},${P4.y}`}
        fill={accent}
        fillOpacity={0.85}
      />,
    );
    // Tiny play triangle in the middle
    const PT = iso3(x + w * 0.5, y + d * 0.5, z + 0.003);
    cells.push(
      <polygon
        key="play"
        points={`${PT.x - 2.4},${PT.y - 3} ${PT.x - 2.4},${PT.y + 3} ${PT.x + 2.8},${PT.y}`}
        fill="#fff1e6"
      />,
    );
  }
  return (
    <g>
      {/* Phone body — near-black bezel */}
      <polygon points={pts} fill="#10131a" stroke="#2a2f3a" strokeWidth={0.4} />
      {/* Screen background */}
      <polygon points={pts2} fill="#1a1f2a" />
      {cells}
    </g>
  );
}

/**
 * Vertical ring-light on a tripod — content-creator signature prop. The
 * ring sits at face height, glowing with the room accent so it reads as
 * "live". Tripod legs splay out for a stable iso silhouette.
 */
function RingLight({ x, y, accent }: { x: number; y: number; accent: string }) {
  // Footprint of the tripod feet (small triangle around x,y)
  const fA = iso3(x - 0.18, y + 0.12, 0);
  const fB = iso3(x + 0.18, y + 0.12, 0);
  const fC = iso3(x, y - 0.18, 0);
  // Center pole base + top
  const base = iso3(x, y, 0);
  const top = iso3(x, y, 1.75);
  // Ring center — slightly above the top of the pole and tilted to face
  // the desk (we use a simple ellipse in screen space — it reads as a tilted
  // ring at this scale).
  const ringR = U * 0.55;
  const ringCx = top.x;
  const ringCy = top.y - U * 0.18;
  return (
    <g>
      {/* Tripod legs from feet to base */}
      <line x1={fA.x} y1={fA.y} x2={base.x} y2={base.y} stroke="#1a1c22" strokeWidth={1.4} strokeLinecap="round" />
      <line x1={fB.x} y1={fB.y} x2={base.x} y2={base.y} stroke="#1a1c22" strokeWidth={1.4} strokeLinecap="round" />
      <line x1={fC.x} y1={fC.y} x2={base.x} y2={base.y} stroke="#1a1c22" strokeWidth={1.4} strokeLinecap="round" />
      {/* Tiny feet caps */}
      <circle cx={fA.x} cy={fA.y} r={1.2} fill="#1a1c22" />
      <circle cx={fB.x} cy={fB.y} r={1.2} fill="#1a1c22" />
      <circle cx={fC.x} cy={fC.y} r={1.2} fill="#1a1c22" />
      {/* Vertical pole */}
      <line x1={base.x} y1={base.y} x2={top.x} y2={top.y} stroke="#1a1c22" strokeWidth={1.8} strokeLinecap="round" />
      {/* Soft halo behind the ring */}
      <ellipse cx={ringCx} cy={ringCy} rx={ringR * 1.4} ry={ringR * 0.55} fill={accent} fillOpacity={0.18} />
      {/* Ring — outer rim + inner cutout */}
      <ellipse cx={ringCx} cy={ringCy} rx={ringR} ry={ringR * 0.38} fill="none" stroke="#1a1c22" strokeWidth={2.6} />
      <ellipse cx={ringCx} cy={ringCy} rx={ringR - 1.6} ry={ringR * 0.38 - 0.9} fill="none" stroke={accent} strokeWidth={2.4} opacity={0.95}>
        <animate attributeName="opacity" values="0.6;1;0.6" dur="2.8s" repeatCount="indefinite" />
      </ellipse>
      {/* Highlight glint on the top-left of the ring */}
      <ellipse cx={ringCx - ringR * 0.4} cy={ringCy - ringR * 0.18} rx={ringR * 0.25} ry={ringR * 0.08} fill="#fff" opacity={0.55} />
    </g>
  );
}
