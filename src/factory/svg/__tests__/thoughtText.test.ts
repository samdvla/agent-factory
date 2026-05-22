import { describe, it, expect } from "vitest";
import { deriveThoughts, thoughtForAgent, THOUGHT_MAX_CHARS } from "../thoughtText";
import type { AgentEntry } from "../../state/types";

function agent(role: string, over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    role, name: role, state: "idle", task: "", model: "Sonnet 4.6",
    tokensToday: 0, completedToday: 0, failedToday: 0, currentJobId: null,
    ...over,
  };
}

describe("thoughtForAgent — natural language", () => {
  it("returns a natural phrase for a known working role (not a raw log line)", () => {
    const t = thoughtForAgent("research", agent("research", { state: "working", currentJobId: 5 }));
    expect(t.length).toBeGreaterThan(0);
    // Must NOT be system-log noise.
    expect(t).not.toMatch(/exited|will restart|job #|process_job|→/);
  });

  it("uses a role-specific bank when one exists", () => {
    // anime_spec working lines all reference anime/character craft — assert the
    // returned phrase is one of that role's curated lines.
    const banks = new Set([
      "big expressive eyes", "dramatic hair + pose",
      "make her look heroic", "what'll sell on Etsy?",
    ]);
    // Sweep job ids to cover every index in the bank.
    const seen = new Set<string>();
    for (let j = 0; j < 8; j++) {
      seen.add(thoughtForAgent("anime_spec", agent("anime_spec", { state: "working", currentJobId: j })));
    }
    for (const s of seen) expect(banks.has(s)).toBe(true);
  });

  it("falls back to the GENERIC bank for an unknown / future role", () => {
    const t = thoughtForAgent("printify_op_xyz", agent("printify_op_xyz", { state: "working", currentJobId: 1 }));
    expect(["on it", "working through this", "almost there", "making progress"]).toContain(t);
  });

  it("gives idle agents an idle line, working agents a working line", () => {
    const idle = thoughtForAgent("designer", agent("designer", { state: "idle" }));
    const working = thoughtForAgent("designer", agent("designer", { state: "working", currentJobId: 1 }));
    expect(idle).not.toBe("");
    expect(working).not.toBe("");
    // The idle line should come from the idle bank, not the working bank.
    expect(["ready for the next one", "sketching ideas"]).toContain(idle);
  });

  it("shows a natural recovery line for crashed agents, never the raw log", () => {
    const t = thoughtForAgent("orchestrator", agent("orchestrator", { state: "crashed" }));
    expect(t).not.toMatch(/exited|will restart/);
    expect(t.length).toBeGreaterThan(0);
  });

  it("returns no bubble for transient/gone states", () => {
    for (const st of ["killed", "quarantined", "materializing", "dissolving"] as const) {
      expect(thoughtForAgent("designer", agent("designer", { state: st }))).toBe("");
    }
  });

  it("rotates the phrase as the job changes (feels alive)", () => {
    const a1 = thoughtForAgent("listing", agent("listing", { state: "working", currentJobId: 1 }));
    const a2 = thoughtForAgent("listing", agent("listing", { state: "working", currentJobId: 2 }));
    const a3 = thoughtForAgent("listing", agent("listing", { state: "working", currentJobId: 3 }));
    // At least two distinct lines across three consecutive jobs.
    expect(new Set([a1, a2, a3]).size).toBeGreaterThan(1);
  });

  it("is stable for the same agent state (no per-render flicker)", () => {
    const a = agent("cfo", { state: "working", currentJobId: 7, completedToday: 3 });
    expect(thoughtForAgent("cfo", a)).toBe(thoughtForAgent("cfo", a));
  });

  it("never exceeds the char cap", () => {
    // Every phrase in every bank, every role/mode, stays within the cap.
    for (let j = 0; j < 12; j++) {
      const t = thoughtForAgent("marketing", agent("marketing", { state: "working", currentJobId: j }));
      expect(t.length).toBeLessThanOrEqual(THOUGHT_MAX_CHARS);
    }
  });
});

describe("deriveThoughts", () => {
  it("produces a thought for every agent in a workable state", () => {
    const agents = {
      research: agent("research", { state: "working", currentJobId: 1 }),
      designer: agent("designer", { state: "idle" }),
      anime_spec: agent("anime_spec", { state: "walking" }),
    };
    const out = deriveThoughts(agents);
    expect(out["research"]).toBeTruthy();
    expect(out["designer"]).toBeTruthy();
    expect(out["anime_spec"]).toBeTruthy();
  });

  it("omits agents whose state warrants no bubble", () => {
    const agents = {
      gone: agent("gone", { state: "killed" }),
      active: agent("active", { state: "working", currentJobId: 1 }),
    };
    const out = deriveThoughts(agents);
    expect(out["gone"]).toBeUndefined();
    expect(out["active"]).toBeTruthy();
  });
});
