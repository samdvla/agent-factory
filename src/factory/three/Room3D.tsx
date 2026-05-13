import { useMemo } from "react";
import * as THREE from "three";
import { RoundedBox } from "@react-three/drei";
import { Role, Room, RoomTag } from "../state/types";
import { ThemeColors } from "./themeColors";

export const ROOM_W = 6;
export const ROOM_H = 6;
export const GAP = 0.6;
export const WALL_H = 2.0;
export const WALL_T = 0.18;

/**
 * Procedural room with soft, rounded forms. No wireframe grid, no neon outline
 * stripes — modern and elegant. The accent is delivered as a soft inner-floor
 * tint and a subtle warm rim along the wall top, not as bright outlines.
 */
export default function Room3D({
  room,
  role,
  palette,
}: {
  room: Room;
  role: Role | null;
  palette: ThemeColors;
}) {
  const x0 = room.col * (ROOM_W + GAP);
  const z0 = room.row * (ROOM_H + GAP);
  const tag = (room.kit?.primaryTag ?? "analyst") as RoomTag;
  const accentHex = role?.hex ?? "#d97757";
  const accent = useMemo(() => new THREE.Color(accentHex), [accentHex]);

  // Floor: warm parchment from theme, lightly accent-tinted.
  const floorTint = useMemo(() => palette.floor.clone().lerp(accent, 0.04), [palette.floor, accent]);
  // Glass tint — very subtle warm white that picks up the role color faintly.
  // The walls are translucent and refractive, so the tint should be mild or
  // the room contents wash out.
  const glassTint = useMemo(() => palette.ink0.clone().lerp(accent, 0.12), [palette.ink0, accent]);

  return (
    <group position={[x0, 0, z0]}>
      {/* Floor — RoundedBox slab so the corners catch a tiny highlight */}
      <RoundedBox
        args={[ROOM_W, 0.12, ROOM_H]}
        radius={0.04}
        smoothness={4}
        creaseAngle={0.6}
        position={[ROOM_W / 2, -0.06, ROOM_H / 2]}
        receiveShadow
      >
        <meshStandardMaterial color={floorTint} roughness={0.95} metalness={0} />
      </RoundedBox>

      {/* Subtle accent radial near the back-inner corner (carries the room's
          identity color without resorting to a neon outline). */}
      <mesh
        position={[ROOM_W * 0.32, 0.015, ROOM_H * 0.42]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <circleGeometry args={[2.2, 48]} />
        <meshBasicMaterial color={accent} transparent opacity={0.06} />
      </mesh>

      {/* Two glass back walls — translucent, lightly frosted, tinted with the
          role accent so each room reads as its own bubble. */}
      <RoundedBox
        args={[ROOM_W, WALL_H, WALL_T]}
        radius={0.06}
        smoothness={4}
        creaseAngle={0.6}
        position={[ROOM_W / 2, WALL_H / 2, WALL_T / 2]}
        castShadow={false}
        receiveShadow={false}
      >
        <meshPhysicalMaterial
          color={glassTint}
          transmission={0.92}
          roughness={0.25}
          thickness={0.35}
          ior={1.45}
          clearcoat={0.55}
          clearcoatRoughness={0.25}
          attenuationColor={accent}
          attenuationDistance={3.2}
          transparent
          opacity={1}
        />
      </RoundedBox>
      <RoundedBox
        args={[WALL_T, WALL_H, ROOM_H]}
        radius={0.06}
        smoothness={4}
        creaseAngle={0.6}
        position={[WALL_T / 2, WALL_H / 2, ROOM_H / 2]}
        castShadow={false}
        receiveShadow={false}
      >
        <meshPhysicalMaterial
          color={glassTint}
          transmission={0.92}
          roughness={0.25}
          thickness={0.35}
          ior={1.45}
          clearcoat={0.55}
          clearcoatRoughness={0.25}
          attenuationColor={accent}
          attenuationDistance={3.2}
          transparent
          opacity={1}
        />
      </RoundedBox>

      {/* Soft warm top-cap on each wall — a thin emissive bar that reads as
          "light catching the upper edge of the glass". This is what sells the
          glass illusion without needing screen-space refraction. */}
      <mesh position={[ROOM_W / 2, WALL_H - 0.025, WALL_T / 2]}>
        <boxGeometry args={[ROOM_W + 0.04, 0.04, WALL_T + 0.04]} />
        <meshStandardMaterial
          color={palette.ink0}
          emissive={accent}
          emissiveIntensity={0.4}
          roughness={0.4}
          metalness={0.0}
        />
      </mesh>
      <mesh position={[WALL_T / 2, WALL_H - 0.025, ROOM_H / 2]}>
        <boxGeometry args={[WALL_T + 0.04, 0.04, ROOM_H + 0.04]} />
        <meshStandardMaterial
          color={palette.ink0}
          emissive={accent}
          emissiveIntensity={0.4}
          roughness={0.4}
          metalness={0.0}
        />
      </mesh>

      {/* Soft accent glow on the back-wall inner face — visible through the
          glass as a tinted wash. */}
      <mesh position={[ROOM_W / 2, WALL_H * 0.55, WALL_T + 0.04]}>
        <planeGeometry args={[ROOM_W * 0.7, WALL_H * 0.8]} />
        <meshBasicMaterial color={accent} transparent opacity={0.05} />
      </mesh>

      {/* Per-kit furniture group */}
      <Furniture tag={tag} palette={palette} accent={accent} />
    </group>
  );
}

/* ─── Per-kit furniture ───────────────────────────────────────────── */

function Furniture({
  tag,
  palette,
  accent,
}: {
  tag: RoomTag;
  palette: ThemeColors;
  accent: THREE.Color;
}) {
  switch (tag) {
    case "bridge":   return <BridgeKit palette={palette} accent={accent} />;
    case "analyst":  return <AnalystKit palette={palette} accent={accent} />;
    case "creative": return <CreativeKit palette={palette} accent={accent} />;
    case "copy":     return <CopyKit palette={palette} accent={accent} />;
    case "comms":    return <CommsKit palette={palette} accent={accent} />;
    case "finance":  return <FinanceKit palette={palette} accent={accent} />;
    case "rd":       return <RdKit palette={palette} accent={accent} />;
    case "ops":      return <OpsKit palette={palette} accent={accent} />;
    case "legal":    return <LegalKit palette={palette} accent={accent} />;
    case "archive":  return <ArchiveKit palette={palette} accent={accent} />;
    case "dev":      return <DevKit palette={palette} accent={accent} />;
    default:         return <AnalystKit palette={palette} accent={accent} />;
  }
}

type KitProps = { palette: ThemeColors; accent: THREE.Color };

/* Reusable primitives ----------------------------------------------- */

function Desk({
  x, z, w = 1.6, d = 0.7, h = 0.6, color: _color, rotY = 0, accent,
}: {
  x: number; z: number; w?: number; d?: number; h?: number;
  color: THREE.Color;
  rotY?: number;
  accent?: THREE.Color;
}) {
  // Modern desk: brushed-graphite top + dark steel cantilever frame +
  // optional under-desk accent glow strip. Doesn't use the warm wood tone
  // from the room palette — desks should read as futuristic furniture, not
  // 90s office.
  const top = useMemo(() => new THREE.Color("#1d2027"), []);     // graphite
  const frame = useMemo(() => new THREE.Color("#0d0f13"), []);   // near-black steel
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]}>
      {/* Thin floating slab top */}
      <RoundedBox
        args={[w, 0.04, d]}
        radius={0.015}
        smoothness={5}
        position={[0, h, 0]}
        castShadow
        receiveShadow
      >
        <meshPhysicalMaterial
          color={top}
          roughness={0.32}
          metalness={0.55}
          clearcoat={0.6}
          clearcoatRoughness={0.18}
        />
      </RoundedBox>
      {/* Beveled underside (a tiny lighter slab under the top creates the
          "floating" look) */}
      <RoundedBox
        args={[w * 0.97, 0.012, d * 0.97]}
        radius={0.008}
        smoothness={3}
        position={[0, h - 0.025, 0]}
      >
        <meshStandardMaterial
          color={top}
          roughness={0.55}
          metalness={0.6}
        />
      </RoundedBox>
      {/* Cantilever frame — two thin angled struts instead of bulky side
          panels. Reads as modern furniture design, not chunky office. */}
      <RoundedBox
        args={[0.04, h - 0.06, 0.04]}
        radius={0.012}
        smoothness={3}
        position={[-w / 2 + 0.12, (h - 0.06) / 2, 0]}
        castShadow
      >
        <meshStandardMaterial color={frame} roughness={0.42} metalness={0.7} />
      </RoundedBox>
      <RoundedBox
        args={[0.04, h - 0.06, 0.04]}
        radius={0.012}
        smoothness={3}
        position={[w / 2 - 0.12, (h - 0.06) / 2, 0]}
        castShadow
      >
        <meshStandardMaterial color={frame} roughness={0.42} metalness={0.7} />
      </RoundedBox>
      {/* Floor crossbars to ground the legs */}
      <RoundedBox
        args={[0.32, 0.025, 0.04]}
        radius={0.01}
        smoothness={3}
        position={[-w / 2 + 0.12, 0.0125, 0]}
      >
        <meshStandardMaterial color={frame} roughness={0.42} metalness={0.7} />
      </RoundedBox>
      <RoundedBox
        args={[0.32, 0.025, 0.04]}
        radius={0.01}
        smoothness={3}
        position={[w / 2 - 0.12, 0.0125, 0]}
      >
        <meshStandardMaterial color={frame} roughness={0.42} metalness={0.7} />
      </RoundedBox>
      {/* Subtle accent glow strip on the desk front lip — a thin emissive
          line. Tints to the room accent when provided. */}
      {accent && (
        <mesh position={[0, h - 0.035, d / 2 + 0.001]}>
          <planeGeometry args={[w * 0.88, 0.008]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={1.2}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

function Monitor({
  x, z, h = 0.6, rotY = 0, screen, w = 1.15,
}: {
  x: number; z: number; h?: number; rotY?: number; screen: THREE.Color;
  /** Total housing width — defaults to ultrawide ~21:9. Use smaller for
   *  tighter desks. */
  w?: number;
}) {
  // Ultrawide aspect ~21:9 — way more "futuristic command center" than a
  // standard 16:10 office display.
  const screenW = w - 0.08;
  const screenH = screenW / 2.6;
  const housingThickness = 0.025;
  const yScreenCenter = h + 0.34;
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]}>
      {/* Stand base — wider for the bigger panel */}
      <RoundedBox
        args={[0.36, 0.025, 0.18]}
        radius={0.008}
        smoothness={4}
        position={[0, h + 0.014, 0]}
        castShadow
      >
        <meshPhysicalMaterial
          color="#0f1116"
          roughness={0.32}
          metalness={0.7}
          clearcoat={0.4}
        />
      </RoundedBox>
      {/* Stand neck — a thin flat strut, looks more modern than a cylinder */}
      <RoundedBox
        args={[0.06, 0.18, 0.02]}
        radius={0.008}
        smoothness={3}
        position={[0, h + 0.14, 0]}
        castShadow
      >
        <meshStandardMaterial color="#0f1116" roughness={0.45} metalness={0.65} />
      </RoundedBox>
      {/* Housing — ultrawide slab with thin bezels */}
      <RoundedBox
        args={[w, screenH + 0.05, housingThickness]}
        radius={0.012}
        smoothness={5}
        position={[0, yScreenCenter, -0.018]}
        castShadow
      >
        <meshPhysicalMaterial
          color="#08090c"
          roughness={0.28}
          metalness={0.6}
          clearcoat={0.5}
          clearcoatRoughness={0.18}
        />
      </RoundedBox>
      {/* Display panel — ultrawide, emissive */}
      <mesh position={[0, yScreenCenter, -0.003]}>
        <planeGeometry args={[screenW, screenH]} />
        <meshStandardMaterial
          color={screen}
          emissive={screen}
          emissiveIntensity={1.3}
          toneMapped={false}
        />
      </mesh>
      {/* Subtle bezel under-glow (rim light spillover) */}
      <mesh position={[0, yScreenCenter - screenH / 2 - 0.01, -0.005]}>
        <planeGeometry args={[screenW * 0.96, 0.006]} />
        <meshStandardMaterial
          color={screen}
          emissive={screen}
          emissiveIntensity={0.9}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function Chair({ x, z, color, rotY = 0 }: { x: number; z: number; color: THREE.Color; rotY?: number; }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]}>
      {/* Seat */}
      <RoundedBox
        args={[0.42, 0.08, 0.42]}
        radius={0.06}
        smoothness={5}
        position={[0, 0.34, 0]}
        castShadow
      >
        <meshStandardMaterial color={color} roughness={0.85} />
      </RoundedBox>
      {/* Backrest */}
      <RoundedBox
        args={[0.42, 0.5, 0.06]}
        radius={0.05}
        smoothness={4}
        position={[0, 0.58, 0.18]}
        castShadow
      >
        <meshStandardMaterial color={color} roughness={0.85} />
      </RoundedBox>
      {/* Pedestal */}
      <mesh position={[0, 0.17, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.07, 0.34, 12]} />
        <meshStandardMaterial color="#1c1814" roughness={0.5} metalness={0.4} />
      </mesh>
      {/* Base */}
      <mesh position={[0, 0.015, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.22, 0.025, 16]} />
        <meshStandardMaterial color="#1c1814" roughness={0.45} metalness={0.55} />
      </mesh>
    </group>
  );
}

