import { describe, it, expect, beforeEach } from "vitest";
import { useFactoryStore } from "../factoryStore";

/* TIER_STAR_USD in factoryStore.ts:
 *   bronze   $1   (10 stars = $10)
 *   silver   $5   (10 stars = $50)
 *   gold     $25  (10 stars = $250)
 *   platinum $100 (10 stars = $1000)
 *   diamond  $500 (cap at 10 stars in this tier)
 * Total to first diamond star: $1810.
 */

describe("awardProgress — threshold-based star rewards", () => {
  beforeEach(() => {
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("starts unrewarded (no entry in rewardsByRole)", () => {
    expect(useFactoryStore.getState().rewardsByRole.research).toBeUndefined();
  });

  it("sub-threshold progress accumulates but doesn't award a star yet", () => {
    useFactoryStore.getState().awardProgress("research", 0.25);
    useFactoryStore.getState().awardProgress("research", 0.50);
    expect(useFactoryStore.getState().rewardsByRole.research).toEqual({
      stars: 0,
      tier: 0,
      progressUsd: 0.75,
    });
  });

  it("crossing the bronze threshold ($1) awards the first star", () => {
    useFactoryStore.getState().awardProgress("designer", 1.0);
    expect(useFactoryStore.getState().rewardsByRole.designer).toEqual({
      stars: 1,
      tier: 0,
      progressUsd: 0,
    });
  });

  it("$10 of progress fills the entire bronze tier (10 stars, still tier 0)", () => {
    useFactoryStore.getState().awardProgress("listing", 10);
    expect(useFactoryStore.getState().rewardsByRole.listing).toEqual({
      stars: 10,
      tier: 0,
      progressUsd: 0,
    });
  });

  it("$11 in bronze advances to silver tier with leftover progress", () => {
    useFactoryStore.getState().awardProgress("listing", 11);
    // $10 fills bronze. $1 remains, less than silver's $5 threshold → 0 silver stars, $1 progress.
    expect(useFactoryStore.getState().rewardsByRole.listing).toEqual({
      stars: 0,
      tier: 1,
      progressUsd: 1,
    });
  });

  it("silver stars cost $5 each — $30 buys 6 silver stars after filling bronze", () => {
    useFactoryStore.getState().awardProgress("publisher", 10 + 30);
    expect(useFactoryStore.getState().rewardsByRole.publisher).toEqual({
      stars: 6,
      tier: 1,
      progressUsd: 0,
    });
  });

  it("$1810 of total progress hits the first diamond star", () => {
    // $10 bronze + $50 silver + $250 gold + $1000 platinum + $500 first diamond star
    useFactoryStore.getState().awardProgress("cs", 1810);
    expect(useFactoryStore.getState().rewardsByRole.cs).toEqual({
      stars: 1,
      tier: 4,
      progressUsd: 0,
    });
  });

  it("diamond tier caps at 10 stars — extra progress doesn't push past", () => {
    // $1810 buys first diamond. Add $500 each for stars 2..10 = $4500.
    // $1810 + $4500 = $6310 hits 10 diamond stars exactly.
    useFactoryStore.getState().awardProgress("cfo", 6310);
    expect(useFactoryStore.getState().rewardsByRole.cfo).toEqual({
      stars: 10,
      tier: 4,
      progressUsd: 0,
    });
    // Pile on more — must not roll over.
    useFactoryStore.getState().awardProgress("cfo", 10_000);
    expect(useFactoryStore.getState().rewardsByRole.cfo!.stars).toBe(10);
    expect(useFactoryStore.getState().rewardsByRole.cfo!.tier).toBe(4);
  });

  it("tracks each role independently", () => {
    useFactoryStore.getState().awardProgress("research", 3);
    useFactoryStore.getState().awardProgress("designer", 5);
    expect(useFactoryStore.getState().rewardsByRole.research).toEqual({
      stars: 3,
      tier: 0,
      progressUsd: 0,
    });
    expect(useFactoryStore.getState().rewardsByRole.designer).toEqual({
      stars: 5,
      tier: 0,
      progressUsd: 0,
    });
  });

  it("ignores empty roleId, non-positive amounts, and NaN", () => {
    useFactoryStore.getState().awardProgress("", 5);
    useFactoryStore.getState().awardProgress("research", 0);
    useFactoryStore.getState().awardProgress("research", -1);
    useFactoryStore.getState().awardProgress("research", NaN);
    expect(useFactoryStore.getState().rewardsByRole[""]).toBeUndefined();
    expect(useFactoryStore.getState().rewardsByRole.research).toBeUndefined();
  });
});
