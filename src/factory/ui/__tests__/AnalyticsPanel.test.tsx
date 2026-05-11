import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useFactoryStore } from "../../state/factoryStore";

// Mock the api module so listRecentCycles resolves without a Tauri runtime.
vi.mock("../../../api", () => ({
  api: {
    listRecentCycles: vi.fn(async () => []),
    listWealth: vi.fn(async () => []),
    readAssetSvg: vi.fn(async () => null),
  },
}));

// Mock @tauri-apps/api/event since it throws under jsdom.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import AnalyticsPanel from "../AnalyticsPanel";

describe("AnalyticsPanel", () => {
  beforeEach(() => {
    useFactoryStore.setState(useFactoryStore.getInitialState(), true);
  });

  it("renders the collapsed pill with the cycle count", () => {
    useFactoryStore.setState({
      recentCycles: [
        {
          cycle_id: "abcdef1234567890",
          niche: "boho",
          local_listing_id: 1,
          revenue_usd: 2.5,
          total_cost_usd: 1.0,
          net_usd: 1.5,
          contributor_count: 3,
        },
      ],
    });
    render(<AnalyticsPanel />);
    expect(screen.getByText("Cycles")).toBeTruthy();
    // The pill value should reflect the store count.
    const pill = screen.getByTitle(/recent cycle/);
    expect(pill.textContent).toMatch(/1/);
  });

  it("renders cycle rows when expanded", () => {
    useFactoryStore.setState({
      recentCycles: [
        {
          cycle_id: "deadbeefcafebabe",
          niche: "boho-svg",
          local_listing_id: 7,
          revenue_usd: 4.0,
          total_cost_usd: 2.5,
          net_usd: 1.5,
          contributor_count: 2,
        },
      ],
    });
    render(<AnalyticsPanel />);
    fireEvent.click(screen.getByTitle(/recent cycle/));
    // First 8 chars of cycle id are shown
    expect(screen.getByText("deadbeef")).toBeTruthy();
    // The niche, net (signed), and a numeric cell appear
    expect(screen.getByText("boho-svg")).toBeTruthy();
    expect(screen.getByText("+$1.50")).toBeTruthy();
  });

  it("renders an SVG thumbnail placeholder for each cycle row", () => {
    useFactoryStore.setState({
      recentCycles: [
        {
          cycle_id: "abc12345xyz",
          niche: "wall art",
          local_listing_id: 12,
          revenue_usd: 1.0,
          total_cost_usd: 0.5,
          net_usd: 0.5,
          contributor_count: 1,
        },
      ],
    });
    const { container } = render(<AnalyticsPanel />);
    fireEvent.click(screen.getByTitle(/recent cycle/));
    // The thumbnail container is present even before the async SVG resolves.
    const thumbs = container.querySelectorAll(".analytics-thumb");
    expect(thumbs.length).toBe(1);
  });
});
