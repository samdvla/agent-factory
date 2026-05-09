import { Canvas } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import { Suspense } from "react";
import { ROOMS, ROLES } from "../state/fixtures";
import Room3D from "./Room3D";
import Avatar3D from "./Avatar3D";
import { useFactoryStore } from "../state/factoryStore";

const ROOM_W = 6;
const ROOM_H = 6;
const GAP = 1;

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
      <OrthographicCamera makeDefault position={[20, 20, 20]} zoom={40} near={0.1} far={1000} />
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[10, 20, 5]}
        intensity={1.0}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      {/* DEBUG: hot-pink cube at origin — confirms three.js/WebGL is working */}
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color="hotpink" />
      </mesh>
      <axesHelper args={[5]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[10, -0.01, 10]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0a0e14" />
      </mesh>
      <Suspense
        fallback={
          <mesh position={[5, 0.5, 5]}>
            <sphereGeometry args={[0.5]} />
            <meshBasicMaterial color="cyan" wireframe />
          </mesh>
        }
      >
        {Object.keys(ROOMS).map((id) => (
          <Room3D key={id} roomId={id} />
        ))}
      </Suspense>
      <AvatarsLayer />
    </Canvas>
  );
}
