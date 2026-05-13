import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, SoftShadows } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFactoryStore } from "../state/factoryStore";
import Room3D, { ROOM_W, ROOM_H, GAP } from "./Room3D";
import Avatar3D from "./Avatar3D";
import { readThemePalette, ThemeColors } from "./themeColors";

const MIN_ZOOM = 16;
const MAX_ZOOM = 90;
const DEFAULT_ZOOM = 34;
const ZOOM_STEP = 1.2;

function useThemePalette(): ThemeColors {
  const [palette, setPalette] = useState<ThemeColors>(() => readThemePalette());
  useEffect(() => {
    const obs = new MutationObserver(() => setPalette(readThemePalette()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "class"],
    });
    return () => obs.disconnect();
  }, []);
  return palette;
}

/** Locked iso ortho camera — fixed angle, only zoom changes. */
function CameraRig({
  zoom,
  target,
}: {
  zoom: number;
  target: [number, number, number];
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.zoom = zoom;
    const dist = 60;
    cam.position.set(target[0] + dist * 0.6, dist * 0.55, target[2] + dist * 0.6);
    cam.lookAt(new THREE.Vector3(...target));
    cam.left = -size.width / 2;
    cam.right = size.width / 2;
    cam.top = size.height / 2;
    cam.bottom = -size.height / 2;
    cam.near = 0.1;
    cam.far = 500;
    cam.updateProjectionMatrix();
  }, [camera, zoom, target, size.width, size.height]);
  return null;
}

/**
 * Three-point soft lighting tuned for the parchment palette. The key is a
 * warm directional from above-back-right; a cooler fill from the opposite
 * side; and a hemisphere light that gives the scene its overall warmth and
 * subtle vertical falloff. No bright accent lights — softness comes from
 * material + contact shadow, not aggressive rim.
 */
function Lighting({ palette }: { palette: ThemeColors }) {
  const keyColor = useMemo(
    () => palette.accentWarm.clone().lerp(new THREE.Color("#ffffff"), 0.45),
    [palette],
  );
  const fillColor = useMemo(
    () => palette.ink0.clone().lerp(palette.accent, 0.15),
    [palette],
  );
  return (
    <>
      <hemisphereLight
        color={palette.ink0}
        groundColor={palette.floor}
        intensity={1.4}
      />
      <directionalLight
        color={keyColor}
        position={[18, 24, 12]}
        intensity={2.4}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-far={60}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-bias={-0.0008}
      />
      <directionalLight color={fillColor} position={[-12, 10, -6]} intensity={0.6} />
      <ambientLight color={palette.ink0} intensity={0.35} />
    </>
  );
}

/**
 * A soft tinted "ground halo" the room cluster sits on — no hard ring, just
 * a gentle radial gradient that grounds the scene against the canvas.
 */
function Ground({
  palette,
  center,
}: {
  palette: ThemeColors;
  center: [number, number, number];
}) {
  return (
    <>
      <mesh position={[center[0], -0.12, center[2]]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[26, 64]} />
        <meshStandardMaterial color={palette.bg1} roughness={1} metalness={0} />
      </mesh>
      <mesh position={[center[0], -0.115, center[2]]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[16, 64]} />
        <meshBasicMaterial
          color={palette.accentWarm}
          transparent
          opacity={0.04}
        />
      </mesh>
    </>
  );
}

function AvatarsLayer({ palette }: { palette: ThemeColors }) {
  const roles = useFactoryStore((s) => s.roles);
  const rooms = useFactoryStore((s) => s.rooms);
  const agents = useFactoryStore((s) => s.agents);
  const selected = useFactoryStore((s) => s.selectedAgent);
  const selectAgent = useFactoryStore((s) => s.selectAgent);

  return (
    <>
      {Object.values(roles).map((role) => {
        const room = rooms[role.room];
        const agent = agents[role.id];
        if (!room || !agent) return null;
        const x = room.col * (ROOM_W + GAP) + ROOM_W / 2;
        const z = room.row * (ROOM_H + GAP) + ROOM_H * 0.62;
        return (
          <Avatar3D
            key={role.id}
            role={role}
            position={[x, 0, z]}
            state={agent.state}
            selected={selected === role.id}
            palette={palette}
            onClick={() => selectAgent(role.id)}
          />
        );
      })}
    </>
  );
}