function Shelf({
  x, z, w = 1.6, h = 1.6, d = 0.25, color, rotY = 0,
}: { x: number; z: number; w?: number; h?: number; d?: number; color: THREE.Color; rotY?: number; }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]}>
      <RoundedBox
        args={[w, h, d]}
        radius={0.035}
        smoothness={4}
        position={[0, h / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={color} roughness={0.88} />
      </RoundedBox>
      {/* Subtle shelf lines as inset planes */}
      {[0.4, 0.8, 1.2].map((y, i) =>
        y < h - 0.1 ? (
          <mesh key={i} position={[0, y, d / 2 + 0.002]}>
            <planeGeometry args={[w - 0.1, 0.012]} />
            <meshBasicMaterial color="#0a0807" transparent opacity={0.45} />
          </mesh>
        ) : null,
      )}
    </group>
  );
}

function Plant({ x, z, scale = 1 }: { x: number; z: number; scale?: number; }) {
  return (
    <group position={[x, 0, z]} scale={scale}>
      {/* Pot */}
      <mesh position={[0, 0.09, 0]} castShadow>
        <cylinderGeometry args={[0.14, 0.11, 0.18, 18]} />
        <meshStandardMaterial color="#5a4530" roughness={0.95} />
      </mesh>
      {/* Foliage — clustered spheres for a softer leaf shape */}
      <mesh position={[0, 0.4, 0]} castShadow>
        <sphereGeometry args={[0.2, 20, 16]} />
        <meshStandardMaterial color="#5e8542" roughness={0.85} />
      </mesh>
      <mesh position={[0.08, 0.5, -0.04]} castShadow>
        <sphereGeometry args={[0.13, 16, 12]} />
        <meshStandardMaterial color="#6b9450" roughness={0.85} />
      </mesh>
      <mesh position={[-0.09, 0.48, 0.05]} castShadow>
        <sphereGeometry args={[0.12, 16, 12]} />
        <meshStandardMaterial color="#588040" roughness={0.85} />
      </mesh>
    </group>
  );
}

