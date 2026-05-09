import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Group } from "three";
import { Role, AgentVisualState } from "../state/types";

const STATE_PARAMS: Record<AgentVisualState, { glow: number; bob: number; tint: number }> = {
  idle:        { glow: 0.4, bob: 0.05, tint: 1.0 },
  working:     { glow: 0.8, bob: 0.0,  tint: 1.0 },
  walking:     { glow: 0.6, bob: 0.15, tint: 1.0 },
  awaiting:    { glow: 0.5, bob: 0.0,  tint: 1.0 },
  paused:      { glow: 0.15, bob: 0.0, tint: 0.5 },
  crashed:     { glow: 0.2, bob: 0.0,  tint: 0.3 },
  killed:      { glow: 0.0, bob: 0.0,  tint: 0.0 },
  quarantined: { glow: 0.3, bob: 0.0,  tint: 0.4 },
};

export default function Avatar3D({
  role,
  position,
  state,
  onClick,
}: {
  role: Role;
  position: [number, number, number];
  state: AgentVisualState;
  onClick: () => void;
}) {
  const groupRef = useRef<Group>(null);
  const params = STATE_PARAMS[state];
  const color = state === "crashed" ? "#ef6a5a" : role.hex;

  useFrame(() => {
    if (!groupRef.current || params.bob === 0) return;
    groupRef.current.position.y = Math.abs(Math.sin(performance.now() * 0.003)) * params.bob;
  });

  if (state === "killed") return null;

  return (
    <group
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {/* Glow disc on floor */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.35, 0.55, 24]} />
        <meshBasicMaterial color={role.hex} transparent opacity={params.glow} />
      </mesh>
      {/* Bobbing inner group (body + head) */}
      <group ref={groupRef}>
        <mesh position={[0, 0.7, 0]} castShadow>
          <capsuleGeometry args={[0.25, 0.7, 6, 12]} />
          <meshStandardMaterial color={color} transparent opacity={params.tint} />
        </mesh>
        <mesh position={[0, 1.45, 0]} castShadow>
          <sphereGeometry args={[0.18, 12, 12]} />
          <meshStandardMaterial color="#d8b894" transparent opacity={params.tint} />
        </mesh>
      </group>
    </group>
  );
}