export default function ThreeFactoryFloor() {
  const palette = useThemePalette();
  const rooms = useFactoryStore((s) => s.rooms);
  const roles = useFactoryStore((s) => s.roles);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const containerRef = useRef<HTMLDivElement>(null);

  const roleByRoom = useMemo(() => {
    const out: Record<string, typeof roles[string] | null> = {};
    Object.values(rooms).forEach((r) => {
      const occupantId = r.occupants?.[0] ?? null;
      out[r.id] = occupantId ? roles[occupantId] ?? null : null;
    });
    return out;
  }, [rooms, roles]);

  const target = useMemo<[number, number, number]>(() => {
    const list = Object.values(rooms);
    if (list.length === 0) return [6, 0, 6];
    let cx = 0, cz = 0;
    list.forEach((r) => {
      cx += r.col * (ROOM_W + GAP) + ROOM_W / 2;
      cz += r.row * (ROOM_H + GAP) + ROOM_H / 2;
    });
    return [cx / list.length, 0, cz / list.length];
  }, [rooms]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      setZoom((z) => {
        const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={containerRef} style={{ position: "absolute", inset: 0 }}>
      <Canvas
        style={{ width: "100%", height: "100%", display: "block" }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        dpr={[1, 2]}
        orthographic
        camera={{ position: [40, 40, 40], zoom: DEFAULT_ZOOM, near: 0.1, far: 500 }}
        shadows
      >
        {/* Soft shadows globally — small percentage of cost vs hard maps but
            night-and-day quality boost. */}
        <SoftShadows size={28} samples={10} focus={0.6} />
        {/* HDR env at low intensity — just enough to give monitors / metal
            details soft realistic highlights. Roughness on floors+walls is
            high so they barely reflect the env, preserving the warm
            parchment palette. */}
        <Environment preset="apartment" background={false} environmentIntensity={0.35} />
        <CameraRig zoom={zoom} target={target} />
        <Lighting palette={palette} />
        <Ground palette={palette} center={target} />

        {Object.values(rooms).map((room) => (
          <Room3D
            key={room.id}
            room={room}
            role={roleByRoom[room.id] ?? null}
            palette={palette}
          />
        ))}
        <AvatarsLayer palette={palette} />

        {/* One global contact-shadow plane under the cluster — much cheaper
            than per-object shadow maps and gives the scene "weight". */}
        <ContactShadows
          position={[target[0], 0.005, target[2]]}
          opacity={0.55}
          scale={42}
          blur={2.2}
          far={6}
          resolution={1024}
          color={palette.bg0}
        />
      </Canvas>

      <ZoomControls
        zoom={zoom}
        onIn={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
        onOut={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
        onReset={() => setZoom(DEFAULT_ZOOM)}
      />
    </div>
  );
}

function ZoomControls({
  zoom,
  onIn,
  onOut,
  onReset,
}: {
  zoom: number;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="zoom-controls" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className="zoom-btn"
        onClick={onIn}
        title="Zoom in"
        disabled={zoom >= MAX_ZOOM - 0.001}
      >
        +
      </button>
      <button
        className="zoom-readout"
        onClick={onReset}
        title="Reset to fit"
      >
        {Math.round((zoom / DEFAULT_ZOOM) * 100)}%
      </button>
      <button
        className="zoom-btn"
        onClick={onOut}
        title="Zoom out"
        disabled={zoom <= MIN_ZOOM + 0.001}
      >
        −
      </button>
    </div>
  );
}