function Lamp({ x, z, color }: { x: number; z: number; color: THREE.Color; }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.018, 0.018, 1, 8]} />
        <meshStandardMaterial color="#1c1814" roughness={0.55} metalness={0.5} />
      </mesh>
      <mesh position={[0, 1.04, 0]} castShadow>
        <coneGeometry args={[0.16, 0.16, 18]} />
        <meshStandardMaterial color="#1c1814" roughness={0.6} metalness={0.4} />
      </mesh>
      <pointLight position={[0, 0.98, 0]} color={color} intensity={0.45} distance={2.6} decay={2} />
    </group>
  );
}

/* Kit compositions --------------------------------------------------- */

function BridgeKit({ palette, accent }: KitProps) {
  return (
    <group>
      {/* Conference table — long rounded slab */}
      <RoundedBox
        args={[2.8, 0.1, 1.3]}
        radius={0.06}
        smoothness={4}
        position={[ROOM_W / 2 + 0.3, 0.7, ROOM_H / 2]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={palette.uniform} roughness={0.55} metalness={0.05} />
      </RoundedBox>
      {/* Table base */}
      <RoundedBox
        args={[2.5, 0.62, 0.9]}
        radius={0.04}
        smoothness={3}
        position={[ROOM_W / 2 + 0.3, 0.34, ROOM_H / 2]}
        castShadow
      >
        <meshStandardMaterial color={palette.uniformDark} roughness={0.92} />
      </RoundedBox>
      {/* Chairs */}
      <Chair x={ROOM_W / 2 - 0.7} z={ROOM_H / 2 - 1.05} color={palette.uniformDark} rotY={Math.PI} />
      <Chair x={ROOM_W / 2 + 0.4} z={ROOM_H / 2 - 1.05} color={palette.uniformDark} rotY={Math.PI} />
      <Chair x={ROOM_W / 2 + 1.5} z={ROOM_H / 2 - 1.05} color={palette.uniformDark} rotY={Math.PI} />
      <Chair x={ROOM_W / 2 - 0.7} z={ROOM_H / 2 + 1.05} color={palette.uniformDark} />
      <Chair x={ROOM_W / 2 + 1.5} z={ROOM_H / 2 + 1.05} color={palette.uniformDark} />
      <Monitor x={1.4} z={0.7} rotY={Math.PI / 5} screen={accent} />
      <Plant x={ROOM_W - 0.6} z={ROOM_H - 0.6} />
    </group>
  );
}

function AnalystKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2 - 1.0} z={1.4} color={palette.uniform} accent={accent} />
      <Desk x={ROOM_W / 2 + 1.0} z={1.4} color={palette.uniform} accent={accent} />
      <Monitor x={ROOM_W / 2 - 1.0} z={0.95} screen={accent} />
      <Monitor x={ROOM_W / 2 + 1.0} z={0.95} screen={accent} />
      <Chair x={ROOM_W / 2 - 1.0} z={2.1} color={palette.uniformDark} />
      <Chair x={ROOM_W / 2 + 1.0} z={2.1} color={palette.uniformDark} />
      <Shelf x={0.6} z={ROOM_H / 2 + 0.3} w={1.4} h={1.4} color={palette.uniformDark} rotY={Math.PI / 2} />
      <Plant x={ROOM_W - 0.6} z={ROOM_H - 0.6} />
    </group>
  );
}

function CreativeKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2} z={1.6} w={2.2} d={1.0} color={palette.uniform} accent={accent} />
      <Monitor x={ROOM_W / 2 - 0.7} z={1.3} screen={accent} />
      {/* Soft fabric / swatch group */}
      <RoundedBox
        args={[0.7, 0.05, 0.4]}
        radius={0.02}
        smoothness={3}
        position={[ROOM_W / 2 + 0.55, 0.68, 1.6]}
      >
        <meshStandardMaterial color={accent} roughness={0.9} />
      </RoundedBox>
      <Chair x={ROOM_W / 2} z={2.4} color={palette.uniformDark} />
      <Shelf x={0.7} z={ROOM_H / 2 + 0.5} w={1.4} h={1.6} color={palette.uniformDark} rotY={Math.PI / 2} />
      <Lamp x={ROOM_W - 0.7} z={0.7} color={accent} />
      <Plant x={ROOM_W - 0.6} z={ROOM_H - 0.6} />
    </group>
  );
}

function CopyKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2 - 0.95} z={ROOM_H / 2} color={palette.uniform} accent={accent} />
      <Desk x={ROOM_W / 2 + 0.95} z={ROOM_H / 2} color={palette.uniform} accent={accent} />
      <Monitor x={ROOM_W / 2 - 0.95} z={ROOM_H / 2 - 0.3} screen={accent} />
      <Monitor x={ROOM_W / 2 + 0.95} z={ROOM_H / 2 + 0.3} rotY={Math.PI} screen={accent} />
      <Chair x={ROOM_W / 2 - 0.95} z={ROOM_H / 2 + 0.6} color={palette.uniformDark} />
      <Chair x={ROOM_W / 2 + 0.95} z={ROOM_H / 2 - 0.6} color={palette.uniformDark} rotY={Math.PI} />
      <RoundedBox
        args={[0.65, 0.42, 0.5]}
        radius={0.05}
        smoothness={4}
        position={[ROOM_W - 0.7, 0.45, ROOM_H - 0.8]}
        castShadow
      >
        <meshStandardMaterial color={palette.uniformDark} roughness={0.85} />
      </RoundedBox>
      <Plant x={0.8} z={ROOM_H - 0.6} />
    </group>
  );
}

function CommsKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2 - 1.4} z={1.5} w={1.4} color={palette.uniform} accent={accent} />
      <Desk x={ROOM_W / 2} z={1.5} w={1.4} color={palette.uniform} accent={accent} />
      <Desk x={ROOM_W / 2 + 1.4} z={1.5} w={1.4} color={palette.uniform} accent={accent} />
      <Monitor x={ROOM_W / 2 - 1.4} z={1.1} screen={accent} />
      <Monitor x={ROOM_W / 2} z={1.1} screen={accent} />
      <Monitor x={ROOM_W / 2 + 1.4} z={1.1} screen={accent} />
      <Chair x={ROOM_W / 2 - 1.4} z={2.2} color={palette.uniformDark} />
      <Chair x={ROOM_W / 2} z={2.2} color={palette.uniformDark} />
      <Chair x={ROOM_W / 2 + 1.4} z={2.2} color={palette.uniformDark} />
      <Plant x={ROOM_W - 0.6} z={ROOM_H - 0.6} />
    </group>
  );
}

function FinanceKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2} z={1.6} w={2.2} d={1.0} color={palette.uniform} accent={accent} />
      <Monitor x={ROOM_W / 2 - 0.6} z={1.3} screen={accent} />
      <Monitor x={ROOM_W / 2 + 0.6} z={1.3} screen={accent} />
      <Chair x={ROOM_W / 2} z={2.45} color={palette.uniformDark} />
      <RoundedBox
        args={[0.7, 1.0, 0.6]}
        radius={0.05}
        smoothness={4}
        position={[ROOM_W - 0.7, 0.5, ROOM_H - 0.7]}
        castShadow
      >
        <meshStandardMaterial color={palette.uniformDark} roughness={0.5} metalness={0.35} />
      </RoundedBox>
      <mesh position={[ROOM_W - 0.7, 0.6, ROOM_H - 0.4]}>
        <cylinderGeometry args={[0.06, 0.06, 0.03, 24]} />
        <meshStandardMaterial color={accent} metalness={0.7} roughness={0.3} />
      </mesh>
      <Plant x={0.8} z={ROOM_H - 0.6} />
    </group>
  );
}

