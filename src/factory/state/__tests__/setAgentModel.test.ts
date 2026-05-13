import { describe, it, expect, beforeEach } from "vitest";
import { useFactoryStore } from "../factoryStore";

describe("setAgentModel", () => {
  beforeEach(() => {
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("normalizes claude-opus-4-7 to 'Opus 4.7'", () => {
    useFactoryStore.getState().setAgentModel("strategist", "claude-opus-4-7");
    expect(useFactoryStore.getState().agents.strategist.model).toBe("Opus 4.7");
  });

  it("normalizes claude-sonnet-4-6-20251001 to 'Sonnet 4.6'", () => {
    useFactoryStore.getState().setAgentModel("designer", "claude-sonnet-4-6-20251001");
    expect(useFactoryStore.getState().agents.designer.model).toBe("Sonnet 4.6");
  });

  it("normalizes claude-haiku-4-5 to 'Haiku 4.5'", () => {
    useFactoryStore.getState().setAgentModel("research", "claude-haiku-4-5");
    expect(useFactoryStore.getState().agents.research.model).toBe("Haiku 4.5");
  });

  it("ignores unrecognized model ids", () => {
    const before = useFactoryStore.getState().agents.cfo.model;
    useFactoryStore.getState().setAgentModel("cfo", "gpt-4-turbo");
    expect(useFactoryStore.getState().agents.cfo.model).toBe(before);
  });

  it("creates an agent entry on the fly for unknown roles", () => {
    useFactoryStore.getState().setAgentModel("translator", "claude-sonnet-4-6");
    expect(useFactoryStore.getState().agents.translator.model).toBe("Sonnet 4.6");
  });

  it("is idempotent when the label is unchanged", () => {
    const store = useFactoryStore.getState();
    store.setAgentModel("strategist", "claude-opus-4-7");
    const first = useFactoryStore.getState().agents;
    store.setAgentModel("strategist", "claude-opus-4-7-20260101");
    const second = useFactoryStore.getState().agents;
    expect(second).toBe(first);
  });
});
