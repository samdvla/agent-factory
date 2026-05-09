import React from "react";
import { iso } from "./geometry";
import {
  IsoBox,
  OfficeChair,
  MeetingChair,
  ExecutiveDesk,
  Sofa,
  CoffeeTable,
  FilingCabinet,
  Bookshelf,
  Plant,
  FloorRug,
  ConferenceTable,
  Workstation,
  ServerRack,
  LabBench,
  DraftingTable,
  Printer,
  Whiteboard,
  ColorRack,
  PaperStack,
  ShippingBoxes,
  Globe,
  Telephone,
  BinderStack,
  TestTubes,
  ControlPanel,
  PenJar,
  WallClock,
} from "./furniture";

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

// ============================================================
// Strategy Room — boss's office.
// Conference table at center, executive desk in NE,
// lounge in SW, plants in two corners.
// ============================================================
export function BridgeProps({ ox, oy }: { ox: number; oy: number }) {
  const podiumTop = iso(ox + 3, oy + 4.4);
  return (
    <g>
      {/* Floor rug under the conference area */}
      <FloorRug x0={ox + 1.5} y0={oy + 2.4} x1={ox + 4.5} y1={oy + 4.5} />

      {/* Back wall — KPI panels */}
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={18} height={28} color="rgba(245, 166, 35, 0.12)" />
      <WallPanel face="south" x0={ox + 0.6} y0={oy} x1={ox + 1.7} y1={oy + 0.5} baseY={26} height={5}  color="rgba(245, 166, 35, 0.55)" />
      <WallPanel face="south" x0={ox + 1.85} y0={oy} x1={ox + 2.95} y1={oy + 0.5} baseY={26} height={5} color="rgba(94, 208, 168, 0.55)" />
      <WallPanel face="south" x0={ox + 3.1} y0={oy} x1={ox + 4.2} y1={oy + 0.5} baseY={26} height={5}  color="rgba(95, 212, 240, 0.55)" />
      <WallPanel face="south" x0={ox + 4.35} y0={oy} x1={ox + 5.4} y1={oy + 0.5} baseY={26} height={5} color="rgba(255, 107, 157, 0.55)" />

      {/* === BACK ROW (north) === */}
      <FilingCabinet x={ox + 0.55} y={oy + 0.6} />
      <OfficeChair x={ox + 4.85} y={oy + 0.55} accent="#243140" />
      <ExecutiveDesk x={ox + 4.05} y={oy + 1.25} w={1.55} d={1.0} />

      {/* === MIDDLE ROW — conference / strategy table === */}
      <ConferenceTable x={ox + 1.7} y={oy + 2.7} w={2.6} d={1.4} glowColor="rgba(245, 166, 35, 0.5)" />
      {/* Three chairs along the north side facing south toward the table */}
      <MeetingChair x={ox + 2.0} y={oy + 2.05} accent="#3a4a5e" />
      <MeetingChair x={ox + 2.85} y={oy + 2.05} accent="#3a4a5e" />
      <MeetingChair x={ox + 3.7} y={oy + 2.05} accent="#3a4a5e" />

      {/* === FRONT ROW (south) === */}
      <Sofa x={ox + 0.45} y={oy + 4.55} w={1.7} accent="rgba(245, 166, 35, 0.55)" />
      <CoffeeTable x={ox + 0.75} y={oy + 5.4} w={1.1} d={0.45} />
      {/* Coffee mug + a small awards plaque on the coffee table */}
      <IsoBox x={ox + 1.05} y={oy + 5.55} w={0.16} d={0.16} h={3.0}
        fillTop="#cdd5df" fillRight="#1a2532" fillLeft="#1f2a37" />
      <PaperStack x={ox + 1.45} y={oy + 5.55} w={0.32} d={0.22} h={2.4}
        topAccent="rgba(245, 166, 35, 0.55)" />

      {/* Globe on a small pedestal in front of the bookshelf area */}
      <Globe x={ox + 5.18} y={oy + 4.85} accent="rgba(245, 166, 35, 0.7)" />

      {/* Briefcase next to the executive desk */}
      <IsoBox x={ox + 3.8} y={oy + 1.8} w={0.45} d={0.18} h={2.2}
        fillTop="#3a2a1a" fillRight="#1a1208" fillLeft="#2a1d10" />
      <IsoBox x={ox + 3.85} y={oy + 1.83} w={0.35} d={0.04} h={2.5}
        fillTop="rgba(245, 166, 35, 0.65)" fillRight="#1a1208" fillLeft="#2a1d10" />

      {/* Stack of strategy reports on the conference table */}
      <PaperStack x={ox + 3.5} y={oy + 3.2} w={0.4} d={0.3} h={3.6}
        topAccent="rgba(245, 166, 35, 0.6)" />

      {/* Wall clock on the back wall */}
      <WallClock x={ox + 5.2} y0={oy} accent="rgba(245, 166, 35, 0.85)" />

      {/* Plant — single, in the SE corner */}
      <Plant x={ox + 2.65} y={oy + 5.5} />

      {/* Command podium with clipboard */}
      <IsoBox x={ox + 2.85} y={oy + 4.25} w={0.3} d={0.3} h={4}
        fillTop="#3a4a5e" fillRight="#1f2a37" fillLeft="#243140" />
      <IsoBox x={ox + 2.85} y={oy + 4.25} w={0.3} d={0.3} h={4.6}
        fillTop="rgba(245,166,35,0.85)" fillRight="#1f2a37" fillLeft="#243140" />
      <text x={podiumTop.x} y={podiumTop.y - 5} textAnchor="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={2.6}
        fill="#1a1207" fontWeight="700">DISPATCH</text>
    </g>
  );
}