function RdKit({ palette, accent }: KitProps) {
  return (
    <group>
      <RoundedBox
        args={[2.6, 0.1, 1.0]}
        radius={0.04}
        smoothness={4}
        position={[ROOM_W / 2, 0.55, 1.6]}
        castShadow
      >
        <meshStandardMaterial color={palette.uniform} roughness={0.55} metalness={0.05} />
      </RoundedBox>
      {[-0.7, -0.2, 0.3, 0.8].map((dx, i) => (
        <mesh key={i} position={[ROOM_W / 2 + dx, 0.72, 1.6]}>
          <cylinderGeometry args={[0.07, 0.05, 0.24, 16]} />
          <meshStandardMaterial
            color={accent}
            transparent
            opacity={0.65}
            roughness={0.2}
            metalness={0.2}
            emissive={accent}
            emissiveIntensity={0.35}
          />
        </mesh>
      ))}
      <RoundedBox
        args={[0.7, 1.8, 0.55]}
        radius={0.05}
        smoothness={4}
        position={[ROOM_W - 0.6, 0.92, ROOM_H - 0.7]}
        castShadow
      >
        <meshStandardMaterial color={palette.uniformDark} roughness={0.78} />
      </RoundedBox>
      {[1.3, 1.1, 0.9, 0.7, 0.5].map((y, i) => (
        <mesh key={i} position={[ROOM_W - 0.6, y, ROOM_H - 0.42]}>
          <boxGeometry args={[0.5, 0.02, 0.01]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={0.9}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function OpsKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2} z={2.0} w={2.0} color={palette.uniform} accent={accent} />
      <Monitor x={ROOM_W / 2 - 0.5} z={1.7} screen={accent} />
      <Monitor x={ROOM_W / 2 + 0.5} z={1.7} screen={accent} />
      <Chair x={ROOM_W / 2} z={2.75} color={palette.uniformDark} />
      {[0.7, 1.4, 2.1].map((x, i) => (
        <group key={i}>
          <RoundedBox
            args={[0.55, 1.8, 0.5]}
            radius={0.05}
            smoothness={4}
            position={[x, 0.92, ROOM_H - 0.6]}
            castShadow
          >
            <meshStandardMaterial color={palette.uniformDark} roughness={0.8} />
          </RoundedBox>
          {[1.5, 1.2, 0.9, 0.6, 0.3].map((y, j) => (
            <mesh key={j} position={[x, y, ROOM_H - 0.35]}>
              <boxGeometry args={[0.42, 0.02, 0.012]} />
              <meshStandardMaterial
                color={accent}
                emissive={accent}
                emissiveIntensity={0.7}
                toneMapped={false}
              />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function LegalKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2} z={1.7} w={2.2} d={1.0} color={palette.uniform} accent={accent} />
      <Monitor x={ROOM_W / 2} z={1.4} screen={accent} />
      <Chair x={ROOM_W / 2} z={2.5} color={palette.uniformDark} />
      <Shelf x={0.8} z={ROOM_H / 2} w={1.6} h={1.8} color={palette.uniformDark} rotY={Math.PI / 2} />
      <Plant x={ROOM_W - 0.6} z={ROOM_H - 0.6} />
    </group>
  );
}

function ArchiveKit({ palette }: KitProps) {
  return (
    <group>
      <Shelf x={ROOM_W / 2 - 1.8} z={1.0} w={1.4} h={1.8} color={palette.uniformDark} />
      <Shelf x={ROOM_W / 2} z={1.0} w={1.4} h={1.8} color={palette.uniformDark} />
      <Shelf x={ROOM_W / 2 + 1.8} z={1.0} w={1.4} h={1.8} color={palette.uniformDark} />
      <Shelf x={ROOM_W / 2 - 1.8} z={ROOM_H - 0.8} w={1.4} h={1.5} color={palette.uniformDark} rotY={Math.PI} />
      <Shelf x={ROOM_W / 2 + 1.8} z={ROOM_H - 0.8} w={1.4} h={1.5} color={palette.uniformDark} rotY={Math.PI} />
    </group>
  );
}

function DevKit({ palette, accent }: KitProps) {
  return (
    <group>
      <Desk x={ROOM_W / 2} z={1.5} w={2.0} d={0.8} color={palette.uniform} accent={accent} h={0.9} />
      <Monitor x={ROOM_W / 2 - 0.55} z={1.25} screen={accent} h={0.9} />
      <Monitor x={ROOM_W / 2 + 0.55} z={1.25} screen={accent} h={0.9} />
      <Chair x={ROOM_W / 2} z={2.3} color={palette.uniformDark} />
      <Plant x={0.8} z={ROOM_H - 0.6} />
    </group>
  );
}
