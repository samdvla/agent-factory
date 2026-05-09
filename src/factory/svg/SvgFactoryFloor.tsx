import { useMemo, useRef, useState, useCallback } from "react";
import { ROOMS } from "../state/fixtures";
import { GAP, ROOM_W, ROOM_H, WALL_H, iso } from "./geometry";
import RoomShell from "./RoomShell";
import AvatarLayer from "./AvatarLayer";
import HandoffLayer from "./HandoffLayer";
import Corridors from "./Corridors";

type ViewBox = { minX: number; minY: number; w: number; h: number };

function computeBaseViewBox(): ViewBox {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  Object.values(ROOMS).forEach((r) => {
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

export default function SvgFactoryFloor() {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const base = useMemo(computeBaseViewBox, []);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);

  const ordered = useMemo(
    () =>
      Object.keys(ROOMS).sort((a, b) => {
        const ra = ROOMS[a], rb = ROOMS[b];
        return ra.row + ra.col - (rb.row + rb.col);
      }),
    [],
  );

  // Apply zoom + pan around the scene center
  const zoomedW = base.w / zoom;
  const zoomedH = base.h / zoom;
  const cx = base.minX + base.w / 2 + pan.x;
  const cy = base.minY + base.h / 2 + pan.y;
  const vb = `${cx - zoomedW / 2} ${cy - zoomedH / 2} ${zoomedW} ${zoomedH}`;

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
        setPan({
          x: startPan.x - (dx * vbW) / containerW,
          y: startPan.y - (dy * vbH) / containerH,
        });
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
        <Corridors />
        {ordered.map((id) => (
          <RoomShell key={id} roomId={id} />
        ))}
      </svg>
      <AvatarLayer svgRef={svgRef} zoom={zoom} pan={pan} />
      <HandoffLayer svgRef={svgRef} zoom={zoom} />
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
