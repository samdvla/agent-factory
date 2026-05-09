import { Suspense, useEffect } from "react";
import { Box3, Vector3 } from "three";
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
      <Suspense fallback={null}>
        <FbxWall position={[ROOM_W / 2, 0, 0]} rotationY={0} />
        <FbxWall position={[ROOM_W, 0, ROOM_H / 2]} rotationY={Math.PI / 2} />
      </Suspense>
      {/* Per-kind props */}
      {(PROP_LAYOUTS[room.kit?.primaryTag ?? ""] ?? []).map((p, i) => (
        <Suspense
          key={i}
          fallback={null}
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
}: {
  position: [number, number, number];
  rotationY: number;
}) {
  const cloned = useFbxClone(wallEmptyUrl);
  useEffect(() => {
    const box = new Box3().setFromObject(cloned);
    const size = new Vector3();
    box.getSize(size);
    console.log(
      "Wall bounding box:",
      size.x.toFixed(2),
      "×",
      size.y.toFixed(2),
      "×",
      size.z.toFixed(2)
    );
    (window as any).__wallSize = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  }, [cloned]);
  return (
    <primitive
      object={cloned}
      position={position}
      rotation={[0, rotationY, 0]}
      scale={1}
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