// ============================================================
// Research Lab — Iris's workspace.
// Two terminal workstations facing the trends wall, sample
// shelf along east, plant + bookshelf for ambiance.
// ============================================================
export function AnalystProps({ ox, oy }: { ox: number; oy: number }) {
  const chartLeft = iso(ox + 1.0, oy + 0.4);
  const chartRight = iso(ox + 5.0, oy + 0.4);
  const sparkPts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const ySpike = 26 - Math.sin(t * Math.PI * 2) * 5 - t * 4;
    const p = iso(ox + 1.0 + t * 4.0, oy + 0.4);
    sparkPts.push({ x: p.x, y: p.y - ySpike });
  }
  const sparkPath = sparkPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

  return (
    <g>
      {/* Floor rug under workstations */}
      <FloorRug x0={ox + 1.4} y0={oy + 3.0} x1={ox + 4.6} y1={oy + 5.0}
        color="rgba(95, 212, 240, 0.05)" border="rgba(95, 212, 240, 0.25)" />

      {/* Trends wall — sparkline chart */}
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={14} height={32} color="rgba(95, 212, 240, 0.10)" />
      <WallPanel face="south" x0={ox + 0.7} y0={oy} x1={ox + 5.3} y1={oy + 0.5} baseY={32} height={1}  color="rgba(95, 212, 240, 0.55)" />
      <path d={sparkPath} fill="none" stroke="rgba(95, 212, 240, 0.95)" strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
      <text x={chartLeft.x + 1} y={chartLeft.y - 32 + 1} fontFamily="JetBrains Mono, monospace" fontSize={2.4} fill="rgba(95,212,240,0.7)">+18%</text>
      <text x={chartRight.x - 8} y={chartRight.y - 8} fontFamily="JetBrains Mono, monospace" fontSize={2.4} fill="rgba(95,212,240,0.7)">7d</text>

      {/* Whiteboard along NW */}
      <Whiteboard x={ox + 0.5} y={oy + 1.4} w={1.4} accent="rgba(95, 212, 240, 0.7)" />

      {/* Twin workstations facing south */}
      <OfficeChair x={ox + 2.0} y={oy + 4.6} accent="#243140" />
      <OfficeChair x={ox + 3.4} y={oy + 4.6} accent="#243140" />
      <Workstation x={ox + 1.65} y={oy + 3.2} w={1.3} d={1.0} accent="rgba(95, 212, 240, 0.75)" />
      <Workstation x={ox + 3.05} y={oy + 3.2} w={1.3} d={1.0} accent="rgba(95, 212, 240, 0.75)" />
      {/* Coffee mug on shared corner */}
      <IsoBox x={ox + 4.5} y={oy + 3.4} w={0.18} d={0.18} h={1.4}
        fillTop="#5fd4f0" fillRight="#1a2532" fillLeft="#1f2a37" />

      {/* Sample shelf along east wall */}
      <Bookshelf x={ox + 5.0} y={oy + 2.6} w={0.55} depth={1.6} h={11}
        spineColors={["#5fd4f0", "#f5a623", "#c4d943", "#ff6b9d", "#b393f5"]} />

      {/* Paper / report piles on each workstation */}
      <PaperStack x={ox + 1.78} y={oy + 4.0} w={0.36} d={0.24} h={2.4}
        topAccent="rgba(95, 212, 240, 0.55)" />
      <PaperStack x={ox + 3.18} y={oy + 4.0} w={0.36} d={0.24} h={2.0}
        topAccent="rgba(94, 208, 168, 0.55)" />

      {/* Archive binders along the SW corner */}
      <BinderStack x={ox + 0.6} y={oy + 4.55} w={0.55} d={0.6}
        colors={["#5fd4f0", "#f5a623", "#c4d943", "#b393f5"]} />

      {/* Wall clock on back wall */}
      <WallClock x={ox + 4.6} y0={oy} accent="rgba(95, 212, 240, 0.85)" />

      {/* Plant — single */}
      <Plant x={ox + 5.25} y={oy + 5.0} leafColor="rgba(94, 208, 168, 0.7)" />
    </g>
  );
}

