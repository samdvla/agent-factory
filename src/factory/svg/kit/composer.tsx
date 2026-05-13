import React from "react";
import { RoomKit } from "../../state/types";
import { WALL_FEATURES } from "./wallFeatures";
import {
  FloorRug, Workstation, OfficeChair, ConferenceTable, MeetingChair,
  DraftingTable, LabBench, ExecutiveDesk, Bookshelf, BinderStack, Plant,
  ColorRack, FilingCabinet, Printer, ServerRack, PhoneBank, Headset,
  CallQueueBoard, TerminalRack, LawBookshelf, FileSafe, ArchiveWall,
  LongCounter, OpenDeskRow,
  Carousel, TokenMeter, KpiPanel, CableTray, DocStamp,
} from "../furniture";

export type StationPos = { x: number; y: number; label: string };

export function layoutStations(kit: RoomKit): StationPos[] {
  const c = Math.max(1, Math.min(6, kit.capacity));
  const stations: StationPos[] = [];
  switch (kit.stationLayout) {
    case "row": {
      for (let i = 0; i < c; i++) {
        const x = 1.4 + ((4.6 - 1.4) * (i + 0.5)) / c;
        stations.push({ x, y: 3.2, label: `station ${i + 1}` });
      }
      break;
    }
    case "cluster": {
      // Tuned to align with the chair seats in the new Strategy Room
      // composition (see `iso/strategyRoom.tsx`). station[0] is the
      // "boss seat" — east side, at the head of the oval table.
      const positions = [
        { x: 4.53, y: 2.25 }, { x: 3.87, y: 1.17 },
        { x: 3.87, y: 3.69 }, { x: 1.17, y: 2.25 },
      ];
      for (let i = 0; i < c && i < positions.length; i++) {
        stations.push({ ...positions[i], label: `seat ${i + 1}` });
      }
      break;
    }
    case "central": {
      // Centered horizontally; first station sits at the workstation chair,
      // second is the "visitor" spot in front of the desk. Used by creative,
      // finance, and rd rooms — recipes in iso/rooms.tsx place chairs to
      // match these coords.
      const positions = [
        { x: 3.0, y: 3.4 }, { x: 3.0, y: 4.6 },
      ];
      for (let i = 0; i < c && i < positions.length; i++) {
        stations.push({ ...positions[i], label: `bench ${i + 1}` });
      }
      break;
    }
    case "perimeter": {
      const south = [
        { x: 1.6, y: 4.6 }, { x: 2.7, y: 4.6 },
        { x: 3.8, y: 4.6 }, { x: 4.7, y: 4.6 },
      ];
      const east = [
        { x: 4.7, y: 1.7 }, { x: 4.7, y: 2.6 },
      ];
      const all = [...south, ...east];
      for (let i = 0; i < c && i < all.length; i++) {
        stations.push({ ...all[i], label: `post ${i + 1}` });
      }
      break;
    }
  }
  return stations;
}

function renderStations(kit: RoomKit, ox: number, oy: number): React.ReactNode {
  const stations = layoutStations(kit);
  return stations.map((s, i) => (
    <g key={`s${i}`}>
      <Workstation x={ox + s.x - 0.65} y={oy + s.y - 0.4} w={1.3} d={1.0} accent={kit.accent} />
      <OfficeChair x={ox + s.x - 0.3} y={oy + s.y + 1.1} accent="var(--bg-3)" />
    </g>
  ));
}

function renderCentralFeature(kit: RoomKit, ox: number, oy: number): React.ReactNode {
  if (kit.stationLayout === "central") {
    if (kit.features.includes("drafting")) {
      return <DraftingTable x={ox + 2.4} y={oy + 2.6} w={1.6} d={1.0} />;
    }
    if (kit.features.includes("lab-bench")) {
      return <LabBench x={ox + 2.4} y={oy + 2.6} w={1.6} d={0.9} />;
    }
    if (kit.features.includes("safe")) {
      return <ExecutiveDesk x={ox + 2.05} y={oy + 2.6} w={1.95} d={1.0} accent={kit.accent} />;
    }
  }
  if (kit.stationLayout === "cluster" && kit.features.includes("conference-table")) {
    return (
      <>
        <ConferenceTable x={ox + 1.7} y={oy + 2.7} w={2.6} d={1.4} glowColor={kit.accent} />
        <MeetingChair x={ox + 2.0} y={oy + 2.05} accent="#3a4a5e" />
        <MeetingChair x={ox + 2.85} y={oy + 2.05} accent="#3a4a5e" />
        <MeetingChair x={ox + 3.7} y={oy + 2.05} accent="#3a4a5e" />
      </>
    );
  }
  return null;
}

