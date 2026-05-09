import { useEffect } from "react";
import { useFactoryStore } from "../../factory/state/factoryStore";
import { HireEvent } from "../../factory/state/types";
import { SIM, SimState } from "./constants";
import { SPECIALIST_PROFILES, SpecialistProfile } from "./useSpecialistLoops";

type HireSignal = {
  name: string;
  trigger: (s: SimState) => boolean;
  spec: () => Omit<HireEvent, "id" | "ts">;
};

const HIRE_SIGNALS: HireSignal[] = [
  {
    name: "designer queue backlog",
    trigger: (s) => s.designerQueue > 5,
    spec: () => ({
      roleSpec: { name: "Mockup Artist", title: "Specialist · Designer", primaryTag: "creative", archetype: "relaxed", model: "Haiku" },
      justification: { reason: "queue_backlog", metric: `designer queue = ${SIM.designerQueue} > 5` },
    }),
  },
  {
    name: "dispute volume",
    trigger: (s) => s.openDisputes > 3,
    spec: () => ({
      roleSpec: { name: "Dispute Negotiator", title: "Specialist · CS", primaryTag: "comms", archetype: "formal", model: "Sonnet" },
      justification: { reason: "dispute_volume", metric: `open disputes = ${SIM.openDisputes} > 3` },
    }),
  },
  {
    name: "translation demand",
    trigger: (s) => s.intlOrdersPending > 8,
    spec: () => ({
      roleSpec: { name: "Translator", title: "Specialist · Listing", primaryTag: "copy", archetype: "office", model: "Haiku" },
      justification: { reason: "translation_demand", metric: `intl orders = ${SIM.intlOrdersPending} > 8` },
    }),
  },
  {
    name: "tax cycle",
    trigger: (s) => s.dayInQuarter > 80,
    spec: () => ({
      roleSpec: { name: "Tax Helper", title: "Specialist · Finance", primaryTag: "legal", archetype: "formal", model: "Sonnet" },
      justification: { reason: "tax_cycle", metric: `Q-end in ${Math.max(0, 90 - Math.floor(SIM.dayInQuarter))} days` },
    }),
  },
  {
    name: "niche backlog",
    trigger: (s) => s.nichesQueued > 5,
    spec: () => ({
      roleSpec: { name: "Trend Hunter", title: "Specialist · Research", primaryTag: "analyst", archetype: "slim", model: "Haiku" },
      justification: { reason: "niche_demand", metric: `niche backlog = ${SIM.nichesQueued} > 5` },
    }),
  },
];

export function useHireSignals(
  cancelledRef: { current: boolean },
  startSpecialistLoop: (roleId: string, profile: SpecialistProfile) => void,
): void {
  useEffect(() => {
    const store = useFactoryStore;
    const hiredSignals = new Set<string>();

    const hireInterval = setInterval(() => {
      if (cancelledRef.current) return;
      for (const sig of HIRE_SIGNALS) {
        if (hiredSignals.has(sig.name)) continue;
        if (!sig.trigger(SIM)) continue;
        hiredSignals.add(sig.name);
        const beforeIds = new Set(Object.keys(store.getState().roles));
        const e = sig.spec();
        store.getState().fireHireEvent({
          ...e,
          id: `demo-${sig.name}-${Date.now()}`,
          ts: Date.now(),
        });
        const afterIds = Object.keys(store.getState().roles);
        const newId = afterIds.find((id) => !beforeIds.has(id));
        if (newId) {
          const role = store.getState().roles[newId];
          const profile = SPECIALIST_PROFILES[role.name];
          if (profile) startSpecialistLoop(newId, profile);
        }
        if (sig.name === "designer queue backlog") SIM.designerQueue = 1;
        if (sig.name === "dispute volume")        SIM.openDisputes = 0;
        if (sig.name === "translation demand")    SIM.intlOrdersPending = 0;
        if (sig.name === "niche backlog")         SIM.nichesQueued = 1;
        if (sig.name === "tax cycle")             SIM.dayInQuarter = 0;
      }
    }, 10_000);

    const dissolveInterval = setInterval(() => {
      if (cancelledRef.current) return;
      store.getState().idleDissolveTick(Date.now(), 90_000);
      for (const sig of HIRE_SIGNALS) {
        const stillHired = Object.values(store.getState().roles).some(
          (r) => r.name === sig.spec().roleSpec.name,
        );
        if (!stillHired) hiredSignals.delete(sig.name);
      }
    }, 30_000);

    return () => {
      clearInterval(hireInterval);
      clearInterval(dissolveInterval);
    };
  }, []);
}
