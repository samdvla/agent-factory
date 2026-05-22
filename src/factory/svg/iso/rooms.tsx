import type { ReactNode } from "react";
import {
  Armchair, Bookshelf, Cabinet, Clock, Desk, DeskPhone,
  FloorLightPool, FloorRect, Headset, Keyboard, LabBench, Laptop, LDesk,
  Microscope, Monitor, Mouse, Mug, OfficeChair, OvalTable, Papers, Pedestal,
  Plant, Printer3D, Rug, ServerRack, SideTable, Stool,
  TallPlant, Treadmill, UltraWide, WallScreen, YogaMat,
} from "./furnitureV2";
import { Box, Cylinder, Sphere, WallDecal, iso3, U } from "./primitives";

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

// ═══════════════════════════════════════════════════════════════════════════
//  DESIGNER-WING SPECIALIST ROOMS
//
//  Seven small employee desks that work UNDER the lead designer (Mara Chen
//  in the Design Studio). Each occupies the same 6×6 cell as a boss room
//  but uses a smaller inset working footprint (the SmallFootprint pad below)
//  so the visual reads as "employee cubicle" rather than "executive office".
//  Each room ships niche-specific props the lead designer hands a brief
//  to: katana wall + manga shelf (anime), cape mannequin + comic shelf
//  (hero), gantry + servo bench (mecha), plush bin + ribbon spool (chibi),
//  altar + obelisk (deity), bone shelf + scaled hide (creature), shield
//  rack + sword cabinet (humanoid).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inset pad used by every specialist room — it visually "shrinks" the work
 * area inside the 6×6 cell to about 4×4 by drawing a recessed floor tile,
 * a smaller rug, and a soft pendant pool. The wider unused border around
 * it reads as "this person has less floor than the boss has".
 */
function SmallFootprint({ accent, glow = "#fff5d6" }: { accent: string; glow?: string }) {
  return (
    <>
      {/* Recessed floor tile (subtle dark border around the work area) */}
      <FloorRect x={0.9} y={0.9} w={4.2} d={4.2} color="#000" opacity={0.10} />
      <FloorRect x={1.0} y={1.0} w={4.0} d={4.0} color="#000" opacity={0.04} />
      <Rug x={1.6} y={2.7} w={2.8} d={1.5} color={accent} opacity={0.18} />
      <FloorLightPool x={3.0} y={3.2} rx={1.35} ry={0.85} color={glow} opacity={0.30} />
    </>
  );
}

