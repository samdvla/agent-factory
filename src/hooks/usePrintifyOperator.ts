import { useEffect } from "react";
import { useFactoryStore } from "../factory/state/factoryStore";
import { api } from "../api";

/**
 * Printify Operator — a permanent specialist that gets hired the first time
 * the user enables POD and dissolved when they turn it off.
 *
 * Uses the existing dynamic hire system (`fireHireEvent`) so a fresh "Print
 * Shop" room is placed on the floor via `placeNewRoom`. The role is marked
 * permanent so the wealth/idle dissolution paths leave it alone — but our
 * own toggle calls `dissolveAgent(id, { force: true })` to bypass that
 * protection when the user turns POD off.
 *
 * The role name is `Printify Operator` and the room tag is `ops`. We look
 * the role up by name (the id is generated random by the resolver) so we
 * stay compatible with the existing infra without hard-coding a slug.
 */
export const PRINTIFY_OPERATOR_NAME = "Printify Operator";

function findPrintifyRoleId(): string | null {
  const roles = useFactoryStore.getState().roles;
  const match = Object.values(roles).find(
    (r) => r.name === PRINTIFY_OPERATOR_NAME,
  );
  return match?.id ?? null;
}

export function hirePrintifyOperator(): string {
  const existing = findPrintifyRoleId();
  if (existing) return existing;
  const store = useFactoryStore.getState();
  const beforeIds = new Set(Object.keys(store.roles));
  store.fireHireEvent({
    id: `printify-${Date.now()}`,
    ts: Date.now(),
    roleSpec: {
      name: PRINTIFY_OPERATOR_NAME,
      title: "POD Fulfillment",
      primaryTag: "ops",
      archetype: "office",
      model: "Sonnet",
      portrait: "P",
    },
    // "founding" makes the resolver mark the role permanent so it doesn't
    // dissolve via idle/wealth. We use `dissolveAgent(..., { force: true })`
    // to remove it when the user toggles POD off.
    justification: {
      reason: "founding",
      metric: "pod_enabled=true",
    },
  });
  const afterIds = Object.keys(useFactoryStore.getState().roles);
  return afterIds.find((id) => !beforeIds.has(id)) ?? "";
}

export function dissolvePrintifyOperator(): void {
  const id = findPrintifyRoleId();
  if (!id) return;
  useFactoryStore.getState().dissolveAgent(id, { force: true });
}

/**
 * On app mount: read pod_enabled from the secret store. If the user already
 * has POD on from a previous session, materialize the operator so the floor
 * matches the runtime state. Idempotent — re-mounting won't double-hire.
 */
export function usePrintifyOperatorBoot() {
  useEffect(() => {
    api.printifyStatus().then((s) => {
      if (s.pod_enabled && s.key_present) {
        hirePrintifyOperator();
      }
    }).catch(() => {});
  }, []);
}
