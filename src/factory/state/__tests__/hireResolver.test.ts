import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFactoryStore } from "../factoryStore";
import { HireEvent } from "../types";

function makeHire(name: string, tag: HireEvent["roleSpec"]["primaryTag"], reason: HireEvent["justification"]["reason"]): HireEvent {
  return {
    id: `h-${name}`,
    ts: Date.now(),
    roleSpec: { name, title: "Specialist", primaryTag: tag, archetype: "office", model: "Haiku" },
    justification: { reason, metric: `${reason}: test` },
  };
}

describe("hire resolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("places a comms hire in CS Booth (capacity 4) before creating a new room", () => {
    const before = useFactoryStore.getState().rooms.cs.occupants?.length ?? 0;
    useFactoryStore.getState().fireHireEvent(makeHire("Dispute1", "comms", "dispute_volume"));
    useFactoryStore.getState().fireHireEvent(makeHire("Dispute2", "comms", "dispute_volume"));
    useFactoryStore.getState().fireHireEvent(makeHire("Dispute3", "comms", "dispute_volume"));
    const after = useFactoryStore.getState().rooms.cs.occupants?.length ?? 0;
    expect(after).toBe(before + 3);
    useFactoryStore.getState().fireHireEvent(makeHire("Dispute4", "comms", "dispute_volume"));
    const commsRooms = Object.values(useFactoryStore.getState().rooms).filter(
      (r) => r.kit?.primaryTag === "comms",
    );
    expect(commsRooms.length).toBeGreaterThanOrEqual(2);
  });

  it("creates a new room of a tag never seen before (legal)", () => {
    expect(Object.values(useFactoryStore.getState().rooms).some((r) => r.kit?.primaryTag === "legal")).toBe(false);
    useFactoryStore.getState().fireHireEvent(makeHire("Tax", "legal", "tax_cycle"));
    expect(Object.values(useFactoryStore.getState().rooms).some((r) => r.kit?.primaryTag === "legal")).toBe(true);
  });

  it("dissolveAgent removes the role + agent; if last occupant, marks room dissolving", () => {
    useFactoryStore.getState().fireHireEvent(makeHire("Tax", "legal", "tax_cycle"));
    const legalRooms = Object.values(useFactoryStore.getState().rooms).filter((r) => r.kit?.primaryTag === "legal");
    expect(legalRooms).toHaveLength(1);
    const legalRoom = legalRooms[0];
    const tax = Object.values(useFactoryStore.getState().roles).find((r) => r.name === "Tax");
    expect(tax).toBeDefined();
    useFactoryStore.getState().dissolveAgent(tax!.id);
    vi.advanceTimersByTime(700);
    expect(useFactoryStore.getState().rooms[legalRoom.id]?.dissolving).toBe(true);
  });

  it("never dissolves a permanent role", () => {
    useFactoryStore.getState().dissolveAgent("orchestrator");
    vi.advanceTimersByTime(700);
    expect(useFactoryStore.getState().roles.orchestrator).toBeDefined();
    expect(useFactoryStore.getState().rooms.strategy?.dissolving).toBeFalsy();
  });
});
