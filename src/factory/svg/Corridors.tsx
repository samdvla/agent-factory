import { Strip } from "./layout";

// Corridors used to render dashed pathways + lights between rooms. The new
// iso design has each room as its own pavilion on the sky backdrop, so the
// hallway visuals are intentionally omitted. The component still exists for
// API compatibility but renders nothing — the avatar layout system still
// reads `strips` for routing.
export default function Corridors({ strips: _strips }: { strips: Strip[] }) {
  return null;
}
