import React from "react";
import { iso } from "../geometry";
import { WallFeature } from "../../state/types";

export type FeatureProps = { ox: number; oy: number; accent: string };

function WallPanel({
  x0, y0: _y0, x1, y1, baseY, height, color,
}: { x0: number; y0: number; x1: number; y1: number; baseY: number; height: number; color: string }) {
  const a = iso(x0 + 0.2, y1 - 0.05), b = iso(x1 - 0.2, y1 - 0.05);
  const points = `${a.x},${a.y - baseY} ${b.x},${b.y - baseY} ${b.x},${b.y - baseY - height} ${a.x},${a.y - baseY - height}`;
  return <polygon points={points} fill={color} />;
}

function withAlpha(hexLike: string, alpha: number): string {
  if (hexLike.startsWith("#") && hexLike.length === 7) {
    const r = parseInt(hexLike.slice(1, 3), 16);
    const g = parseInt(hexLike.slice(3, 5), 16);
    const b = parseInt(hexLike.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hexLike;
}

export function KanbanWall({ ox, oy, accent }: FeatureProps) {
  const cards: React.ReactNode[] = [];
  const headers: React.ReactNode[] = [];
  const colColors = [accent, withAlpha(accent, 0.45), withAlpha(accent, 0.6)];
  const labels = ["TODO", "DOING", "DONE"];
  for (let col = 0; col < 3; col++) {
    const xL = ox + 0.7 + col * 1.55;
    const xR = xL + 1.2;
    cards.push(
      <WallPanel key={`h-${col}`} x0={xL} y0={oy} x1={xR} y1={oy + 0.5} baseY={29} height={3} color={colColors[col]} />,
    );
    const hp = iso((xL + xR) / 2, oy + 0.4);
    headers.push(
      <text key={`ht-${col}`} x={hp.x} y={hp.y - 30.5} textAnchor="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={2.6} fill="#0a0e15" fontWeight="700">
        {labels[col]}
      </text>,
    );
    for (let row = 0; row < 3; row++) {
      cards.push(
        <WallPanel key={`c-${col}-${row}`} x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
          baseY={20 - row * 6} height={4.5} color={withAlpha(accent, 0.35)} />,
      );
    }
  }
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={8} height={28} color={withAlpha(accent, 0.10)} />
      {cards}
      {headers}
    </g>
  );
}

export function TrendsWall({ ox, oy, accent }: FeatureProps) {
  const sparkPts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const ySpike = 26 - Math.sin(t * Math.PI * 2) * 5 - t * 4;
    const p = iso(ox + 1.0 + t * 4.0, oy + 0.4);
    sparkPts.push({ x: p.x, y: p.y - ySpike });
  }
  const path = sparkPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={14} height={32} color={withAlpha(accent, 0.10)} />
      <WallPanel x0={ox + 0.7} y0={oy} x1={ox + 5.3} y1={oy + 0.5} baseY={32} height={1} color={withAlpha(accent, 0.55)} />
      <path d={path} fill="none" stroke={accent} strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

export function MoodboardWall({ ox, oy, accent }: FeatureProps) {
  const swatches: React.ReactNode[] = [];
  for (let i = 0; i < 6; i++) {
    const xs = ox + 0.6 + i * 0.85;
    swatches.push(
      <WallPanel key={i} x0={xs} y0={oy} x1={xs + 0.6} y1={oy + 0.5}
        baseY={22 + (i % 2) * 4} height={6} color={withAlpha(accent, 0.55)} />,
    );
  }
  return (
    <g>
      <WallPanel x0={ox + 0.4} y0={oy} x1={ox + 5.6} y1={oy + 0.5} baseY={14} height={30} color={withAlpha(accent, 0.10)} />
      {swatches}
    </g>
  );
}

export function LedgerWall({ ox, oy, accent }: FeatureProps) {
  const bars: React.ReactNode[] = [];
  for (let i = 0; i < 12; i++) {
    const h = 4 + Math.abs(Math.sin(i * 0.7)) * 14 + (i % 3) * 2;
    const xL = ox + 0.6 + i * 0.4;
    bars.push(
      <WallPanel key={`bar-${i}`} x0={xL} y0={oy} x1={xL + 0.3} y1={oy + 0.5}
        baseY={14} height={h} color={i > 8 ? withAlpha(accent, 0.85) : withAlpha(accent, 0.7)} />,
    );
  }
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={12} height={28} color={withAlpha(accent, 0.10)} />
      {bars}
    </g>
  );
}