// ============================================================
// Design Studio — Mara's creative room.
// Render desk + drafting board + color rack + mood wall.
// ============================================================
export function FabProps({ ox, oy }: { ox: number; oy: number }) {
  const swatches: React.ReactNode[] = [];
  for (let i = 0; i < 6; i++) {
    const xs = ox + 0.6 + i * 0.85;
    const colors = ["rgba(255,107,157,0.55)", "rgba(95,212,240,0.55)", "rgba(245,166,35,0.55)"];
    swatches.push(
      <WallPanel key={i}
        face="south" x0={xs} y0={oy} x1={xs + 0.6} y1={oy + 0.5}
        baseY={22 + (i % 2) * 4} height={6} color={colors[i % 3]} />
    );
  }
  return (
    <g>
      <FloorRug x0={ox + 1.4} y0={oy + 2.8} x1={ox + 4.6} y1={oy + 5.0}
        color="rgba(255, 107, 157, 0.05)" border="rgba(255, 107, 157, 0.25)" />

      {/* Mood wall */}
      <WallPanel face="south" x0={ox + 0.4} y0={oy} x1={ox + 5.6} y1={oy + 0.5} baseY={14} height={30} color="rgba(255, 107, 157, 0.10)" />
      {swatches}

      {/* Render desk + chair (NE) */}
      <OfficeChair x={ox + 3.6} y={oy + 4.55} accent="#3a2a3a" />
      <Workstation x={ox + 3.0} y={oy + 3.2} w={1.6} d={1.1} accent="rgba(255, 107, 157, 0.75)" />

      {/* Stylus + tablet on desk */}
      <IsoBox x={ox + 3.15} y={oy + 4.05} w={1.3} d={0.25} h={6.0}
        fillTop="#243140" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 4.3} y={oy + 4.15} w={0.35} d={0.07} h={6.4}
        fillTop="#cdd5df" fillRight="#1a2532" fillLeft="#1f2a37" />

      {/* Color rack on east */}
      <ColorRack x={ox + 5.0} y={oy + 2.8} />

      {/* Drafting table SW */}
      <DraftingTable x={ox + 0.55} y={oy + 3.3} w={1.2} d={0.85} />

      {/* Easel — small standing canvas in front of mood wall */}
      <IsoBox x={ox + 1.4} y={oy + 1.8} w={0.08} d={0.08} h={6}
        fillTop="#1a2532" fillRight="#15202b" fillLeft="#1f2a37" />
      <IsoBox x={ox + 1.4} y={oy + 1.8} w={1.1} d={0.05} h={9}
        fillTop="#e6edf3" fillRight="#aab4c0" fillLeft="#cdd5df" />
      <IsoBox x={ox + 1.5} y={oy + 1.82} w={0.9} d={0.02} h={8.4}
        fillTop="rgba(255, 107, 157, 0.7)" fillRight="#aab4c0" fillLeft="#cdd5df" />

      {/* Pen / brush jar on the render desk */}
      <PenJar x={ox + 4.5} y={oy + 3.4} accent="rgba(255, 107, 157, 0.75)" />

      {/* Stack of printable proofs next to the drafting table */}
      <PaperStack x={ox + 0.55} y={oy + 4.5} w={0.45} d={0.32} h={2.0}
        topAccent="rgba(255, 107, 157, 0.55)" />

      {/* Framed print accent on back wall */}
      <WallPanel face="south" x0={ox + 1.2} y0={oy} x1={ox + 1.9} y1={oy + 0.5}
        baseY={36} height={6} color="rgba(255, 107, 157, 0.55)" />
      <WallPanel face="south" x0={ox + 4.05} y0={oy} x1={ox + 4.75} y1={oy + 0.5}
        baseY={36} height={6} color="rgba(95, 212, 240, 0.55)" />

      {/* Plant — single, lush corner */}
      <Plant x={ox + 5.25} y={oy + 5.0} leafColor="rgba(94, 208, 168, 0.75)" />
    </g>
  );
}

