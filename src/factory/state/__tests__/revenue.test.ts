import { describe, it, expect, beforeEach } from "vitest";
import { useFactoryStore } from "../factoryStore";

describe("revenue", () => {
  beforeEach(() => {
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("starts at 0 and accumulates per role", () => {
    expect(useFactoryStore.getState().revenueTodayUsd).toBe(0);
    useFactoryStore.getState().addRevenue("designer", 0.40);
    useFactoryStore.getState().addRevenue("designer", 0.30);
    useFactoryStore.getState().addRevenue("research", 0.25);
    expect(useFactoryStore.getState().revenueTodayUsd).toBeCloseTo(0.95, 5);
    expect(useFactoryStore.getState().revenueByRole.designer).toBeCloseTo(0.70, 5);
    expect(useFactoryStore.getState().revenueByRole.research).toBeCloseTo(0.25, 5);
  });
});
