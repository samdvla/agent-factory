import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import { Suspense, useEffect } from "react";
import * as THREE from "three";
import { ROOMS, ROLES } from "../state/fixtures";
import Room3D from "./Room3D";
import Avatar3D from "./Avatar3D";
import { useFactoryStore } from "../state/factoryStore";

const ROOM_W = 6;
const ROOM_H = 6;
const GAP = 1;

function CameraRig({ target }: { target: [number, number, number] }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(target[0] + 20, 25, target[2] + 20);
    camera.lookAt(new THREE.Vector3(...target));
    if ((camera as any).updateProjectionMatrix) (camera as any).updateProjectionMatrix();
  }, [camera, target]);
  return null;
}

function AvatarsLayer() {
  const agents = useFactoryStore((s) => s.agents);
  const selectAgent = useFactoryStore((s) => s.selectAgent);

  return (
    <>
      {Object.values(ROLES).map((role) => {
        const room = ROOMS[role.room];
        const agent = agents[role.id];
        if (!room || !agent) return null;
        const x = room.col * (ROOM_W + GAP) + ROOM_W / 2;
        const z = room.row * (ROOM_H + GAP) + ROOM_H * 0.55;
        return (
          <Avatar3D
            key={role.id}
            role={role}
            position={[x, 0, z]}
            state={agent.state}
            onClick={() => selectAgent(role.id)}
          />
        );
      })}
    </>
  );
}

export default function ThreeFactoryFloor() {
  return (
    <Canvas
      style={{ width: "100%", height: "100%", display: "block", background: "#0a0e14" }}
      shadows
      dpr={[1, 2]}
    >
      <OrthographicCamera makeDefault zoom={18} near={0.1} far={1000} />
      <CameraRig target={[10, 0, 7]} />
      <OrbitControls
        target={[10, 0, 7]}
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
      />
      <ambientLight intensity={1.2} />
      <directionalLight
        position={[20, 30, 15]}
        intensity={2.0}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <directionalLight position={[-10, 10, -5]} intensity={0.8} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[10, -0.01, 10]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0a0e14" />
      </mesh>
      <Suspense fallback={null}>
        {Object.keys(ROOMS).map((id) => (
          <Room3D key={id} roomId={id} />
        ))}
      </Suspense>
      <AvatarsLayer />
    </Canvas>
  );
}
