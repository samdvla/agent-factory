import { useFactoryStore } from "../state/factoryStore";
import { roomOrigin } from "./geometry";
import { layoutStations } from "./kit/composer";

export type Station = { x: number; y: number; label: string };

export function stationWorld(roomId: string, idx: number): Station | null {
  const room = useFactoryStore.getState().rooms[roomId];
  if (!room || !room.kit) return null;
  const list = layoutStations(room.kit);
  if (!list.length) return null;
  const st = list[((idx % list.length) + list.length) % list.length];
  const { wx, wy } = roomOrigin(room.col, room.row);
  return { x: wx + st.x, y: wy + st.y, label: st.label };
}

export function stationCount(roomId: string): number {
  const room = useFactoryStore.getState().rooms[roomId];
  if (!room?.kit) return 1;
  return Math.max(1, layoutStations(room.kit).length);
}

export function homeStationFor(roleId: string, roomId: string): number {
  const count = stationCount(roomId);
  if (count <= 1) return 0;
  let h = 0;
  for (let i = 0; i < roleId.length; i++) h = (h * 31 + roleId.charCodeAt(i)) | 0;
  return Math.abs(h) % count;
}
