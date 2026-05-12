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
    vi.advanceTimersByTime(1000);
    expect(useFactoryStore.getState().rooms[legalRoom.id]?.dissolving).toBe(true);
  });

  it("never dissolves a permanent role", () => {
    useFactoryStore.getState().dissolveAgent("orchestrator");
    vi.advanceTimersByTime(700);
    expect(useFactoryStore.getState().roles.orchestrator).toBeDefined();
    expect(useFactoryStore.getState().rooms.strategy?.dissolving).toBeFalsy();
  });

  it("force: true bypasses permanence — used by user-toggle unhire (e.g. Printify off)", () => {
    // Hire a founding-reason specialist; resolver marks it permanent.
    useFactoryStore.getState().fireHireEvent({
      id: "printify-test",
      ts: Date.now(),
      roleSpec: {
        name: "Printify Operator",
        title: "POD",
        primaryTag: "ops",
        archetype: "office",
        model: "Sonnet",
      },
      justification: { reason: "founding", metric: "test" },
    });
    const role = Object.values(useFactoryStore.getState().roles).find(
      (r) => r.name === "Printify Operator",
    );
    expect(role).toBeDefined();
    expect(role!.permanent).toBe(true);

    // Plain dissolveAgent: no-op (permanent guard).
    useFactoryStore.getState().dissolveAgent(role!.id);
    vi.advanceTimersByTime(1500);
    expect(useFactoryStore.getState().roles[role!.id]).toBeDefined();

    // force: true bypasses the guard.
    useFactoryStore.getState().dissolveAgent(role!.id, { force: true });
    vi.advanceTimersByTime(2000);
    expect(useFactoryStore.getState().roles[role!.id]).toBeUndefined();
  });

  // === Slice J.B: founding-8 + wealth-aware dissolution ===

  it("dissolution_protects_founding_8", () => {
    // Founding orchestrator with deeply negative lifetime net, idle 10× the
    // threshold. MUST NOT dissolve — founding role.
    useFactoryStore.setState({
      wealthByRole: {
        orchestrator: {
          role: "orchestrator",
          lifetime_revenue_usd: 0,
          lifetime_cost_usd: 100,
          lifetime_net_usd: -100,
          cycles_count: 0,
        },
      },
    });
    useFactoryStore.getState().setAgentState("orchestrator", "idle");
    vi.advanceTimersByTime(900_000); // 10× the 90s threshold
    useFactoryStore.getState().idleDissolveTick(Date.now(), 90_000);
    vi.advanceTimersByTime(1500);
    expect(useFactoryStore.getState().roles.orchestrator).toBeDefined();
  });

  it("dissolution_protects_profitable_specialists", () => {
    useFactoryStore.getState().fireHireEvent(
      makeHire("specialist_a", "comms", "dispute_volume"),
    );
    const role = Object.values(useFactoryStore.getState().roles).find(
      (r) => r.name === "specialist_a",
    )!;
    // Materialize → working tick.
    vi.advanceTimersByTime(700);
    useFactoryStore.getState().setAgentState(role.id, "idle");
    useFactoryStore.setState({
      wealthByRole: {
        [role.id]: {
          role: role.id,
          lifetime_revenue_usd: 10,
          lifetime_cost_usd: 5,
          lifetime_net_usd: 5,
          cycles_count: 1,
        },
      },
    });
    vi.advanceTimersByTime(900_000);
    useFactoryStore.getState().idleDissolveTick(Date.now(), 90_000);
    vi.advanceTimersByTime(1500);
    expect(useFactoryStore.getState().roles[role.id]).toBeDefined();
  });

  it("dissolution_fires_unprofitable_idle_specialists", () => {
    useFactoryStore.getState().fireHireEvent(
      makeHire("specialist_b", "comms", "dispute_volume"),
    );
    const role = Object.values(useFactoryStore.getState().roles).find(
      (r) => r.name === "specialist_b",
    )!;
    vi.advanceTimersByTime(700);
    useFactoryStore.getState().setAgentState(role.id, "idle");
    useFactoryStore.setState({
      wealthByRole: {
        [role.id]: {
          role: role.id,
          lifetime_revenue_usd: 0,
          lifetime_cost_usd: 10,
          lifetime_net_usd: -10,
          cycles_count: 1,
        },
      },
    });
    vi.advanceTimersByTime(900_000);
    useFactoryStore.getState().idleDissolveTick(Date.now(), 90_000);
    vi.advanceTimersByTime(1500);
    expect(useFactoryStore.getState().roles[role.id]).toBeUndefined();
  });

  it("dissolution_grace_period_for_new_specialists", () => {
    // No wealth row, young (< 60s) → protected
    useFactoryStore.getState().fireHireEvent(
      makeHire("specialist_c", "comms", "dispute_volume"),
    );
    const role = Object.values(useFactoryStore.getState().roles).find(
      (r) => r.name === "specialist_c",
    )!;
    vi.advanceTimersByTime(700);
    useFactoryStore.getState().setAgentState(role.id, "idle");
    // Push idle past the 90s threshold but stay inside the 60s wealth-grace
    // window relative to agentCreatedAt: we only advance 30s after creation.
    // Threshold is shorter so idle-elapsed > threshold but created-elapsed < grace.
    // We use idleThreshold=10ms to make this trivial.
    vi.advanceTimersByTime(30_000);
    useFactoryStore.getState().idleDissolveTick(Date.now(), 10);
    vi.advanceTimersByTime(1500);
    // Still alive — under grace window.
    expect(useFactoryStore.getState().roles[role.id]).toBeDefined();

    // Now push past the 60s grace window. Still no wealth row → treat as loss.
    vi.advanceTimersByTime(60_000);
    useFactoryStore.getState().setAgentState(role.id, "idle"); // re-stamp idle
    vi.advanceTimersByTime(1000);
    useFactoryStore.getState().idleDissolveTick(Date.now(), 10);
    vi.advanceTimersByTime(1500);
    expect(useFactoryStore.getState().roles[role.id]).toBeUndefined();
  });
});
