import { useMemo, useRef, useState, useCallback } from "react";
import { useFactoryStore } from "../state/factoryStore";
import { Room } from "../state/types";
import { GAP, ROOM_W, ROOM_H, WALL_H, iso } from "./geometry";
import { computeFacilityLayout, roomsHash } from "./layout";
import RoomShell from "./RoomShell";
import AvatarLayer from "./AvatarLayer";
import HandoffLayer from "./HandoffLayer";
import Corridors from "./Corridors";
import { detailLevelsFor } from "./viewport";

type ViewBox = { minX: number; minY: number; w: number; h: number };

function computeBaseViewBox(roomList: Room[]): ViewBox {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  roomList.forEach((r) => {
    const x0 = r.col * (ROOM_W + GAP);
    const y0 = r.row * (ROOM_H + GAP);
    const x1 = x0 + ROOM_W;
    const y1 = y0 + ROOM_H;
    [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)].forEach((p) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y - WALL_H);
      maxY = Math.max(maxY, p.y);
    });
  });
  const pad = 60;
  return {
    minX: minX - pad,
    minY: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

// Dev utility — to stress-test 10×10 culling/memoization, paste this into a
// browser console while the app is running. The store does not expose an
// `upsertRoom` action, so we mutate `rooms` directly via Zustand's setState.
// Expected result with culling enabled: smooth pan at 30+ fps, < 300 MB heap.
//
//   const { rooms } = useFactoryStore.getState();
//   const next = { ...rooms };
//   for (let c = 0; c < 10; c++) {
//     for (let r = 0; r < 10; r++) {
//       const id = `stress-${c}-${r}`;
//       if (next[id]) continue;
//       next[id] = {
//         id, name: `R${c}${r}`, col: c, row: r,
//         kit: {
//           primaryTag: "analyst", capacity: 2, accent: "#5fd4f0",
//           stationLayout: "row", wallFeature: "trends", features: [],
//         },
//         occupants: [], createdAt: 0,
//       };
//     }
//   }
//   useFactoryStore.setState({ rooms: next });

export default function SvgFactoryFloor() {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rooms = useFactoryStore((s) => s.rooms);
  const layout = useMemo(
    () => computeFacilityLayout(Object.values(rooms)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomsHash(Object.values(rooms))],
  );
  const base = useMemo(() => computeBaseViewBox(Object.values(rooms)), [rooms]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);

  const ordered = useMemo(
    () =>
      Object.keys(rooms).sort((a, b) => {
        const ra = rooms[a], rb = rooms[b];
        return ra.row + ra.col - (rb.row + rb.col);
      }),
    [rooms],
  );

  // Apply zoom + pan around the scene center
  const zoomedW = base.w / zoom;
  const zoomedH = base.h / zoom;
  const cx = base.minX + base.w / 2 + pan.x;
  const cy = base.minY + base.h / 2 + pan.y;
  const vbMinX = cx - zoomedW / 2;
  const vbMinY = cy - zoomedH / 2;
  const vb = `${vbMinX} ${vbMinY} ${zoomedW} ${zoomedH}`;

  // TEMP DIAG: on-screen HUD so the user can see floor state even when the
  // canvas blanks (Tauri ⌘⌥J doesn't open browser devtools the usual way).
  // Updated every render — when blanks happen, screenshot and we'll see why.
  const diagText = [
    `zoom ${zoom.toFixed(2)} · rooms ${Object.keys(rooms).length}`,
    `pan  ${pan.x.toFixed(0)}, ${pan.y.toFixed(0)}`,
    `vb   ${vbMinX.toFixed(0)}, ${vbMinY.toFixed(0)}  ${zoomedW.toFixed(0)}×${zoomedH.toFixed(0)}`,
    `base ${base.minX.toFixed(0)}, ${base.minY.toFixed(0)}  ${base.w.toFixed(0)}×${base.h.toFixed(0)}`,
  ].join("\n");

  // Viewport culling: re-derive detail levels only when the visible rectangle
  // or the rooms list changes. Off-viewport rooms drop down to "shell" or get
  // skipped entirely. The "shell" tier gets a 1-cell margin in iso units so
  // panning doesn't reveal blank cells before they upgrade.
  const detailLevels = useMemo(
    () => detailLevelsFor(
      Object.values(rooms),
      { minX: vbMinX, minY: vbMinY, maxX: vbMinX + zoomedW, maxY: vbMinY + zoomedH },
      0,
      // ROOM_W * TW/2 ≈ 192px per room horizontally in iso; one-cell margin
      // is comfortably covered by 220 world units.
      220,
    ),
    [rooms, vbMinX, vbMinY, zoomedW, zoomedH],
  );

  const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = Math.exp(-e.deltaY * 0.0015);
    setZoom((z) => clampZoom(z * factor));
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      // Don't pan when starting on an avatar — that's a click on the avatar.
      if (target.closest("#avatar-layer > *")) return;
      isDragging.current = true;
      const startX = e.clientX;
      const startY = e.clientY;
      const startPan = { ...pan };
      const containerW = containerRef.current?.clientWidth || 1;
      const containerH = containerRef.current?.clientHeight || 1;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const vbW = base.w / zoom;
        const vbH = base.h / zoom;
        // Drag content with the cursor: pan moves opposite to cursor delta in
        // viewBox space.
        let nextX = startPan.x - (dx * vbW) / containerW;
        let nextY = startPan.y - (dy * vbH) / containerH;
        // Limit how far the camera center can wander from the room hull. The
        // base bbox includes 60 units of padding; clamping to (base.w/2 - 60)
        // keeps the viewport center inside the actual room area, which means
        // at least half of every viewport always contains floor. Without
        // this, dragging past the rooms made the SVG render the empty
        // padding area — looked blank.
        const maxX = base.w / 2 - 60;
        const maxY = base.h / 2 - 60;
        if (maxX > 0) nextX = Math.max(-maxX, Math.min(maxX, nextX));
        if (maxY > 0) nextY = Math.max(-maxY, Math.min(maxY, nextY));
        setPan({ x: nextX, y: nextY });
      };
      const onUp = () => {
        isDragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [pan, zoom, base.w, base.h],
  );

  const zoomIn = () => setZoom((z) => clampZoom(z * ZOOM_STEP));
  const zoomOut = () => setZoom((z) => clampZoom(z / ZOOM_STEP));
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      ref={containerRef}
      className="stage"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        cursor: isDragging.current ? "grabbing" : "grab",
      }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
    >
      <svg
        ref={svgRef}
        id="iso-svg"
        className="stage-svg"
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <defs>
          <radialGradient id="ground-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#5fd4f0" stopOpacity={0.06} />
            <stop offset="100%" stopColor="#5fd4f0" stopOpacity={0} />
          </radialGradient>
        </defs>
        <Corridors strips={layout.corridors} />
        {ordered.map((id) => (
          <RoomShell
            key={id}
            roomId={id}
            doors={layout.doors.get(id)}
            detailLevel={detailLevels.get(id) ?? "full"}
          />
        ))}
      </svg>
      <AvatarLayer svgRef={svgRef} zoom={zoom} pan={pan} detailLevels={detailLevels} />
      <HandoffLayer svgRef={svgRef} zoom={zoom} />
      {/* TEMP DIAG HUD — survives a blank canvas so we can see state */}
      <pre
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          margin: 0,
          padding: "6px 10px",
          background: "rgba(0,0,0,0.7)",
          color: "#5fd4f0",
          font: "11px/1.4 ui-monospace, monospace",
          pointerEvents: "none",
          zIndex: 999,
          whiteSpace: "pre",
          borderRadius: 4,
        }}
      >
        {diagText}
      </pre>
      <ZoomControls
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onReset={resetView}
      />
    </div>
  );
}

function ZoomControls({
  zoom, onZoomIn, onZoomOut, onReset,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="zoom-controls" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className="zoom-btn"
        onClick={onZoomIn}
        title="Zoom in (mouse wheel up)"
        disabled={zoom >= MAX_ZOOM - 0.001}
      >
        +
      </button>
      <button
        className="zoom-readout"
        onClick={onReset}
        title="Reset to fit"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        className="zoom-btn"
        onClick={onZoomOut}
        title="Zoom out (mouse wheel down)"
        disabled={zoom <= MIN_ZOOM + 0.001}
      >
        −
      </button>
    </div>
  );
}
