import { describe, it, expect, beforeEach } from "vitest";
import { useFactoryStore } from "../factoryStore";

describe("awardStar — reward tier progression", () => {
  beforeEach(() => {
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("starts unrewarded (no entry in rewardsByRole)", () => {
    expect(useFactoryStore.getState().rewardsByRole.research).toBeUndefined();
  });

  it("first award sets stars=1 tier=0 (bronze)", () => {
    useFactoryStore.getState().awardStar("research");
    expect(useFactoryStore.getState().rewardsByRole.research).toEqual({ stars: 1, tier: 0 });
  });

  it("ten awards fill the bronze tier without ticking the tier counter", () => {
    for (let i = 0; i < 10; i++) useFactoryStore.getState().awardStar("designer");
    expect(useFactoryStore.getState().rewardsByRole.designer).toEqual({ stars: 10, tier: 0 });
  });

  it("eleventh award resets to 1 star and advances the tier (bronze → silver)", () => {
    for (let i = 0; i < 11; i++) useFactoryStore.getState().awardStar("listing");
    expect(useFactoryStore.getState().rewardsByRole.listing).toEqual({ stars: 1, tier: 1 });
  });

  it("walks through bronze → silver → gold → platinum → diamond and caps at diamond", () => {
    // 5 tiers × 10 stars per tier + 1 extra to confirm cap.
    for (let i = 0; i < 5 * 10 + 1; i++) useFactoryStore.getState().awardStar("cs");
    // Just hit the 51st award → would advance to tier 5 but cap is 4.
    expect(useFactoryStore.getState().rewardsByRole.cs).toEqual({ stars: 1, tier: 4 });
    // Pile on more — tier must not go above 4.
    for (let i = 0; i < 50; i++) useFactoryStore.getState().awardStar("cs");
    expect(useFactoryStore.getState().rewardsByRole.cs!.tier).toBe(4);
  });

  it("tracks each role independently", () => {
    useFactoryStore.getState().awardStar("research");
    useFactoryStore.getState().awardStar("designer");
    useFactoryStore.getState().awardStar("designer");
    expect(useFactoryStore.getState().rewardsByRole.research).toEqual({ stars: 1, tier: 0 });
    expect(useFactoryStore.getState().rewardsByRole.designer).toEqual({ stars: 2, tier: 0 });
  });

  it("ignores empty roleId", () => {
    useFactoryStore.getState().awardStar("");
    expect(useFactoryStore.getState().rewardsByRole[""]).toBeUndefined();
  });
});