// ============================================================
// Listing Desk — Theo + Avery share the publish bench.
// Long 3-monitor desk + 2 office chairs + kanban wall + printer.
// ============================================================
export function DispatchProps({ ox, oy }: { ox: number; oy: number }) {
  const monitors: React.ReactNode[] = [];
  for (let i = 0; i < 3; i++) {
    monitors.push(
      <IsoBox key={i}
        x={ox + 1.4 + i * 1.3} y={oy + 3.1} w={1} d={0.18} h={11.5}
        fillTop="rgba(107, 217, 104, 0.75)" fillRight="#0c141b" fillLeft="#0e161e" />
    );
  }
  // Kanban grid on south wall
  const kanbanCards: React.ReactNode[] = [];
  const colColors = [
    "rgba(106, 169, 255, 0.65)",
    "rgba(245, 166, 35, 0.65)",
    "rgba(94, 208, 168, 0.65)",
  ];
  const colHeaders = ["TODO", "DOING", "DONE"];
  const colHeaderTexts: React.ReactNode[] = [];
  for (let col = 0; col < 3; col++) {
    const xL = ox + 0.7 + col * 1.55;
    const xR = xL + 1.2;
    kanbanCards.push(
      <WallPanel key={`h-${col}`} face="south" x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
        baseY={29} height={3} color={colColors[col]} />,
    );
    const hp = iso((xL + xR) / 2, oy + 0.4);
    colHeaderTexts.push(
      <text key={`ht-${col}`} x={hp.x} y={hp.y - 30.5} textAnchor="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={2.6}
        fill="#0a0e15" fontWeight="700">{colHeaders[col]}</text>
    );
    for (let row = 0; row < 3; row++) {
      kanbanCards.push(
        <WallPanel key={`c-${col}-${row}`} face="south"
          x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
          baseY={20 - row * 6} height={4.5}
          color={colColors[col].replace("0.65", "0.35")} />,
      );
    }
  }
  return (
    <g>
      <FloorRug x0={ox + 1.0} y0={oy + 2.8} x1={ox + 5.0} y1={oy + 4.8}
        color="rgba(107, 217, 104, 0.05)" border="rgba(107, 217, 104, 0.25)" />

      {/* Kanban back wall */}
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={10} height={26} color="rgba(107, 217, 104, 0.10)" />
      {kanbanCards}
      {colHeaderTexts}

      {/* Long shared desk */}
      <IsoBox x={ox + 1.0} y={oy + 3.0} w={4.0} d={1.2} h={5.2}
        fillTop="#2a3849" fillRight="#15202b" fillLeft="#1a2532" />
      <IsoBox x={ox + 1.05} y={oy + 3.05} w={3.9} d={1.1} h={5.4}
        fillTop="#1f2a37" fillRight="#15202b" fillLeft="#1a2532" />
      {monitors}
      {/* Three keyboards aligned with monitors */}
      {[0, 1, 2].map((i) => (
        <IsoBox key={`kb-${i}`}
          x={ox + 1.45 + i * 1.3} y={oy + 3.7} w={0.9} d={0.22} h={6.0}
          fillTop="#2a3849" fillRight="#15202b" fillLeft="#1a2532" />
      ))}

      {/* Two office chairs (Theo + Avery) */}
      <OfficeChair x={ox + 1.85} y={oy + 4.55} accent="#243140" />
      <OfficeChair x={ox + 4.05} y={oy + 4.55} accent="#243140" />

      {/* Printer / shipping label station */}
      <Printer x={ox + 0.55} y={oy + 4.5} accent="rgba(107, 217, 104, 0.85)" />

      {/* Shipping boxes pile next to the printer */}
      <ShippingBoxes x={ox + 0.55} y={oy + 1.6} />

      {/* Listing portfolio binders along NE */}
      <BinderStack x={ox + 5.05} y={oy + 1.1} w={0.45} d={0.7}
        colors={["#6bd968", "#5fd4f0", "#f5a623", "#c4d943"]} />

      {/* Stack of printed listings on the desk */}
      <PaperStack x={ox + 1.1} y={oy + 4.0} w={0.35} d={0.25} h={2.4}
        topAccent="rgba(107, 217, 104, 0.6)" />

      {/* Wall clock */}
      <WallClock x={ox + 5.2} y0={oy} accent="rgba(107, 217, 104, 0.85)" />

      {/* Plant — single, SE corner */}
      <Plant x={ox + 5.25} y={oy + 4.95} leafColor="rgba(94, 208, 168, 0.7)" />
    </g>
  );
}