function renderAncillary(kit: RoomKit, ox: number, oy: number): React.ReactNode {
  const items: React.ReactNode[] = [];
  if (kit.features.includes("bookshelf")) {
    items.push(<Bookshelf key="bs" x={ox + 5.0} y={oy + 2.6} w={0.55} depth={1.6} h={11}
      spineColors={[kit.accent, "var(--ink-1)", "var(--bg-3)"]} />);
  }
  if (kit.features.includes("law-shelf")) {
    items.push(<LawBookshelf key="ls" x={ox + 5.0} y={oy + 2.6} h={11} />);
  }
  if (kit.features.includes("binder-stack")) {
    items.push(<BinderStack key="bn" x={ox + 0.6} y={oy + 4.55} w={0.55} d={0.6} colors={[kit.accent, "var(--ink-1)"]} />);
  }
  if (kit.features.includes("color-rack")) {
    items.push(<ColorRack key="cr" x={ox + 5.0} y={oy + 2.8} />);
  }
  if (kit.features.includes("file-cabinet")) {
    items.push(<FilingCabinet key="fc" x={ox + 0.55} y={oy + 0.6} accent={kit.accent} />);
  }
  if (kit.features.includes("printer")) {
    items.push(<Printer key="pr" x={ox + 0.55} y={oy + 4.5} accent={kit.accent} />);
  }
  if (kit.features.includes("server-rack")) {
    items.push(<ServerRack key="sr" x={ox + 4.5} y={oy + 3.2} w={1.0} d={1.2} h={16} />);
  }
  if (kit.features.includes("phone-bank")) {
    items.push(<PhoneBank key="pb" x={ox + 1.0} y={oy + 0.6} count={4} accent={kit.accent} />);
  }
  if (kit.features.includes("headset")) {
    items.push(<Headset key="hs" x={ox + 4.6} y={oy + 4.4} accent={kit.accent} />);
  }
  if (kit.features.includes("queue-board")) {
    items.push(<CallQueueBoard key="qb" x={ox + 0.6} y={oy + 1.4} accent={kit.accent} />);
  }
  if (kit.features.includes("terminal-rack")) {
    items.push(<TerminalRack key="tr" x={ox + 1.6} y={oy + 1.0} w={1.6} accent={kit.accent} />);
  }
  if (kit.features.includes("file-safe")) {
    items.push(<FileSafe key="fs" x={ox + 4.85} y={oy + 3.2} accent={kit.accent} />);
  }
  if (kit.features.includes("archive-wall")) {
    items.push(<ArchiveWall key="aw" x={ox + 0.5} y={oy + 1.5} w={4} h={11} />);
  }
  if (kit.stationLayout === "perimeter" && kit.features.includes("phone-bank")) {
    items.push(<LongCounter key="lc" x={ox + 1.4} y={oy + 4.0} w={3.4} d={1.0} accent="var(--bg-3)" />);
    items.push(<OpenDeskRow key="od" x={ox + 1.4} y={oy + 4.0} count={4} accent="var(--bg-3)" />);
  }
  if (kit.features.includes("kpi-panel")) {
    items.push(<KpiPanel key="kp" x={ox + 1.5} y={oy + 0.7} w={1.4} accent={kit.accent} />);
  }
  if (kit.features.includes("token-meter")) {
    items.push(<TokenMeter key="tm" x={ox + 4.7} y={oy + 4.5} accent={kit.accent} />);
  }
  if (kit.features.includes("carousel")) {
    items.push(<Carousel key="ca" x={ox + 4.5} y={oy + 4.5} />);
  }
  if (kit.features.includes("cable-tray")) {
    items.push(<CableTray key="ct" x={ox + 1.6} y={oy + 4.0} w={3.0} />);
  }
  if (kit.features.includes("doc-stamp")) {
    items.push(<DocStamp key="ds" x={ox + 4.4} y={oy + 4.5} accent={kit.accent} />);
  }
  items.push(<Plant key="pl" x={ox + 5.25} y={oy + 5.0} />);
  return items;
}

export function composeRoom(kit: RoomKit, ox: number, oy: number): React.ReactNode {
  const Wall = WALL_FEATURES[kit.wallFeature];
  return (
    <g className={`composed-room tag-${kit.primaryTag}`}>
      <FloorRug x0={ox + 1.4} y0={oy + 2.8} x1={ox + 4.6} y1={oy + 4.8}
        color={`${kit.accent}10`} border={`${kit.accent}40`} />
      <g className="composed-wall-feature">
        <Wall ox={ox} oy={oy} accent={kit.accent} />
      </g>
      {renderCentralFeature(kit, ox, oy)}
      {renderStations(kit, ox, oy)}
      {renderAncillary(kit, ox, oy)}
    </g>
  );
}