// ────────────────── ANIME STYLIST (anime_studio) ──────────────────
// Niche props: a katana on a wall rack, a manga-volume bookshelf, a stack
// of cel-stylization color references, a wacom-style drafting tablet.
export function AnimeStudio({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <SmallFootprint accent={accent} glow="#ffeaf2" />
      {/* Back wall — manga volume bookshelf in a hot-pink-spined run. */}
      <Bookshelf x={0.4} y={0.4} w={1.6} d={0.4} h={1.9} color="#2a1a2a" books={accent} />
      {/* Katana mounted on the right wall (two-bar wooden rack with a
          single sheathed blade across it). Drawn as a wall decal so it
          sticks to the right plane in iso. */}
      <WallDecal wall="right" u={1.6} v={1.05}>
        <g transform="scale(-1, 1)">
          {/* Mount bars */}
          <rect x={0} y={-2} width={70} height={3} fill="#4a2a1a" rx={1} />
          <rect x={0} y={-22} width={70} height={3} fill="#4a2a1a" rx={1} />
          {/* Sheath (dark) */}
          <rect x={2} y={-12} width={66} height={6} fill="#101015" rx={1} />
          {/* Tsuba (guard) + handle wrap */}
          <rect x={4} y={-13} width={4} height={8} fill={accent} />
          <rect x={8} y={-12} width={14} height={6} fill="#1a1a22" />
          <line x1={10} y1={-12} x2={10} y2={-6} stroke={accent} strokeWidth={0.6} opacity={0.7} />
          <line x1={14} y1={-12} x2={14} y2={-6} stroke={accent} strokeWidth={0.6} opacity={0.7} />
          <line x1={18} y1={-12} x2={18} y2={-6} stroke={accent} strokeWidth={0.6} opacity={0.7} />
        </g>
      </WallDecal>
      {/* Cel-art reference moodboard above the desk (small framed swatches) */}
      <WallDecal wall="left" u={2.6} v={0.45}>
        <rect x={0} y={-40} width={70} height={32} fill="#2a1a2a" rx={2} />
        {[0, 22, 44].map((dx, i) => (
          <rect
            key={i}
            x={dx + 6}
            y={-36}
            width={16}
            height={24}
            fill={["#ff7fb3", "#ffd1dc", accent][i]}
            stroke="#fff"
            strokeWidth={0.5}
          />
        ))}
      </WallDecal>
      <Desk x={1.6} y={1.9} w={2.5} d={0.85} color="#2a1a2a" />
      <Monitor x={1.85} y={1.95} z={1.32} w={0.9} accent={accent} content="design" />
      <Laptop x={3.0} y={2.05} z={1.32} accent={accent} />
      {/* Drafting tablet front-and-center on the desk — small dark slab
          with a glowing stylus line. */}
      <Box x={2.45} y={2.42} z={1.32} w={0.7} d={0.45} h={0.04} color="#10101a" />
      <Box x={2.65} y={2.5}  z={1.36} w={0.06} d={0.28} h={0.02} color={accent} />
      <Mug x={1.7} y={2.4} z={1.3} drink="#ff7fb3" />
      <Papers x={2.95} y={2.45} z={1.34} accent={accent} />
      {/* Floor pedestal — finished anime figurine on display. */}
      <Pedestal x={4.4} y={4.1} accent={accent} display="figure" color="#fff1f6" />
      <ChairAt cx={3.0} cy={3.4} accent={accent} face="back-left" />
      <TallPlant x={5.0} y={0.4} color="#5fa057" />
    </>
  );
}

// ────────────────── HERO STUDIO (hero_studio) ──────────────────
// Niche props: a cape on a mannequin stand, a comic-book shelf, a small
// action-figure pedestal, primary-color reference panels.
export function HeroStudio({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <SmallFootprint accent={accent} glow="#e5ebff" />
      {/* Back wall — comic book shelf (taller, thinner spines in a primary mix). */}
      <Bookshelf x={0.4} y={0.4} w={1.4} d={0.4} h={2.0} color="#1a2440" books="#ffd23f" />
      {/* Primary-color reference panel on the side wall — three big
          color-block swatches that read as a "hero palette" chart. */}
      <WallDecal wall="right" u={1.4} v={1.05}>
        <g transform="scale(-1, 1)">
          <rect x={0} y={-32} width={66} height={28} fill="#101220" rx={2} />
          <rect x={4}  y={-28} width={18} height={20} fill="#e63946" />
          <rect x={24} y={-28} width={18} height={20} fill={accent} />
          <rect x={44} y={-28} width={18} height={20} fill="#ffd23f" />
        </g>
      </WallDecal>
      {/* Cape mannequin — a torso stand with a draped cape flaring out
          behind. Hero-defining silhouette prop. */}
      <g>
        {/* Mannequin base (small disc) */}
        <Cylinder x={4.5} y={0.7} r={0.3} h={0.08} color="#1a1c22" />
        {/* Vertical pole */}
        <Box x={4.475} y={0.675} z={0.08} w={0.05} d={0.05} h={1.0} color="#1a1c22" />
        {/* Torso block (cape shoulders) */}
        <Box x={4.32} y={0.55}  z={1.08} w={0.4} d={0.3} h={0.5} color="#202028" />
        {/* Cape — a long polygon hanging from the shoulders. Drawn as a
            free polygon in iso world coordinates to read as fabric. */}
        {(() => {
          const top = iso3(4.32, 0.55, 1.58);
          const topR = iso3(4.72, 0.55, 1.58);
          const bot = iso3(4.05, 1.05, 0.08);
          const botR = iso3(4.95, 1.05, 0.08);
          const accentDark = accent;
          return (
            <>
              <polygon
                points={`${top.x},${top.y} ${topR.x},${topR.y} ${botR.x},${botR.y} ${bot.x},${bot.y}`}
                fill={accentDark}
              />
              {/* Inner cape lining (lighter line for fabric fold) */}
              <line x1={(top.x + topR.x) / 2} y1={(top.y + topR.y) / 2} x2={(bot.x + botR.x) / 2} y2={(bot.y + botR.y) / 2} stroke="#fff" strokeOpacity={0.18} strokeWidth={0.6} />
              {/* Hero crest on the shoulders — small star */}
              <polygon
                points={`${top.x + (topR.x - top.x) * 0.5},${top.y + 4}
                         ${top.x + (topR.x - top.x) * 0.6},${top.y + 9}
                         ${top.x + (topR.x - top.x) * 0.85},${top.y + 9}
                         ${top.x + (topR.x - top.x) * 0.65},${top.y + 13}
                         ${top.x + (topR.x - top.x) * 0.75},${top.y + 18}
                         ${top.x + (topR.x - top.x) * 0.5},${top.y + 15}
                         ${top.x + (topR.x - top.x) * 0.25},${top.y + 18}
                         ${top.x + (topR.x - top.x) * 0.35},${top.y + 13}
                         ${top.x + (topR.x - top.x) * 0.15},${top.y + 9}
                         ${top.x + (topR.x - top.x) * 0.4},${top.y + 9}`}
                fill="#ffd23f"
              />
            </>
          );
        })()}
      </g>
      <Desk x={1.6} y={1.9} w={2.5} d={0.85} color="#202028" />
      <UltraWide x={1.7} y={1.95} z={1.32} w={1.6} accent={accent} content="design" />
      <Keyboard x={2.0} y={2.45} z={1.32} w={1.2} accent={accent} />
      <Mug x={1.7} y={2.4} z={1.32} drink="#5a3a24" />
      <Papers x={3.5} y={2.45} z={1.34} accent="#e63946" />
      {/* Action-figure pedestal — finished superhero mini under a spotlight. */}
      <Pedestal x={0.4} y={4.0} accent={accent} display="figure" color="#fff1e6" />
      <ChairAt cx={3.0} cy={3.4} accent={accent} face="back-left" />
      <Plant x={5.0} y={4.9} color="#4f9a5f" />
    </>
  );
}