// ============================================================
// CS Booth — Lina handles buyer messages.
// Chat console + headset + case windows on the back wall.
// ============================================================
export function CommsProps({ ox, oy }: { ox: number; oy: number }) {
  const chatPanels: React.ReactNode[] = [];
  for (let i = 0; i < 3; i++) {
    const xL = ox + 1 + i * 1.3;
    const xR = xL + 1.0;
    chatPanels.push(
      <WallPanel key={`f${i}`}
        face="south" x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
        baseY={16} height={16} color="rgba(106, 169, 255, 0.22)" />,
      <WallPanel key={`h${i}`}
        face="south" x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
        baseY={29} height={3} color="rgba(106, 169, 255, 0.7)" />,
      <WallPanel key={`b1-${i}`}
        face="south" x0={xL + 0.05} y0={oy} x1={xL + 0.55} y1={oy + 0.5}
        baseY={24} height={3} color="rgba(255, 255, 255, 0.7)" />,
      <WallPanel key={`b2-${i}`}
        face="south" x0={xL + 0.45} y0={oy} x1={xL + 0.95} y1={oy + 0.5}
        baseY={20} height={3} color="rgba(106, 169, 255, 0.85)" />,
      <WallPanel key={`b3-${i}`}
        face="south" x0={xL + 0.10} y0={oy} x1={xL + 0.50} y1={oy + 0.5}
        baseY={16.5} height={2.5} color="rgba(255, 255, 255, 0.55)" />,
    );
  }
  return (
    <g>
      <FloorRug x0={ox + 1.7} y0={oy + 2.8} x1={ox + 4.3} y1={oy + 4.8}
        color="rgba(106, 169, 255, 0.05)" border="rgba(106, 169, 255, 0.25)" />

      {chatPanels}

      {/* Chat console workstation */}
      <OfficeChair x={ox + 2.7} y={oy + 4.55} accent="#243140" />
      <Workstation x={ox + 2.2} y={oy + 3.1} w={1.6} d={1.1} accent="rgba(106, 169, 255, 0.75)" />

      {/* Headset on the desk corner */}
      <IsoBox x={ox + 2.05} y={oy + 3.5} w={0.18} d={0.18} h={1.6}
        fillTop="#6aa9ff" fillRight="#1a2532" fillLeft="#1f2a37" />

      {/* Filing cabinet for case archive (NW) */}
      <FilingCabinet x={ox + 0.55} y={oy + 0.6} accent="rgba(106, 169, 255, 0.55)" />

      {/* Coffee station — small counter NE */}
      <IsoBox x={ox + 4.6} y={oy + 0.8} w={0.9} d={0.6} h={4.5}
        fillTop="#243140" fillRight="#15202b" fillLeft="#1a2532" />
      <IsoBox x={ox + 4.7} y={oy + 0.85} w={0.18} d={0.18} h={6.5}
        fillTop="#cdd5df" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 5.0} y={oy + 0.85} w={0.3} d={0.3} h={5.5}
        fillTop="rgba(106, 169, 255, 0.7)" fillRight="#1a2532" fillLeft="#1f2a37" />

      {/* Multi-line phone on the chat console */}
      <Telephone x={ox + 3.55} y={oy + 3.45} accent="rgba(106, 169, 255, 0.85)" />

      {/* FAQ / policy binders next to the filing cabinet */}
      <BinderStack x={ox + 1.4} y={oy + 0.85} w={0.45} d={0.6}
        colors={["#6aa9ff", "#cdd5df", "#5fd4f0"]} />

      {/* Stack of message-queue papers on the desk */}
      <PaperStack x={ox + 2.3} y={oy + 4.0} w={0.32} d={0.22} h={2.0}
        topAccent="rgba(106, 169, 255, 0.55)" />

      {/* Wall clock */}
      <WallClock x={ox + 4.0} y0={oy} accent="rgba(106, 169, 255, 0.85)" />

      {/* Plant — single, SE corner */}
      <Plant x={ox + 5.25} y={oy + 4.9} leafColor="rgba(94, 208, 168, 0.7)" />
    </g>
  );
}

