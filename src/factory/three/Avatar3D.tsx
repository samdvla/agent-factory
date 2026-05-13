import { useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Color } from "three";
import { Role, AgentVisualState } from "../state/types";
import { ThemeColors } from "./themeColors";

const STATE_PARAMS: Record<
  AgentVisualState,
  { glow: number; bob: number; tint: number; emissive: number }
> = {
  idle:          { glow: 0.30, bob: 0.04, tint: 1.0,  emissive: 0.05 },
  working:       { glow: 0.80, bob: 0.0,  tint: 1.0,  emissive: 0.35 },
  walking:       { glow: 0.55, bob: 0.14, tint: 1.0,  emissive: 0.18 },
  awaiting:      { glow: 0.55, bob: 0.05, tint: 1.0,  emissive: 0.15 },
  paused:        { glow: 0.12, bob: 0.0,  tint: 0.55, emissive: 0.0  },
  crashed:       { glow: 0.12, bob: 0.0,  tint: 0.4,  emissive: 0.0  },
  killed:        { glow: 0.0,  bob: 0.0,  tint: 0.0,  emissive: 0.0  },
  quarantined:   { glow: 0.25, bob: 0.0,  tint: 0.5,  emissive: 0.05 },
  materializing: { glow: 0.95, bob: 0.1,  tint: 0.65, emissive: 0.5  },
  dissolving:    { glow: 0.1,  bob: 0.0,  tint: 0.35, emissive: 0.0  },
};

/**
 * Abstract "presence" figure — a single tall rounded teardrop in the role's
 * accent color with a softer cap on top. No anatomical detail, no boxy eyes,
 * no Minecraft cubes. Reads as elegant pawn-on-board rather than low-poly
 * character. The role identity comes through color + form, not faces.
 */
export default function Avatar3D({
  role,
  position,
  state,
  selected,
  palette,
  onClick,
}: {
  role: Role;
  position: [number, number, number];
  state: AgentVisualState;
  selected: boolean;
  palette: ThemeColors;
  onClick: () => void;
}) {
  const groupRef = useRef<Group>(null);
  const params = STATE_PARAMS[state];
  const [hovered, setHovered] = useState(false);

  const accent = useMemo(() => new Color(role.hex), [role.hex]);

  // Body color: soft, lifted from the role hue toward the parchment ink so
  // it reads as the role's "uniform shade" rather than a saturated cartoon.
  const bodyTone = useMemo(() => {
    if (state === "crashed") return palette.accentBad.clone();
    return accent.clone().lerp(palette.ink0, 0.35);
  }, [palette, accent, state]);

  // Cap color: slightly darker, with role hue retained.
  const capTone = useMemo(
    () => accent.clone().lerp(palette.bg0, 0.45),
    [palette, accent],
  );

  useFrame(() => {
    if (!groupRef.current) return;
    if (params.bob > 0) {
      groupRef.current.position.y = Math.abs(Math.sin(performance.now() * 0.003)) * params.bob;
    } else {
      groupRef.current.position.y = 0;
    }
    groupRef.current.rotation.y = hovered ? Math.sin(performance.now() * 0.002) * 0.08 : 0;
  });

  if (state === "killed") return null;

  return (
    <group
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = "";
      }}
    >
      {/* Soft floor glow — a wide radial wash, not a hard ring */}
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.85, 36]} />
        <meshBasicMaterial color={accent} transparent opacity={params.glow * 0.18} />
      </mesh>

      {selected && (
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.62, 0.68, 48]} />
          <meshBasicMaterial color={palette.ink0} transparent opacity={0.85} />
        </mesh>
      )}

      <group ref={groupRef}>
        {/* Body: a single capsule reads as elegant teardrop shape from iso */}
        <mesh position={[0, 0.72, 0]} castShadow>
          <capsuleGeometry args={[0.34, 0.72, 12, 24]} />
          <meshStandardMaterial
            color={bodyTone}
            transparent
            opacity={params.tint}
            roughness={0.45}
            metalness={0.0}
            emissive={accent}
            emissiveIntensity={params.emissive * 0.3}
          />
        </mesh>

        {/* Subtle waist ring — gives the body silhouette a "tailored" detail */}
        <mesh position={[0, 0.62, 0]}>
          <torusGeometry args={[0.345, 0.018, 8, 32]} />
          <meshStandardMaterial
            color={capTone}
            transparent
            opacity={params.tint * 0.7}
            roughness={0.6}
            metalness={0.2}
          />
        </mesh>

        {/* Cap on top — softer dome that hugs the head end of the capsule */}
        <mesh position={[0, 1.34, 0]} castShadow>
          <sphereGeometry
            args={[0.36, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.5]}
          />
          <meshStandardMaterial
            color={capTone}
            transparent
            opacity={params.tint}
            roughness={0.55}
            metalness={0.05}
            emissive={accent}
            emissiveIntensity={params.emissive * 0.4}
          />
        </mesh>
      </group>
    </group>
  );
}