// ────────────────── MECHA BAY (mecha_bay) ──────────────────
// Niche props: a small overhead gantry, a robot torso WIP, panel
// servos on a bench, a parts cabinet with industrial orange caution
// stripes, blueprint tube rack.
export function MechaBay({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <SmallFootprint accent={accent} glow="#ffe2c5" />
      {/* Caution-stripe parts cabinet on the back-left. */}
      <Cabinet x={0.4} y={0.4} color="#2a2c30" w={0.84} d={0.6} h={1.6} />
      {/* Three stacked caution stripes painted across the cabinet front */}
      {[0.6, 1.0, 1.4].map((cz, i) => {
        const a = iso3(0.4, 0.4, cz);
        const b = iso3(1.24, 0.4, cz);
        return (
          <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={accent} strokeWidth={1.6} opacity={0.85} />
        );
      })}
      {/* Server-rack stand-in for the industrial backdrop. */}
      <ServerRack x={1.4} y={0.4} accent={accent} />
      {/* Blueprint tube rack on the right wall — three rolled tubes leaning. */}
      <WallDecal wall="right" u={2.6} v={0.45}>
        <g transform="scale(-1, 1)">
          {[0, 7, 14].map((dx, i) => (
            <g key={i}>
              <rect x={dx + 4} y={-32} width={4} height={32} fill="#bda57a" rx={1.5} />
              <rect x={dx + 4} y={-32} width={4} height={4} fill={accent} rx={1.5} />
            </g>
          ))}
        </g>
      </WallDecal>
      {/* Gantry crane — H-shaped beam crossing the bay overhead, with a
          hook hanging from the center. Drawn as 3 thin boxes at z=2.0. */}
      {(() => {
        const beamZ = 2.0;
        const lA = iso3(1.0, 1.4, beamZ);
        const lB = iso3(5.0, 1.4, beamZ);
        const lC = iso3(1.0, 1.4, beamZ - 0.16);
        const lD = iso3(5.0, 1.4, beamZ - 0.16);
        const lE = iso3(1.0, 1.4, 0);
        const lF = iso3(5.0, 1.4, 0);
        return (
          <g>
            {/* Posts (left + right) */}
            <line x1={lA.x} y1={lA.y} x2={lE.x} y2={lE.y} stroke="#3a3c40" strokeWidth={2.4} />
            <line x1={lB.x} y1={lB.y} x2={lF.x} y2={lF.y} stroke="#3a3c40" strokeWidth={2.4} />
            {/* Beam */}
            <polygon points={`${lA.x},${lA.y} ${lB.x},${lB.y} ${lD.x},${lD.y} ${lC.x},${lC.y}`} fill="#5a5c60" />
            <line x1={lA.x} y1={lA.y} x2={lB.x} y2={lB.y} stroke={accent} strokeWidth={0.8} />
            {/* Hook — vertical wire + claw */}
            {(() => {
              const mid = iso3(3.0, 1.4, beamZ - 0.16);
              const hook = iso3(3.0, 1.4, 1.3);
              return (
                <g>
                  <line x1={mid.x} y1={mid.y} x2={hook.x} y2={hook.y} stroke="#1a1c22" strokeWidth={1.6} />
                  <circle cx={hook.x} cy={hook.y} r={2.6} fill="none" stroke="#1a1c22" strokeWidth={1.6} />
                </g>
              );
            })()}
          </g>
        );
      })()}
      {/* Robot torso WIP sitting under the gantry — chest block with
          shoulder pauldrons and panel lines. */}
      <Box x={2.7} y={1.8}  z={0.0} w={0.6} d={0.6} h={0.8}
        color="#42464c" colors={{ top: "#5a5e64", left: "#2a2c30", right: "#3a3c40" }} />
      <Box x={2.55} y={1.95} z={0.7} w={0.18} d={0.32} h={0.18} color="#2a2c30" />
      <Box x={3.27} y={1.95} z={0.7} w={0.18} d={0.32} h={0.18} color="#2a2c30" />
      {/* Glow eyes painted on a small face plate */}
      {(() => {
        const eye1 = iso3(2.88, 1.78, 0.65);
        const eye2 = iso3(3.12, 1.78, 0.65);
        return (
          <g>
            <circle cx={eye1.x} cy={eye1.y} r={1.0} fill={accent} />
            <circle cx={eye2.x} cy={eye2.y} r={1.0} fill={accent} />
            <circle cx={eye1.x} cy={eye1.y} r={1.6} fill={accent} fillOpacity={0.25} />
            <circle cx={eye2.x} cy={eye2.y} r={1.6} fill={accent} fillOpacity={0.25} />
          </g>
        );
      })()}
      {/* Work desk — engineer's CAD station with monitor + servo parts. */}
      <Desk x={1.0} y={3.6} w={3.6} d={0.85} color="#42464c" />
      <Monitor x={1.2} y={3.65} z={1.32} w={0.95} accent={accent} content="code" />
      <Box x={2.4} y={3.95} z={1.32} w={0.3} d={0.18} h={0.1} color="#1a1c22" />
      <Box x={2.78} y={3.95} z={1.32} w={0.3} d={0.18} h={0.1} color="#1a1c22" />
      <Box x={3.16} y={3.95} z={1.32} w={0.3} d={0.18} h={0.1} color={accent} />
      <Mug x={1.05} y={4.0} z={1.3} drink="#5a3a24" />
      <ChairAt cx={2.8} cy={4.9} accent={accent} face="back-left" />
    </>
  );
}