// ============================================================
// Finance Office — Roman runs the books.
// Executive desk + P&L wall + safe + audit cart + bookshelf.
// ============================================================
export function ControlProps({ ox, oy }: { ox: number; oy: number }) {
  const bars: React.ReactNode[] = [];
  for (let i = 0; i < 12; i++) {
    const h = 4 + Math.abs(Math.sin(i * 0.7)) * 14 + (i % 3) * 2;
    const xL = ox + 0.6 + i * 0.4;
    bars.push(
      <WallPanel key={`bar-${i}`}
        face="south" x0={xL} y0={oy} x1={xL + 0.3} y1={oy + 0.5}
        baseY={14} height={h}
        color={i > 8 ? "rgba(94, 208, 168, 0.85)" : "rgba(196, 217, 67, 0.7)"} />
    );
  }
  const safeFront = iso(ox + 5.05, oy + 3.55);
  return (
    <g>
      <FloorRug x0={ox + 1.4} y0={oy + 2.8} x1={ox + 4.6} y1={oy + 4.7}
        color="rgba(196, 217, 67, 0.05)" border="rgba(196, 217, 67, 0.25)" />

      {/* P&L bar wall */}
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={12} height={28} color="rgba(196, 217, 67, 0.10)" />
      {bars}

      {/* Executive desk + chair */}
      <OfficeChair x={ox + 2.85} y={oy + 4.55} accent="#243140" />
      <ExecutiveDesk x={ox + 2.05} y={oy + 3.1} w={1.95} d={1.0}
        accent="rgba(196, 217, 67, 0.75)" />

      {/* Calculator + paper on the desk */}
      <IsoBox x={ox + 2.2} y={oy + 4.0} w={0.5} d={0.3} h={5.4}
        fillTop="#2a3849" fillRight="#15202b" fillLeft="#1a2532" />
      <IsoBox x={ox + 3.7} y={oy + 4.0} w={0.4} d={0.3} h={5.6}
        fillTop="#e6edf3" fillRight="#aab4c0" fillLeft="#cdd5df" />

      {/* Safe (east) */}
      <IsoBox x={ox + 4.85} y={oy + 3.2} w={0.55} d={0.7} h={5} fillTop="#1a2532" fillRight="#0e161e" fillLeft="#15202b" />
      <IsoBox x={ox + 4.88} y={oy + 3.25} w={0.5} d={0.6} h={5.2} fillTop="#243140" fillRight="#0e161e" fillLeft="#15202b" />
      <ellipse cx={safeFront.x} cy={safeFront.y - 2.5} rx={1.6} ry={1.0} fill="rgba(196,217,67,0.9)" />
      <ellipse cx={safeFront.x} cy={safeFront.y - 2.5} rx={0.6} ry={0.4} fill="#0a0e15" />

      {/* Bookshelf for binders (W wall) */}
      <Bookshelf x={ox + 0.45} y={oy + 2.0} w={0.55} depth={1.6} h={10}
        spineColors={["#c4d943", "#5ed0a8", "#cdd5df", "#243140", "#5ed0a8", "#c4d943"]} />

      {/* Audit cart */}
      <IsoBox x={ox + 1.0} y={oy + 4.9} w={0.7} d={0.45} h={2.4} fillTop="#243140" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 1.05} y={oy + 4.95} w={0.6} d={0.35} h={3.0} fillTop="#e6edf3" fillRight="#aab4c0" fillLeft="#cdd5df" />
      <IsoBox x={ox + 1.05} y={oy + 4.95} w={0.6} d={0.35} h={3.4} fillTop="rgba(196,217,67,0.6)" fillRight="#aab4c0" fillLeft="#cdd5df" />

      {/* Filing cabinet (NE corner) */}
      <FilingCabinet x={ox + 4.55} y={oy + 0.6} accent="rgba(196, 217, 67, 0.55)" />

      {/* Cash bundles stacked on the desk */}
      <IsoBox x={ox + 2.85} y={oy + 4.05} w={0.4} d={0.22} h={5.6}
        fillTop="#5ed0a8" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 2.92} y={oy + 4.08} w={0.32} d={0.18} h={6.0}
        fillTop="#c4d943" fillRight="#1a2532" fillLeft="#1f2a37" />

      {/* Receipt spike (a thin pin with stacked receipts) */}
      <IsoBox x={ox + 3.35} y={oy + 4.0} w={0.04} d={0.04} h={6.6}
        fillTop="#cdd5df" fillRight="#1a2532" fillLeft="#1f2a37" />
      <IsoBox x={ox + 3.32} y={oy + 4.0} w={0.1} d={0.1} h={5.4}
        fillTop="#e6edf3" fillRight="#aab4c0" fillLeft="#cdd5df" />

      {/* Open ledger book */}
      <PaperStack x={ox + 2.2} y={oy + 3.45} w={0.45} d={0.25} h={5.7}
        topAccent="rgba(196, 217, 67, 0.55)" />

      {/* Wall clock */}
      <WallClock x={ox + 4.7} y0={oy} accent="rgba(196, 217, 67, 0.9)" />
    </g>
  );
}