export function LogWall({ ox, oy, accent }: FeatureProps) {
  const lines: React.ReactNode[] = [];
  for (let i = 0; i < 8; i++) {
    const xL = ox + 0.7;
    const xR = ox + 0.7 + 1.2 + Math.abs(Math.sin(i * 1.3)) * 2.5;
    lines.push(
      <WallPanel key={`l${i}`} x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
        baseY={28 - i * 2.5} height={1.4}
        color={i % 4 === 0 ? withAlpha(accent, 0.8) : withAlpha(accent, 0.5)} />,
    );
  }
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={10} height={26} color={withAlpha(accent, 0.10)} />
      {lines}
    </g>
  );
}

export function ChatWall({ ox, oy, accent }: FeatureProps) {
  const panels: React.ReactNode[] = [];
  for (let i = 0; i < 3; i++) {
    const xL = ox + 1 + i * 1.3;
    const xR = xL + 1.0;
    panels.push(
      <WallPanel key={`f${i}`} x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
        baseY={16} height={16} color={withAlpha(accent, 0.22)} />,
      <WallPanel key={`h${i}`} x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
        baseY={29} height={3} color={withAlpha(accent, 0.7)} />,
      <WallPanel key={`b${i}`} x0={xL + 0.05} y0={oy} x1={xL + 0.55} y1={oy + 0.5}
        baseY={24} height={3} color={withAlpha(accent, 0.85)} />,
    );
  }
  return <g>{panels}</g>;
}

export function WarMapWall({ ox, oy, accent }: FeatureProps) {
  const c = iso(ox + 3, oy + 0.4);
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={12} height={28} color={withAlpha(accent, 0.10)} />
      {[20, 14, 8].map((r, i) => (
        <ellipse key={`ring-${i}`} cx={c.x} cy={c.y - 22} rx={r} ry={r * 0.45}
          fill="none" stroke={withAlpha(accent, 0.5 + i * 0.15)} strokeWidth={0.6} />
      ))}
      <WallPanel x0={ox + 1.2} y0={oy} x1={ox + 4.8} y1={oy + 0.5} baseY={20} height={1.2} color={withAlpha(accent, 0.85)} />
    </g>
  );
}

export function DataFeedWall({ ox, oy, accent }: FeatureProps) {
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push(
      <WallPanel key={`r${i}`} x0={ox + 0.7} y0={oy} x1={ox + 5.3} y1={oy + 0.5}
        baseY={28 - i * 2} height={0.8} color={withAlpha(accent, 0.55)} />,
    );
  }
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={6} height={30} color={withAlpha(accent, 0.10)} />
      {rows}
    </g>
  );
}

export function ArchiveWallFeature({ ox, oy, accent }: FeatureProps) {
  const cells: React.ReactNode[] = [];
  const cols = 8, rows = 5;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const xL = ox + 0.6 + c * 0.6;
      const xR = xL + 0.55;
      cells.push(
        <WallPanel key={`a-${c}-${r}`} x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
          baseY={26 - r * 4.5} height={3.5} color={withAlpha(accent, 0.4 + (c * r % 3) * 0.1)} />,
      );
    }
  }
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={8} height={28} color={withAlpha(accent, 0.10)} />
      {cells}
    </g>
  );
}

export function DocsWall({ ox, oy, accent }: FeatureProps) {
  const items: React.ReactNode[] = [];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 5; row++) {
      const xL = ox + 0.7 + col * 1.2;
      const xR = xL + 1.0 - (row % 2) * 0.2;
      items.push(
        <WallPanel key={`d-${col}-${row}`} x0={xL} y0={oy} x1={xR} y1={oy + 0.5}
          baseY={28 - row * 5} height={2.6} color={withAlpha(accent, 0.5)} />,
      );
    }
  }
  return (
    <g>
      <WallPanel x0={ox + 0.5} y0={oy} x1={ox + 5.5} y1={oy + 0.5} baseY={8} height={32} color={withAlpha(accent, 0.10)} />
      {items}
    </g>
  );
}

export const WALL_FEATURES: Record<WallFeature, React.FC<FeatureProps>> = {
  kanban: KanbanWall,
  trends: TrendsWall,
  moodboard: MoodboardWall,
  ledger: LedgerWall,
  logwall: LogWall,
  chatwall: ChatWall,
  warmap: WarMapWall,
  datafeed: DataFeedWall,
  archive: ArchiveWallFeature,
  docs: DocsWall,
};
