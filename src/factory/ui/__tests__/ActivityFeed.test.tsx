import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { JobRow } from "../../../api";

const listRecentJobs = vi.fn();
const rateJob = vi.fn(async () => undefined);
const readJobSvg = vi.fn(async () => null);

vi.mock("../../../api", () => ({
  api: {
    listRecentJobs: (...a: unknown[]) => listRecentJobs(...a),
    rateJob: (...a: unknown[]) => rateJob(...a),
    readJobSvg: (...a: unknown[]) => readJobSvg(...a),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

import ActivityFeed from "../ActivityFeed";

function row(over: Partial<JobRow>): JobRow {
  return {
    id: 1,
    agent_role: "research",
    status: "done",
    payload_json: "{}",
    result_json: null,
    error: null,
    started_at: "2026-05-11T21:00:00Z",
    finished_at: "2026-05-11T21:00:05Z",
    scheduled_at: "2026-05-11T20:59:59Z",
    rating: null,
    rating_note: null,
    rated_at: null,
    ...over,
  };
}

describe("ActivityFeed", () => {
  beforeEach(() => {
    listRecentJobs.mockReset();
    rateJob.mockReset();
    rateJob.mockResolvedValue(undefined);
    readJobSvg.mockReset();
    readJobSvg.mockResolvedValue(null);
  });

  it("shows the empty state when there are no jobs", async () => {
    listRecentJobs.mockResolvedValue([]);
    render(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText(/No completed jobs yet/)).toBeTruthy();
    });
  });

  it("renders a research card with niche and keywords", async () => {
    listRecentJobs.mockResolvedValue([
      row({
        id: 7,
        agent_role: "research",
        result_json: JSON.stringify({
          brief: {
            niche: "minimalist line art",
            keywords: ["kw1", "kw2", "kw3"],
            price_band_usd: [3, 9],
            competition: "low",
            rationale: "because",
          },
        }),
      }),
    ]);
    render(<ActivityFeed />);
    await waitFor(() => expect(screen.getByText("minimalist line art")).toBeTruthy());
    expect(screen.getByText("kw1")).toBeTruthy();
    expect(screen.getByText("kw2")).toBeTruthy();
    expect(screen.getByText("#7")).toBeTruthy();
    expect(screen.getByText("low comp")).toBeTruthy();
  });

  it("renders a designer card and requests the SVG", async () => {
    readJobSvg.mockResolvedValue("<svg><rect/></svg>");
    listRecentJobs.mockResolvedValue([
      row({
        id: 9,
        agent_role: "designer",
        result_json: JSON.stringify({
          asset: {
            asset_path: "/tmp/9.svg",
            palette: ["#000", "#fff"],
            dimensions: "8x10 print",
            style: "loose ink",
          },
        }),
      }),
    ]);
    const { container } = render(<ActivityFeed />);
    await waitFor(() => expect(readJobSvg).toHaveBeenCalledWith(9));
    await waitFor(() => {
      const img = container.querySelector("img.af-svg-tile");
      expect(img).toBeTruthy();
      expect((img as HTMLImageElement).src).toMatch(/^data:image\/svg\+xml;base64,/);
    });
  });

  it("calls rateJob and applies optimistic rating", async () => {
    listRecentJobs.mockResolvedValue([
      row({
        id: 12,
        agent_role: "listing",
        result_json: JSON.stringify({ listing: { title: "Cosmic art print", tags: [] } }),
      }),
    ]);
    render(<ActivityFeed />);
    await waitFor(() => expect(screen.getByText("Cosmic art print")).toBeTruthy());
    fireEvent.click(screen.getByTitle("Good output"));
    await waitFor(() => expect(rateJob).toHaveBeenCalledWith(12, "up", null));
    // Button reflects the optimistic active state.
    const good = screen.getByTitle("Good output");
    expect(good.getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles rating off when same button clicked again", async () => {
    listRecentJobs.mockResolvedValue([
      row({
        id: 13,
        agent_role: "cs",
        rating: "up",
        result_json: JSON.stringify({ reply: "hi", conversation_id: 100 }),
      }),
    ]);
    render(<ActivityFeed />);
    const good = await screen.findByTitle("Good output");
    fireEvent.click(good);
    await waitFor(() => expect(rateJob).toHaveBeenCalledWith(13, null, null));
  });

  it("filters by rating chip", async () => {
    listRecentJobs.mockResolvedValue([
      row({ id: 100, agent_role: "research", rating: "up",
        result_json: JSON.stringify({ brief: { niche: "good niche" } }) }),
      row({ id: 101, agent_role: "research", rating: null,
        result_json: JSON.stringify({ brief: { niche: "needs review" } }) }),
    ]);
    render(<ActivityFeed />);
    await waitFor(() => expect(screen.getByText("good niche")).toBeTruthy());
    expect(screen.getByText("needs review")).toBeTruthy();
    fireEvent.click(screen.getByText("Unrated"));
    await waitFor(() => {
      expect(screen.queryByText("good niche")).toBeNull();
      expect(screen.getByText("needs review")).toBeTruthy();
    });
  });

  it("renders an error card for errored jobs", async () => {
    listRecentJobs.mockResolvedValue([
      row({ id: 50, agent_role: "publisher", status: "errored",
        error: "etsy 400: Invalid taxonomy_id" }),
    ]);
    render(<ActivityFeed />);
    await waitFor(() => expect(screen.getByText(/Invalid taxonomy_id/)).toBeTruthy());
  });
});