// ────────────────── CHIBI CORNER (chibi_corner) ──────────────────
// Niche props: plush toy bin overflowing with rounded shapes, ribbon
// spools on a wall rack, sticker sheets, pastel mood palette.
export function ChibiCorner({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <SmallFootprint accent={accent} glow="#f5e1ff" />
      {/* Sticker-sheet bookshelf — pastel-spined volumes representing
          sticker stock. */}
      <Bookshelf x={0.4} y={0.4} w={1.4} d={0.4} h={1.7} color="#f0d4ff" books={accent} />
      {/* Ribbon spool wall rack on the right wall — six small horizontal
          dowels with colored ribbon dangling. */}
      <WallDecal wall="right" u={1.4} v={1.05}>
        <g transform="scale(-1, 1)">
          <rect x={0} y={-22} width={66} height={20} fill="#f5e1ff" stroke={accent} strokeWidth={0.6} rx={2} />
          {[
            { x: 6,  c: "#ffb6d9" },
            { x: 18, c: "#d8a8ff" },
            { x: 30, c: accent },
            { x: 42, c: "#ffe1f0" },
            { x: 54, c: "#a3c8ff" },
          ].map(({ x, c }, i) => (
            <g key={i}>
              {/* Dowel */}
              <rect x={x - 0.5} y={-19} width={1.5} height={3.5} fill="#a07050" />
              {/* Ribbon strand */}
              <path d={`M ${x + 0.25} ${-15} Q ${x + 4} ${-10} ${x + 0.25} ${-5}`} fill="none" stroke={c} strokeWidth={2.4} />
            </g>
          ))}
        </g>
      </WallDecal>
      {/* Plush toy bin — open box with three rounded plush spheres
          peeking out. */}
      <g>
        <Box x={4.3} y={0.6} z={0.0} w={0.9} d={0.9} h={0.6}
          color="#ffd0e8" colors={{ top: "#ffe0f0", left: "#e09cc0", right: "#e8b0d0" }} />
        {/* Plushies */}
        <Sphere x={4.55} y={1.0}  z={0.7} r={0.25} color="#ffb6d9" />
        <Sphere x={4.95} y={0.85} z={0.7} r={0.22} color="#d8a8ff" />
        <Sphere x={4.75} y={1.15} z={0.78} r={0.2} color="#fff1e6" />
        {/* Two tiny dot eyes on the front plushie */}
        {(() => {
          const e1 = iso3(4.5, 1.05, 0.78);
          const e2 = iso3(4.62, 1.05, 0.78);
          return (
            <g>
              <circle cx={e1.x} cy={e1.y} r={0.5} fill="#1a1c22" />
              <circle cx={e2.x} cy={e2.y} r={0.5} fill="#1a1c22" />
            </g>
          );
        })()}
      </g>
      {/* Work desk with laptop + papers (sticker sheet) + mug + plant. */}
      <Desk x={1.6} y={2.0} w={2.4} d={0.85} color="#e6c8e8" />
      <Laptop x={1.85} y={2.15} z={1.32} accent={accent} />
      {/* "Sticker sheet" on the desk — a small grid of pastel circles. */}
      {(() => {
        const sx = 2.8, sy = 2.18, sz = 1.34;
        const cells: ReactNode[] = [];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 4; c++) {
            const p = iso3(sx + c * 0.16, sy + r * 0.16, sz);
            const colors = ["#ffb6d9", "#d8a8ff", "#fff1e6", accent];
            cells.push(
              <circle key={`${r}-${c}`} cx={p.x} cy={p.y} r={2.4} fill={colors[(r + c) % colors.length]} stroke="#fff" strokeWidth={0.4} />
            );
          }
        }
        return <g>{cells}</g>;
      })()}
      <Mug x={1.7} y={2.5} z={1.32} drink="#ffb6d9" />
      <ChairAt cx={3.0} cy={3.4} accent={accent} face="back-left" />
      <Plant x={5.0} y={4.9} color="#7fcf8a" />
    </>
  );
}

