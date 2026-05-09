import { useLoader } from "@react-three/fiber";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { Group } from "three";
import { useMemo } from "react";

export function useFbxClone(path: string): Group {
  const fbx = useLoader(FBXLoader, path) as Group;
  return useMemo(() => fbx.clone(), [fbx]);
}
