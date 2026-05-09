import { useEffect } from "react";
import { useFactoryStore } from "../../factory/state/factoryStore";
import { ROLES } from "../../factory/state/fixtures";
import { planRoomToRoomPath } from "../../factory/svg/pathing";
import { homeStationFor } from "../../factory/svg/stations";
import { sleep, pickOne } from "./constants";

export function useOrchestratorVisits(cancelledRef: { current: boolean }): void {
  useEffect(() => {
    const store = useFactoryStore;

    async function orchestratorSiteVisits() {
      await sleep(18000);
      const targets = ["research", "designer", "listing", "cs", "cfo", "si"];
      const orchestratorRole = ROLES["orchestrator"];
      if (!orchestratorRole) return;

      const SEGMENT_MS = 700;

      while (!cancelledRef.current) {
        const pick = pickOne(targets);
        const subRole = ROLES[pick];
        if (!subRole) {
          await sleep(20000);
          continue;
        }

        // Outbound path: strategy.home → subRole.room.station 0
        const outbound = planRoomToRoomPath(
          orchestratorRole.room,
          homeStationFor("orchestrator", orchestratorRole.room),
          subRole.room,
          0,
        );
        if (outbound.length >= 2) {
          const totalOutboundMs = (outbound.length - 1) * SEGMENT_MS;
          store.getState().setAgentTravel("orchestrator", {
            roomId: subRole.room,
            stationIdx: 0,
            waypoints: outbound,
            startedAt: Date.now(),
            durationPerSegmentMs: SEGMENT_MS,
          });
          store.getState().pushTicker({
            ts: Date.now(),
            source: "orchestrator",
            text: `walking to ${subRole.name} via corridor`,
          });
          await sleep(totalOutboundMs);
          if (cancelledRef.current) return;
        }

        // Spend time at the visited room
        await sleep(4500 + Math.random() * 3500);
        if (cancelledRef.current) return;

        // Return path: subRole.room → strategy.home
        const returnPath = planRoomToRoomPath(
          subRole.room,
          0,
          orchestratorRole.room,
          homeStationFor("orchestrator", orchestratorRole.room),
        );
        if (returnPath.length >= 2) {
          const totalReturnMs = (returnPath.length - 1) * SEGMENT_MS;
          store.getState().setAgentTravel("orchestrator", {
            roomId: orchestratorRole.room,
            stationIdx: homeStationFor("orchestrator", orchestratorRole.room),
            waypoints: returnPath,
            startedAt: Date.now(),
            durationPerSegmentMs: SEGMENT_MS,
          });
          store.getState().pushTicker({
            ts: Date.now(),
            source: "orchestrator",
            text: `walking back to strategy room`,
          });
          await sleep(totalReturnMs);
          if (cancelledRef.current) return;
        }

        // Clear travel so the agent reverts to its normal station rotation
        store.getState().setAgentTravel("orchestrator", null);

        await sleep(22000 + Math.random() * 22000);
      }
    }

    orchestratorSiteVisits();

    return () => {
      store.getState().setAgentTravel("orchestrator", null);
    };
  }, []);
}