// ────────────────── DEITY ATELIER (deity_atelier) ──────────────────
// Niche props: a central altar pedestal with a finished deity bust, an
// obelisk in the back corner, a small brazier flame, ceremonial bookshelf
// with stone-spined tomes.
export function DeityAtelier({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <SmallFootprint accent={accent} glow="#fff1c5" />
      {/* Stone-tome shelf on the back wall */}
      <Bookshelf x={0.4} y={0.4} w={1.4} d={0.4} h={2.0} color="#5a4530" books="#bda57a" />
      {/* Obelisk in the back-right corner — tall narrow tapered prism. */}
      {(() => {
        const baseW = 0.42;
        const topW = 0.18;
        const h = 2.4;
        const ox = 4.6, oy = 0.6;
        const a = iso3(ox, oy, 0);
        const b = iso3(ox + baseW, oy, 0);
        const c = iso3(ox + baseW, oy + baseW, 0);
        const ta = iso3(ox + (baseW - topW) / 2, oy + (baseW - topW) / 2, h);
        const tb = iso3(ox + baseW - (baseW - topW) / 2, oy + (baseW - topW) / 2, h);
        const tc = iso3(ox + baseW - (baseW - topW) / 2, oy + baseW - (baseW - topW) / 2, h);
        const td = iso3(ox + (baseW - topW) / 2, oy + baseW - (baseW - topW) / 2, h);
        return (
          <g>
            <polygon points={`${a.x},${a.y} ${b.x},${b.y} ${tb.x},${tb.y} ${ta.x},${ta.y}`} fill="#9a8868" />
            <polygon points={`${b.x},${b.y} ${c.x},${c.y} ${tc.x},${tc.y} ${tb.x},${tb.y}`} fill="#7a6850" />
            <polygon points={`${ta.x},${ta.y} ${tb.x},${tb.y} ${tc.x},${tc.y} ${td.x},${td.y}`} fill="#bda57a" />
            {/* Carved gold accent line down the front face */}
            <line x1={(a.x + b.x) / 2} y1={(a.y + b.y) / 2} x2={(ta.x + tb.x) / 2} y2={(ta.y + tb.y) / 2} stroke={accent} strokeWidth={0.8} opacity={0.85} />
          </g>
        );
      })()}
      {/* Hieroglyph panel on the right wall — vertical strip of small
          glyph squares. */}
      <WallDecal wall="right" u={1.7} v={0.4}>
        <g transform="scale(-1, 1)">
          <rect x={0} y={-32} width={20} height={30} fill="#3a2818" rx={2} />
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={5} y={-28 + i * 6} width={10} height={4} fill={accent} opacity={0.85} rx={0.5} />
          ))}
        </g>
      </WallDecal>
      {/* Central altar pedestal with a finished deity bust on top + small
          brazier flame beside it. */}
      <Pedestal x={2.6} y={2.4} accent={accent} display="figure" color="#f0e2c2" />
      {/* Brazier — a low bowl with a flickering accent flame. */}
      <g>
        <Cylinder x={1.8} y={2.7} r={0.18} h={0.15} color="#3a2818" />
        <Cylinder x={1.8} y={2.7} z={0.15} r={0.16} h={0.05} color="#bda57a" />
        {(() => {
          const f = iso3(1.8, 2.7, 0.3);
          return (
            <g>
              <ellipse cx={f.x} cy={f.y - 6} rx={3.2} ry={6} fill={accent} fillOpacity={0.85}>
                <animate attributeName="ry" values="5;7;5" dur="1.8s" repeatCount="indefinite" />
              </ellipse>
              <ellipse cx={f.x} cy={f.y - 8} rx={1.6} ry={3.5} fill="#fff1c5" opacity={0.85} />
            </g>
          );
        })()}
      </g>
      {/* Work desk with sketchpad + laptop */}
      <Desk x={1.2} y={3.6} w={3.0} d={0.85} color="#5a4530" />
      <Laptop x={1.45} y={3.75} z={1.32} accent={accent} />
      <Papers x={2.6} y={4.05} z={1.34} accent={accent} />
      <Mug x={1.3} y={4.05} z={1.32} drink="#bda57a" />
      <ChairAt cx={2.6} cy={4.9} accent={accent} face="back-left" />
    </>
  );
}

