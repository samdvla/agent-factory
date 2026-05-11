import { describe, it, expect, vi, beforeEach } from "vitest";

// invoke is the single boundary between api.ts and Tauri. Mock it and
// assert the api wrappers route to the right command names + arg shape.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { api } from "../api";

describe("api: prompt wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("listPrompts calls cmd_list_prompts with no args", async () => {
    invokeMock.mockResolvedValueOnce({
      research: {
        default: "x",
        override: null,
        last_tweak_ts: null,
        last_tweak_source: null,
        last_tweak_rationale: null,
      },
    });
    const rows = await api.listPrompts();
    expect(invokeMock).toHaveBeenCalledWith("cmd_list_prompts");
    expect(rows.research.default).toBe("x");
  });

  it("setPromptOverride wraps role+system under args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await api.setPromptOverride("designer", "new prompt body");
    expect(invokeMock).toHaveBeenCalledWith("cmd_set_prompt_override", {
      args: { role: "designer", system: "new prompt body" },
    });
  });

  it("clearPromptOverride passes role as snake-cased key", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await api.clearPromptOverride("cs");
    expect(invokeMock).toHaveBeenCalledWith("cmd_clear_prompt_override", {
      role: "cs",
    });
  });

  it("promptHistory forwards limit when supplied", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await api.promptHistory("listing", 3);
    expect(invokeMock).toHaveBeenCalledWith("cmd_prompt_history", {
      role: "listing",
      limit: 3,
    });
  });

  it("readAssetSvg uses camelCase param (tauri converts to listing_id)", async () => {
    invokeMock.mockResolvedValueOnce("<svg/>");
    const out = await api.readAssetSvg(42);
    expect(invokeMock).toHaveBeenCalledWith("cmd_read_asset_svg", {
      listingId: 42,
    });
    expect(out).toBe("<svg/>");
  });

  it("etsyListingReviewInfo routes correctly", async () => {
    const info = {
      state: "draft",
      title: "t",
      description: "d",
      tags: ["a"],
      niche: null,
      price_usd: null,
      url: null,
      cycle_id: null,
      estimated_revenue_usd: null,
      total_cost_usd: null,
      net_usd: null,
      cfo_rationale: null,
      active_publish_count: 0,
      first_listing_review_count: 3,
    };
    invokeMock.mockResolvedValueOnce(info);
    const out = await api.etsyListingReviewInfo(99);
    expect(invokeMock).toHaveBeenCalledWith("cmd_etsy_listing_review_info", {
      localListingId: 99,
    });
    expect(out.first_listing_review_count).toBe(3);
  });

  it("etsyDiscardDraft sends localListingId", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await api.etsyDiscardDraft(7);
    expect(invokeMock).toHaveBeenCalledWith("cmd_etsy_discard_draft", {
      localListingId: 7,
    });
  });
});
