import { describe, it, expect, beforeEach } from "vitest";
import { useFactoryStore } from "../factoryStore";
import { applySupervisorEvent } from "../eventReducer";

/** End-to-end-ish: simulate the supervisor.event payloads the Rust backend
 *  emits and verify the store mutations that drive the floor animations. */

describe("supervisor events drive the floor", () => {
  beforeEach(() => {
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("agent_started flips state to idle and marks real activity", () => {
    const t0 = Date.now();
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "agent_started",
      role: "research",
    });
    const s = useFactoryStore.getState();
    expect(s.agents.research.state).toBe("idle");
    expect(s.realActivityAt.research).toBeGreaterThanOrEqual(t0);
  });

  it("job_started flips an agent to 'working' AND bumps realActivityAt", () => {
    const t0 = Date.now();
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_started",
      role: "designer",
      job_id: 42,
    });
    const s = useFactoryStore.getState();
    expect(s.agents.designer.state).toBe("working");
    expect(s.realActivityAt.designer).toBeGreaterThanOrEqual(t0);
  });

  it("job_completed flips back to idle and bumps realActivityAt", () => {
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_started",
      role: "designer",
      job_id: 42,
    });
    const tMid = Date.now();
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_completed",
      role: "designer",
      job_id: 42,
      result: { ok: true, ticker_text: "done" },
    });
    const s = useFactoryStore.getState();
    expect(s.agents.designer.state).toBe("idle");
    expect(s.realActivityAt.designer).toBeGreaterThanOrEqual(tMid);
  });

  it("enqueue_handoff notification pushes a Handoff with from/to rooms", () => {
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "worker_notification",
      role: "designer",
      method: "enqueue_handoff",
      params: { to_role: "listing", payload: {} },
    });
    const s = useFactoryStore.getState();
    expect(s.handoffs.length).toBe(1);
    expect(s.handoffs[0].fromRoom).toBe("design");
    expect(s.handoffs[0].toRoom).toBe("listing");
    expect(s.handoffs[0].label).toMatch(/asset bundle/i);
  });

  it("budget_spent does not error and is silent on realActivityAt for roles", () => {
    // budget_spent carries a role too — should still mark activity.
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "budget_spent",
      role: "research",
      // @ts-expect-error — runtime payload has these extras
      cost_usd: 0.001,
    });
    const s = useFactoryStore.getState();
    expect(s.realActivityAt.research).toBeGreaterThan(0);
  });

  it("every job completion across a full cycle leaves realActivityAt set for each role", () => {
    const cycle = [
      { kind: "job_started", role: "orchestrator", job_id: 1 },
      { kind: "job_completed", role: "orchestrator", job_id: 1, result: { ok: true } },
      { kind: "job_started", role: "research", job_id: 2 },
      { kind: "job_completed", role: "research", job_id: 2, result: { ok: true } },
      { kind: "job_started", role: "designer", job_id: 3 },
      { kind: "job_completed", role: "designer", job_id: 3, result: { ok: true } },
      { kind: "job_started", role: "listing", job_id: 4 },
      { kind: "job_completed", role: "listing", job_id: 4, result: { ok: true } },
      { kind: "job_started", role: "publisher", job_id: 5 },
      { kind: "job_completed", role: "publisher", job_id: 5, result: { ok: true } },
      { kind: "job_started", role: "cfo", job_id: 6 },
      { kind: "job_completed", role: "cfo", job_id: 6, result: { ok: true } },
    ];
    for (const e of cycle) {
      applySupervisorEvent(useFactoryStore.getState(), e);
    }
    const s = useFactoryStore.getState();
    for (const r of ["orchestrator", "research", "designer", "listing", "publisher", "cfo"]) {
      expect(s.realActivityAt[r], `realActivityAt missing for ${r}`).toBeGreaterThan(0);
    }
  });
});
