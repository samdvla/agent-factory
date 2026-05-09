// Shared constants, singleton state, and helpers for the demo floor simulation.
// All four sub-hooks import from here so they mutate the same SIM instance.

export type SimState = {
  designerQueue: number;
  openDisputes: number;
  intlOrdersPending: number;
  nichesQueued: number;
  dayInQuarter: number;
};

export const SIM: SimState = {
  designerQueue: 0,
  openDisputes: 0,
  intlOrdersPending: 0,
  nichesQueued: 0,
  dayInQuarter: 0,
};

// USD earned per completed phase. Tuned so a healthy loop nets positive.
export const REVENUE_PER_PHASE: Record<string, number> = {
  // Founding
  "Orchestrator": 0.30,
  "Iris Vega": 0.25,
  "Mara Chen": 0.40,
  "Theo Park": 0.35,
  "Avery Holt": 0.45,
  "Lina Okafor": 0.20,
  "Roman Voss": 0.15,
  "Sable Wynn": 0.20,
  // Specialists
  "Mockup Artist": 0.30,
  "Dispute Negotiator": 0.25,
  "Translator": 0.20,
  "Tax Helper": 0.40,
  "Trend Hunter": 0.25,
};

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
