import { Canvas } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import { Suspense } from "react";
import { ROOMS } from "../state/fixtures";
import Room3D from "./Room3D";

export default function ThreeFactoryFloor() {
  return (
    <Canvas
      style={{ position: "absolute", inset: 0, background: "#0a0e14" }}
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
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[10, -0.01, 10]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0a0e14" />
      </mesh>
      <Suspense fallback={null}>
        {Object.keys(ROOMS).map((id) => (
          <Room3D key={id} roomId={id} />
        ))}
      </Suspense>
    </Canvas>
  );
}