// ────────────────── CREATURE DEN (creature_den) ──────────────────
// Niche props: a horn/tusk wall rack, a scaled hide draped over a chair,
// a bone shelf with skull silhouettes, a moss-tone jade palette.
export function CreatureDen({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <SmallFootprint accent={accent} glow="#c8e8d4" />
      {/* Bone shelf on the back wall — three rounded "skull" lumps as
          shelf decor on a darker shelf. */}
      <Bookshelf x={0.4} y={0.4} w={1.6} d={0.4} h={1.7} color="#3a2a1a" books="#d8c2a0" />
      {(() => {
        const skullX = [0.6, 1.0, 1.4];
        return (
          <g>
            {skullX.map((sx, i) => {
              const s = iso3(sx, 0.45, 1.35 + (i % 2) * 0.05);
              return (
                <g key={i}>
                  <ellipse cx={s.x} cy={s.y} rx={5.5} ry={4.0} fill="#e8d5b0" />
                  <ellipse cx={s.x - 1.8} cy={s.y + 0.5} rx={1.0} ry={1.4} fill="#1a1410" />
                  <ellipse cx={s.x + 1.8} cy={s.y + 0.5} rx={1.0} ry={1.4} fill="#1a1410" />
                </g>
              );
            })}
          </g>
        );
      })()}
      {/* Horn/tusk wall rack on the right wall — two curved horns flanking
          a central tooth-row trophy plate. */}
      <WallDecal wall="right" u={1.6} v={1.0}>
        <g transform="scale(-1, 1)">
          {/* Mounting plate */}
          <rect x={0} y={-26} width={64} height={20} fill="#3a2a1a" rx={2} />
          {/* Left horn */}
          <path d={`M 6 -16 Q 14 -25 22 -14 Q 18 -14 14 -10 Q 10 -14 6 -16 Z`} fill="#e8d5b0" />
          {/* Right horn (mirrored) */}
          <path d={`M 58 -16 Q 50 -25 42 -14 Q 46 -14 50 -10 Q 54 -14 58 -16 Z`} fill="#e8d5b0" />
          {/* Tooth-row trophy plate in the middle */}
          <rect x={26} y={-22} width={12} height={6} fill={accent} stroke="#1a1a14" strokeWidth={0.5} />
          {[0, 4, 8].map((d, i) => (
            <polygon key={i} points={`${27 + d},${-16} ${29 + d},${-16} ${28 + d},${-12}`} fill="#fff1e6" />
          ))}
        </g>
      </WallDecal>
      {/* Scaled hide draped over an armchair in the back corner */}
      <Armchair x={4.3} y={0.6} color="#2a3a2a" face="back-right" />
      {(() => {
        const a = iso3(4.3, 0.6, 1.0);
        const b = iso3(5.05, 0.6, 1.0);
        const c = iso3(5.05, 1.4, 0.3);
        const d = iso3(4.3, 1.4, 0.3);
        return (
          <g>
            <polygon points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`} fill={accent} />
            {/* Scale texture — small diamond cells stitched across the hide */}
            {[0.2, 0.45, 0.7].map((u, i) =>
              [0.25, 0.5, 0.75].map((v, j) => {
                const p = iso3(4.3 + u * 0.75, 0.6 + v * 0.8, 1.0 - v * 0.7);
                return <circle key={`${i}-${j}`} cx={p.x} cy={p.y} r={0.9} fill="#1a3024" opacity={0.55} />;
              })
            )}
          </g>
        );
      })()}
      {/* Sculpting bench — slab with a clay creature WIP and tools. */}
      <LabBench x={1.0} y={2.4} w={3.2} color="#3a2a1a" />
      {/* Clay creature WIP — a low-poly creature blob (sphere on a base). */}
      <Cylinder x={2.0} y={2.65} z={1.32} r={0.32} h={0.06} color="#5a4030" />
      <Sphere x={2.0} y={2.65} z={1.42} r={0.18} color="#7a6050" />
      {/* Sculpting tools (three thin metal sticks) */}
      {[2.6, 2.75, 2.9].map((tx, i) => {
        const a = iso3(tx, 2.6, 1.34);
        const b = iso3(tx, 3.1, 1.34);
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#bdbdc0" strokeWidth={1.0} />;
      })}
      <Laptop x={3.4} y={2.6} z={1.32} accent={accent} />
      <ChairAt cx={2.7} cy={3.6} accent={accent} face="back-left" />
      <TallPlant x={5.0} y={4.9} color="#1f5a3a" />
    </>
  );
}

// ────────────────── HUMANOID FORGE (humanoid_forge) ──────────────────
// Niche props: a shield rack (three shields), a sword cabinet, a scroll
// table with parchment + quill, a leather mood-board.
export function HumanoidForge({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <SmallFootprint accent={accent} glow="#f5e1c2" />
      {/* Sword cabinet on the back-left — tall cabinet with two crossed
          sword blades on the front. */}
      <Cabinet x={0.4} y={0.4} color="#5a3a20" w={0.84} d={0.6} h={2.0} />
      {(() => {
        const x = 0.4, y = 0.4, w = 0.84;
        const cb1 = iso3(x + 0.1, y + 0.05, 0.4);
        const ct1 = iso3(x + w - 0.1, y + 0.05, 1.9);
        const cb2 = iso3(x + w - 0.1, y + 0.05, 0.4);
        const ct2 = iso3(x + 0.1, y + 0.05, 1.9);
        return (
          <g>
            <line x1={cb1.x} y1={cb1.y} x2={ct1.x} y2={ct1.y} stroke="#d8d8e0" strokeWidth={2.0} />
            <line x1={cb2.x} y1={cb2.y} x2={ct2.x} y2={ct2.y} stroke="#d8d8e0" strokeWidth={2.0} />
            <circle cx={(cb1.x + ct2.x) / 2} cy={(cb1.y + ct2.y) / 2} r={2.6} fill={accent} stroke="#1a1a14" strokeWidth={0.5} />
          </g>
        );
      })()}
      {/* Shield rack on the right wall — three round shields with cross
          quarterings in primary heraldic tones. */}
      <WallDecal wall="right" u={1.0} v={1.0}>
        <g transform="scale(-1, 1)">
          <rect x={0} y={-26} width={64} height={22} fill="#3a2818" rx={2} />
          {[
            { cx: 12, fill: "#a02828" },
            { cx: 32, fill: accent },
            { cx: 52, fill: "#284fa0" },
          ].map(({ cx, fill }, i) => (
            <g key={i}>
              <circle cx={cx} cy={-15} r={8} fill={fill} stroke="#1a1a14" strokeWidth={0.6} />
              <line x1={cx} y1={-23} x2={cx} y2={-7} stroke="#1a1a14" strokeWidth={0.5} opacity={0.7} />
              <line x1={cx - 8} y1={-15} x2={cx + 8} y2={-15} stroke="#1a1a14" strokeWidth={0.5} opacity={0.7} />
              <circle cx={cx} cy={-15} r={1.6} fill="#fff1c5" />
            </g>
          ))}
        </g>
      </WallDecal>
      {/* Scroll table — small side table with parchment and a quill */}
      <SideTable x={4.0} y={0.6} color="#5a3a20" />
      {(() => {
        const s = iso3(4.0, 0.6, 1.1);
        const sLeft = iso3(4.0, 0.6, 1.1);
        const sRight = iso3(4.6, 0.6, 1.1);
        const sBack = iso3(4.0, 1.2, 1.1);
        return (
          <g>
            {/* Scroll (curled at one end) */}
            <polygon points={`${sLeft.x},${sLeft.y} ${sRight.x},${sRight.y} ${sRight.x},${sBack.y} ${sLeft.x},${sBack.y}`} fill="#f0e2c2" />
            <line x1={sLeft.x + 2} y1={s.y - 1} x2={sLeft.x + 16} y2={s.y - 1} stroke="#3a2818" strokeWidth={0.6} />
            <line x1={sLeft.x + 2} y1={s.y + 2} x2={sLeft.x + 12} y2={s.y + 2} stroke="#3a2818" strokeWidth={0.6} />
            {/* Quill rising up to the right */}
            <line x1={sRight.x - 4} y1={s.y + 1} x2={sRight.x + 4} y2={s.y - 12} stroke="#3a2818" strokeWidth={1.4} />
            <path d={`M ${sRight.x + 4} ${s.y - 12} Q ${sRight.x + 6} ${s.y - 9} ${sRight.x + 2} ${s.y - 6}`} fill={accent} />
          </g>
        );
      })()}
      {/* Pedestal in the back showing a finished humanoid mini */}
      <Pedestal x={2.6} y={0.4} accent={accent} display="figure" color="#f0e2c2" />
      {/* Work desk — leather-topped writing desk with a monitor + laptop. */}
      <Desk x={1.4} y={2.4} w={3.0} d={0.9} color="#5a3a20" />
      <Monitor x={1.6} y={2.5} z={1.32} w={0.95} accent={accent} content="design" />
      <Laptop x={2.85} y={2.6} z={1.32} accent={accent} />
      <Papers x={3.7} y={2.95} z={1.34} accent={accent} />
      <Mug x={1.55} y={2.95} z={1.32} drink="#5a3a24" />
      <ChairAt cx={3.0} cy={3.7} accent={accent} face="back-left" />
      <Plant x={5.0} y={4.9} color="#5fa057" />
    </>
  );
}
