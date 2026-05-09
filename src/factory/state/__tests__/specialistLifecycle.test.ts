import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFactoryStore } from "../factoryStore";
import { HireEvent } from "../types";

function makeHire(name: string): HireEvent {
  return {
    id: `h-${name}`,
    ts: Date.now(),
    roleSpec: { name, title: "Specialist", primaryTag: "comms", archetype: "office", model: "Haiku" },
    justification: { reason: "dispute_volume", metric: "test" },
  };
}

describe("specialist lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("transitions materializing → working after 600ms", () => {
    useFactoryStore.getState().fireHireEvent(makeHire("S1"));
    const role = Object.values(useFactoryStore.getState().roles).find(r => r.name === "S1");
    expect(useFactoryStore.getState().agents[role!.id].state).toBe("materializing");
    vi.advanceTimersByTime(700);
    expect(useFactoryStore.getState().agents[role!.id].state).toBe("working");
  });

  it("addRevenue accumulates per role and globally", () => {
    useFactoryStore.getState().fireHireEvent(makeHire("S2"));
    const role = Object.values(useFactoryStore.getState().roles).find(r => r.name === "S2");
    useFactoryStore.getState().addRevenue(role!.id, 0.30);
    useFactoryStore.getState().addRevenue(role!.id, 0.25);
    expect(useFactoryStore.getState().revenueByRole[role!.id]).toBeCloseTo(0.55, 5);
    expect(useFactoryStore.getState().revenueTodayUsd).toBeCloseTo(0.55, 5);
  });

  it("dissolve prunes revenueByRole and agentLastIdleAt entries", () => {
    useFactoryStore.getState().fireHireEvent(makeHire("S3"));
    const role = Object.values(useFactoryStore.getState().roles).find(r => r.name === "S3");
    useFactoryStore.getState().addRevenue(role!.id, 0.40);
    expect(useFactoryStore.getState().revenueByRole[role!.id]).toBe(0.40);
    useFactoryStore.getState().dissolveAgent(role!.id);
    vi.advanceTimersByTime(1000);
    expect(useFactoryStore.getState().revenueByRole[role!.id]).toBeUndefined();
    expect(useFactoryStore.getState().agentLastIdleAt[role!.id]).toBeUndefined();
    expect(useFactoryStore.getState().revenueTodayUsd).toBeCloseTo(0.40, 5);
  });

  it("idleDissolveTick eventually removes a long-idle non-permanent agent", () => {
    useFactoryStore.getState().fireHireEvent(makeHire("S4"));
    const role = Object.values(useFactoryStore.getState().roles).find(r => r.name === "S4");
    // Materialize → working.
    vi.advanceTimersByTime(700);
    // Manually transition to idle (in real life the work-window timeout does this).
    useFactoryStore.getState().setAgentState(role!.id, "idle");
    // Idle threshold is 90s by default. Tick well past it.
    vi.advanceTimersByTime(95_000);
    useFactoryStore.getState().idleDissolveTick(Date.now(), 90_000);
    // Dissolve setTimeout is 900ms; advance.
    vi.advanceTimersByTime(1100);
    expect(useFactoryStore.getState().roles[role!.id]).toBeUndefined();
  });
});
