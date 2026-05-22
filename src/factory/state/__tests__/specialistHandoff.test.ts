import { describe, it, expect, beforeEach } from "vitest";
import { useFactoryStore } from "../factoryStore";
import { applySupervisorEvent } from "../eventReducer";

describe("designer → specialist handoff (event reducer)", () => {
  beforeEach(() => {
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("walks the matching specialist to working when designer emits specialist_assigned", () => {
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "worker_notification",
      role: "designer",
      method: "event",
      params: {
        kind: "specialist_assigned",
        archetype: "anime_stylized",
        specialist_role: "anime_spec",
        designer_job_id: 9001,
        niche: "anime warrior maiden figurine",
      },
    });
    const s = useFactoryStore.getState();
    expect(s.agents["anime_spec"].state).toBe("working");
    expect(s.agents["anime_spec"].task).toContain("anime_stylized");
  });

  it("pushes a design → specialist handoff doc-sprite", () => {
    const before = useFactoryStore.getState().handoffs.length;
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "worker_notification",
      role: "designer",
      method: "event",
      params: {
        kind: "specialist_assigned",
        archetype: "humanoid_character",
        specialist_role: "humanoid_spec",
        designer_job_id: 9002,
        niche: "Skitarii cybernetic ranger",
      },
    });
    const s = useFactoryStore.getState();
    expect(s.handoffs.length).toBe(before + 1);
    const last = s.handoffs[s.handoffs.length - 1];
    expect(last.fromRoom).toBe("design");
    expect(last.toRoom).toBe("humanoid");
  });

  it("pushes a ticker line tagged designer → specialist", () => {
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "worker_notification",
      role: "designer",
      method: "event",
      params: {
        kind: "specialist_assigned",
        archetype: "creature",
        specialist_role: "creature_spec",
        designer_job_id: 9003,
        niche: "fantasy dragon mini",
      },
    });
    const s = useFactoryStore.getState();
    const last = s.ticker[0];
    expect(last.source).toBe("designer");
    expect(last.text).toContain("creature_spec");
    expect(last.text).toContain("creature");
  });

  it("resets every working specialist when designer's job_completed fires", () => {
    // Set two specialists to working (simulating two back-to-back routes).
    useFactoryStore.getState().setAgentState("anime_spec", "working");
    useFactoryStore.getState().setAgentState("humanoid_spec", "working");
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_completed",
      role: "designer",
      job_id: 9001,
      result: { ok: true, ticker_text: "designer → listing" },
    });
    const s = useFactoryStore.getState();
    expect(s.agents["anime_spec"].state).toBe("idle");
    expect(s.agents["humanoid_spec"].state).toBe("idle");
  });

  it("pushes return-trip handoffs (specialist → design) for every reset specialist", () => {
    // Two specialists working — both should fly their finished asset back
    // to the design room when the designer completes.
    useFactoryStore.getState().setAgentState("anime_spec", "working");
    useFactoryStore.getState().setAgentState("creature_spec", "working");
    const before = useFactoryStore.getState().handoffs.length;
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_completed",
      role: "designer",
      job_id: 9101,
      result: { ok: true },
    });
    const s = useFactoryStore.getState();
    expect(s.handoffs.length).toBe(before + 2);
    // Last two handoffs should be returns from anime / creature → design.
    const returns = s.handoffs.slice(-2);
    const dests = returns.map((h) => h.toRoom).sort();
    expect(dests).toEqual(["design", "design"]);
    const sources = returns.map((h) => h.fromRoom).sort();
    expect(sources).toEqual(["anime", "creature"]);
    for (const h of returns) {
      expect(h.label).toBe("finished asset");
    }
  });

  it("does NOT push return-trip handoffs for specialists that were already idle", () => {
    // No specialists working → no return handoffs even when designer completes.
    const before = useFactoryStore.getState().handoffs.length;
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_completed",
      role: "designer",
      job_id: 9102,
      result: { ok: true },
    });
    const s = useFactoryStore.getState();
    expect(s.handoffs.length).toBe(before);
  });

  it("resets specialists on job_failed too", () => {
    useFactoryStore.getState().setAgentState("mecha_spec", "working");
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_failed",
      role: "designer",
      job_id: 9004,
      error: "tripo timeout",
    });
    const s = useFactoryStore.getState();
    expect(s.agents["mecha_spec"].state).toBe("idle");
  });

  it("does NOT reset specialists when a non-designer job completes", () => {
    useFactoryStore.getState().setAgentState("anime_spec", "working");
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "job_completed",
      role: "listing",
      job_id: 9005,
      result: { ok: true },
    });
    const s = useFactoryStore.getState();
    // anime_spec must stay working — only designer's completion ends its run.
    expect(s.agents["anime_spec"].state).toBe("working");
  });

  it("ignores specialist_assigned with an unknown specialist_role", () => {
    applySupervisorEvent(useFactoryStore.getState(), {
      kind: "worker_notification",
      role: "designer",
      method: "event",
      params: {
        kind: "specialist_assigned",
        archetype: "made_up",
        specialist_role: "ghost_spec",  // does not exist
      },
    });
    // No crash, no specialist walked. Ticker still records the event via
    // the fallback humanizer (acceptable side effect).
    const s = useFactoryStore.getState();
    expect(s.agents["ghost_spec"]).toBeUndefined();
  });
});
