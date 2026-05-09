import { useEffect, useRef } from "react";
import { useFoundingLoops } from "./demoFloor/useFoundingLoops";
import { useSpecialistLoops } from "./demoFloor/useSpecialistLoops";
import { useHireSignals } from "./demoFloor/useHireSignals";
import { useOrchestratorVisits } from "./demoFloor/useOrchestratorVisits";

export function useDemoFloor(enabled = true) {
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = !enabled;
    return () => {
      cancelledRef.current = true;
    };
  }, [enabled]);

  useFoundingLoops(enabled, cancelledRef);
  const { startSpecialistLoop } = useSpecialistLoops(cancelledRef);
  useHireSignals(cancelledRef, startSpecialistLoop);
  useOrchestratorVisits(cancelledRef);
}
