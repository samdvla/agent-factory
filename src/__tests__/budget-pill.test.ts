import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { api } from "../api";

describe("api.budgetStatus", () => {
  beforeEach(() => invokeMock.mockReset());
  it("routes to cmd_budget_status", async () => {
    invokeMock.mockResolvedValueOnce({
      today_usd: 0.4, hour_usd: 0.1, month_usd: 0.4,
      hourly_cap_usd: 0.5, daily_cap_usd: 1, monthly_cap_usd: 20,
      burn_per_hour_usd: 0.1,
    });
    const s = await api.budgetStatus();
    expect(invokeMock).toHaveBeenCalledWith("cmd_budget_status");
    expect(s.today_usd).toBe(0.4);
  });
});