// ============================================================
// SI Lab — Sable's experiment lab.
// Lab terminal + experiment bench + server rack + log wall.
// ============================================================
export function RdProps({ ox, oy }: { ox: number; oy: number }) {
  const ce = iso(ox + 3, oy + 4.1);
  const logLines: React.ReactNode[] = [];
  for (let i = 0; i < 8; i++) {
    const xL = ox + 0.7;
    const xR = ox + 0.7 + 1.2 + Math.abs(Math.sin(i * 1.3)) * 2.5;
    logLines.push(
      <WallPanel key={`l${i}`}
        face="south" x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
        baseY={28 - i * 2.5} height={1.4}
        color={i % 4 === 0 ? "rgba(179,147,245,0.8)" : "rgba(95,212,240,0.5)"} />
    );
  }
  return (
    <g>
      <FloorRug x0={ox + 1.8} y0={oy + 2.8} x1={ox + 4.2} y1={oy + 5.0}
        color="rgba(179, 147, 245, 0.05)" border="rgba(179, 147, 245, 0.3)" />

      {/* Log wall */}
      <WallPanel face="south" x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={10} height={26} color="rgba(179, 147, 245, 0.10)" />
      {logLines}

      {/* Lab terminal (NW workspace) */}
      <OfficeChair x={ox + 1.05} y={oy + 4.55} accent="#2a1f3a" />
      <Workstation x={ox + 0.6} y={oy + 3.1} w={1.3} d={1.0}
        accent="rgba(179, 147, 245, 0.75)" />

      {/* Experiment bench (center-front) */}
      <LabBench x={ox + 2.4} y={oy + 3.7} w={1.6} d={0.7} />

      {/* Holo plume above the bench */}
      <ellipse cx={ce.x} cy={ce.y - 14} rx={10} ry={2.6} fill="rgba(179, 147, 245, 0.35)" />
      <ellipse cx={ce.x} cy={ce.y - 18} rx={7}  ry={1.8} fill="rgba(179, 147, 245, 0.5)"  />
      <ellipse cx={ce.x} cy={ce.y - 22} rx={4}  ry={1.0} fill="rgba(179, 147, 245, 0.7)"  />

      {/* Server rack (east) */}
      <ServerRack x={ox + 4.5} y={oy + 3.2} w={1.0} d={1.2} h={16} />

      {/* Whiteboard with experiment notes (NE) */}
      <Whiteboard x={ox + 3.6} y={oy + 1.3} w={1.4} accent="rgba(179, 147, 245, 0.6)" />

      {/* Test tube rack on the bench */}
      <TestTubes x={ox + 2.55} y={oy + 3.85}
        colors={[
          "rgba(179, 147, 245, 0.85)",
          "rgba(95, 212, 240, 0.85)",
          "rgba(94, 208, 168, 0.85)",
          "rgba(255, 107, 157, 0.85)",
        ]} />

      {/* Control panel next to the server rack */}
      <ControlPanel x={ox + 4.5} y={oy + 1.5} w={0.85} d={0.35} h={4.5}
        accent="rgba(179, 147, 245, 0.85)" />

      {/* Experiment notes / clipboard on the lab desk */}
      <PaperStack x={ox + 0.8} y={oy + 3.95} w={0.32} d={0.22} h={2.0}
        topAccent="rgba(179, 147, 245, 0.55)" />

      {/* Stack of binders (research log archive) */}
      <BinderStack x={ox + 0.55} y={oy + 4.6} w={0.45} d={0.55}
        colors={["#b393f5", "#5fd4f0", "#cdd5df"]} />

      {/* Wall clock */}
      <WallClock x={ox + 5.2} y0={oy} accent="rgba(179, 147, 245, 0.85)" />
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
