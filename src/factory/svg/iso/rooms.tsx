import type { ReactNode } from "react";
import {
  Armchair, Bookshelf, BoxStack, Cabinet, Clock, Desk, DeskPhone,
  FloorLightPool, FloorRect, Headset, Keyboard, LabBench, Laptop, LDesk,
  Microscope, Monitor, Mouse, Mug, OfficeChair, OvalTable, Papers, Pedestal,
  Plant, Printer3D, Rug, ServerRack, SideTable, Stool,
  TallPlant, Treadmill, UltraWide, WallScreen, YogaMat,
} from "./furnitureV2";

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
      <OvalTable x={1.5} y={1.56} w={2.76} d={1.68} color="#b8855a" />
      <OfficeChair x={1.74} y={0.84} color="#1a1c22" accent={accent} face="back-left" />
      <OfficeChair x={2.64} y={0.84} color="#1a1c22" accent={accent} face="back-left" />
      <OfficeChair x={3.54} y={0.84} color="#1a1c22" accent={accent} face="back-left" />
      <OfficeChair x={0.84} y={1.92} color="#1a1c22" accent={accent} face="back-right" />
      <OfficeChair x={4.2} y={1.92} color="#1a1c22" accent={accent} face="front-right" />
      <OfficeChair x={1.74} y={3.36} color="#1a1c22" accent={accent} face="front-left" />
      <OfficeChair x={2.64} y={3.36} color="#1a1c22" accent={accent} face="front-left" />
      <OfficeChair x={3.54} y={3.36} color="#1a1c22" accent={accent} face="front-left" />
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
export function ListingDesk({ accent }: { accent: string }): ReactNode {
  return (
    <>
      <BoxStack x={0.3} y={0.4} color="#c89466" />
      <BoxStack x={1.18} y={0.4} color="#a87a52" />
      <Cabinet x={2.06} y={0.4} color="#d8d8df" />
      <BoxStack x={4.7} y={0.4} color="#b08252" />
      <BoxStack x={0.4} y={4.9} color="#9c6e44" />
      <TallPlant x={5.0} y={4.9} color="#3f8a4f" />
      <Rug x={1.2} y={2.6} w={3.6} d={2.0} color={accent} opacity={0.16} />
      <FloorLightPool x={3.0} y={3.4} rx={1.7} ry={1.0} color="#fff5d6" opacity={0.3} />
      <Desk x={1.6} y={1.9} w={1.4} d={0.85} color="#d6b58a" />
      <Desk x={3.1} y={1.9} w={1.4} d={0.85} color="#d6b58a" />
      <Laptop x={1.78} y={2.05} z={1.3} accent={accent} />
      <Monitor x={3.3} y={1.95} z={1.3} w={0.95} accent={accent} content="list" />
      <Papers x={2.65} y={2.4} z={1.34} accent="#666" />
      <Mug x={1.7} y={2.4} z={1.3} drink="#b08252" />
      <ChairAt cx={2.2} cy={3.2} accent={accent} face="back-left" />
      <ChairAt cx={3.8} cy={3.2} accent={accent} face="back-left" />
    </>
  );
}

// ────────────────── RESEARCH LAB (analyst / rd) ──────────────────
// analyst: row layout, c=2 → (2.2, 3.2), (3.8, 3.2)
// rd: central layout, c=1 → (1.7, 4.6)
export function ResearchLab({ accent, layout }: { accent: string; layout: "row" | "central" }): ReactNode {
  return (
    <>
      <WallScreen wall="right" u={1.0} v={1.55} w={2.0} h={1.0} accent={accent} content="grid" />
      <LabBench x={0.5} y={0.4} w={3.0} color="#e6eaed" />
      <Microscope x={0.8} y={0.5} z={1.32} accent={accent} />
      <Monitor x={1.7} y={0.5} z={1.32} w={0.8} accent={accent} content="chart" />
      <Microscope x={2.6} y={0.5} z={1.32} accent={accent} />
      <Bookshelf x={4.0} y={0.4} w={1.4} d={0.4} h={2.0} color="#b89866" books={accent} />
      <Rug x={1.2} y={2.6} w={3.6} d={2.0} color={accent} opacity={0.13} />
      <FloorLightPool x={3.0} y={3.4} rx={1.6} ry={1.0} color="#dff0f4" opacity={0.35} />
      <Desk x={1.6} y={1.9} w={2.8} d={0.85} color="#d6b58a" />
      <Laptop x={1.7} y={2.05} z={1.3} accent={accent} />
      <UltraWide x={2.6} y={1.95} z={1.3} w={1.4} accent={accent} content="multi" />
      <Papers x={3.0} y={2.4} z={1.32} accent="#444" />
      <Mug x={1.7} y={2.4} z={1.3} drink="#5a3a24" />
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
