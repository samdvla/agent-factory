import type { ReactNode } from "react";
import {
  Clock, FloorLightPool, OvalTable, OfficeChair, PendantLamp, Plant, Rug, TallPlant,
} from "./furnitureV2";

/**
 * Strategy Room composition — direct port of the handoff's `strat` room
 * (orange accent, oval table, 8 chairs, pendant lamp). All world coords are
 * authored for a 6×6 room (scaled from the handoff's 10×10 via ×0.6).
 *
 * Returns furniture as ReactNodes; the caller (RoomShellIso) frames it inside
 * the room shell. The station/cluster positions in `composer.tsx` were tuned
 * to align with the chair seats in this layout, so the orchestrator avatar
 * stands at the head of the table.
 */
export function StrategyRoomFurniture({ accent }: { accent: string }): ReactNode {
  return (
    <>
      {/* Wall clock on the back-right wall (centered in the solid lower band) */}
      <Clock wall="right" u={4.4} v={1.35} size={0.7} />

      {/* Rug under the table — accent-tinted */}
      <Rug x={0.84} y={0.84} w={3.84} d={3.84} color={accent} opacity={0.12} />

      {/* Soft warm light pool from the pendant */}
      <FloorLightPool x={2.88} y={2.4} rx={1.56} ry={1.08} color="#fff5d6" opacity={0.35} />

      {/* Oval conference table */}
      <OvalTable x={1.5} y={1.56} w={2.76} d={1.68} color="#b8855a" />

      {/* 8 chairs around the table.  Layout mirrors handoff `strat` room. */}
      {/* Back row (low Y) — 3 chairs facing back-left */}
      <OfficeChair x={1.74} y={0.84} color="#1a1c22" accent={accent} face="back-left" />
      <OfficeChair x={2.64} y={0.84} color="#1a1c22" accent={accent} face="back-left" />
      <OfficeChair x={3.54} y={0.84} color="#1a1c22" accent={accent} face="back-left" />
      {/* West chair (low X) — back-right facing */}
      <OfficeChair x={0.84} y={1.92} color="#1a1c22" accent={accent} face="back-right" />
      {/* East chair (high X) — front-right facing — orchestrator's seat (station 0) */}
      <OfficeChair x={4.2} y={1.92} color="#1a1c22" accent={accent} face="front-right" />
      {/* Front row (high Y) — 3 chairs facing front-left */}
      <OfficeChair x={1.74} y={3.36} color="#1a1c22" accent={accent} face="front-left" />
      <OfficeChair x={2.64} y={3.36} color="#1a1c22" accent={accent} face="front-left" />
      <OfficeChair x={3.54} y={3.36} color="#1a1c22" accent={accent} face="front-left" />

      {/* Pendant lamp suspended over the table */}
      <PendantLamp x={2.88} y={2.4} ceilZ={3.95} dropTo={2.6} color="#f5d77a" />

      {/* Greenery in the corners */}
      <TallPlant x={4.92} y={4.92} color="#4f8a4f" />
      <Plant x={5.04} y={0.36} color="#5fa057" />
    </>
  );
}
