import { Suspense } from "react";
import { ROOMS, ROLES } from "../state/fixtures";
import { useFbxClone } from "./fbxLoader";
import wallEmptyUrl from "../../assets/quaternius-scifi/Walls/Wall_Empty.fbx?url";
import { PROP_LAYOUTS } from "./propLayouts";

const ROOM_W = 6;
const ROOM_H = 6;
const GAP = 1;

export default function Room3D({ roomId }: { roomId: string }) {
  const room = ROOMS[roomId];
  const role = Object.values(ROLES).find((r) => r.room === roomId);
  const accent = role?.hex ?? "#5fd4f0";

  const x0 = room.col * (ROOM_W + GAP);
  const z0 = room.row * (ROOM_H + GAP);

  return (
    <group position={[x0, 0, z0]}>
      {/* Floor */}
      <mesh receiveShadow position={[ROOM_W / 2, 0, ROOM_H / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[ROOM_W, ROOM_H]} />
        <meshStandardMaterial color="#0f1620" />
      </mesh>
      {/* Accent ring */}
      <mesh position={[ROOM_W / 2, 0.02, ROOM_H / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[ROOM_W / 2 - 0.2, ROOM_W / 2, 32]} />
        <meshBasicMaterial color={accent} transparent opacity={0.4} />
      </mesh>
      {/* Back walls (north + east, so camera sees inside) */}
      <Suspense
        fallback={
          <mesh position={[ROOM_W / 2, 0.5, 0]}>
            <boxGeometry args={[ROOM_W, 1, 0.1]} />
            <meshBasicMaterial color="yellow" wireframe />
          </mesh>
        }
      >
        <FbxWall position={[ROOM_W / 2, 0, 0]} rotationY={0} length={ROOM_W} />
        <FbxWall position={[ROOM_W, 0, ROOM_H / 2]} rotationY={Math.PI / 2} length={ROOM_H} />
      </Suspense>
      {/* Per-kind props */}
      {(PROP_LAYOUTS[room.kind] ?? []).map((p, i) => (
        <Suspense
          key={i}
          fallback={
            <mesh position={p.position}>
              <boxGeometry args={[0.3, 0.3, 0.3]} />
              <meshBasicMaterial color="orange" wireframe />
            </mesh>
          }
        >
          <FbxProp
            url={p.url}
            position={p.position}
            rotationY={p.rotationY ?? 0}
            scale={p.scale ?? 1}
          />
        </Suspense>
      ))}
    </group>
  );
}

function FbxWall({
  position,
  rotationY,
  length,
}: {
  position: [number, number, number];
  rotationY: number;
  length: number;
}) {
  const cloned = useFbxClone(wallEmptyUrl);
  // Quaternius walls are typically 1m wide; scale Z to fit the run.
  // Scale on local Z which after rotationY may be world X — adjust if walls look wrong.
  return (
    <primitive
      object={cloned}
      position={position}
      rotation={[0, rotationY, 0]}
      scale={[1, 1, length]}
    />
  );
}

function FbxProp({ url, position, rotationY, scale }: {
  url: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
}) {
  const cloned = useFbxClone(url);
  return <primitive object={cloned} position={position} rotation={[0, rotationY, 0]} scale={scale} />;
}
