import { useRef } from "react";
import { useFactoryStore } from "../../factory/state/factoryStore";
import { ROLES } from "../../factory/state/fixtures";
import { REVENUE_PER_PHASE, rand, sleep } from "./constants";

export type SpecialistProfile = {
  parentRoleId: string;
  parentLabel: string;
  workMin: number;
  workMax: number;
  phases: Array<{ task: string; ticker: string }>;
};

export const SPECIALIST_PROFILES: Record<string, SpecialistProfile> = {
  "Mockup Artist": {
    parentRoleId: "designer",
    parentLabel: "variant",
    workMin: 6000, workMax: 9500,
    phases: [
      { task: "render alt mockup A · sage palette",    ticker: "mockup A · 1200×1800 · sage" },
      { task: "render alt mockup B · cream palette",   ticker: "mockup B · cream/terracotta" },
      { task: "render alt mockup C · keyword overlay", ticker: "mockup C · keyword overlay" },
      { task: "vector cut-file · trace + clean",       ticker: "SVG cut-file · 4 layers" },
    ],
  },
  "Dispute Negotiator": {
    parentRoleId: "cs",
    parentLabel: "case file",
    workMin: 5500, workMax: 8500,
    phases: [
      { task: "review case · evidence + tone",         ticker: "dispute #14 · scoring tone" },
      { task: "draft policy-bound reply",              ticker: "reply: refund declined per policy" },
      { task: "escalation note → orchestrator",        ticker: "escalation: case #17 → orchestrator" },
      { task: "post-resolution log + lessons",         ticker: "lesson: bundle FAQ on file format" },
    ],
  },
  "Translator": {
    parentRoleId: "listing",
    parentLabel: "i18n",
    workMin: 4500, workMax: 7000,
    phases: [
      { task: "translate description · ES",            ticker: "ES · description ready" },
      { task: "translate description · FR",            ticker: "FR · description ready" },
      { task: "translate description · DE",            ticker: "DE · description ready" },
      { task: "alt-text i18n · all mockups",           ticker: "alt-text · ES/FR/DE done" },
    ],
  },
  "Tax Helper": {
    parentRoleId: "cfo",
    parentLabel: "tax bucket",
    workMin: 6000, workMax: 9000,
    phases: [
      { task: "Q-end statement · gross/net",           ticker: "Q-end: gross $X · fees $Y" },
      { task: "set-aside · 30% of net",                ticker: "tax set-aside +$Z this Q" },
      { task: "deduction worksheet · digital biz",     ticker: "deductions · 6 categories logged" },
      { task: "policy delta vs last quarter",          ticker: "policy: 1099-K thresholds noted" },
    ],
  },
  "Trend Hunter": {
    parentRoleId: "research",
    parentLabel: "niche hint",
    workMin: 5000, workMax: 8000,
    phases: [
      { task: "scan TikTok · Etsy crossover",          ticker: "trend: 'cottagecore SVG' rising" },
      { task: "long-tail keyword expansion",           ticker: "long-tail · 14 candidates" },
      { task: "competitor density check",              ticker: "comp density: low · enter window" },
      { task: "demand pulse · 7d sample",              ticker: "demand pulse: +12% w/w" },
    ],
  },
};

export function useSpecialistLoops(cancelledRef: { current: boolean }): {
  startSpecialistLoop: (roleId: string, profile: SpecialistProfile) => void;
} {
  const store = useFactoryStore;
  // Track which specialist role IDs already have a running loop.
  const runningRef = useRef(new Set<string>());

  function startSpecialistLoop(roleId: string, profile: SpecialistProfile) {
    if (runningRef.current.has(roleId)) return;
    runningRef.current.add(roleId);
    runSpecialistLoop(roleId, profile);
  }

  async function runSpecialistLoop(roleId: string, profile: SpecialistProfile) {
    // Wait for materialize→working transition (~600ms in fireHireEvent).
    await sleep(700);
    let counter = 0;
    while (!cancelledRef.current) {
      const live = store.getState().roles[roleId];
      const agent = store.getState().agents[roleId];
      if (!live || !agent) {
        runningRef.current.delete(roleId);
        return;
      }
      // Stop running phases once the work-window timeout flips us to idle.
      if (agent.state !== "working") {
        runningRef.current.delete(roleId);
        return;
      }

      const phase = profile.phases[counter % profile.phases.length];
      counter++;
      const workMs = rand(profile.workMin, profile.workMax);

      const s = store.getState();
      s.setAgentTask(roleId, phase.task);
      s.setAgentJob(roleId, 9000 + counter);
      s.pushTicker({ ts: Date.now(), source: roleId, text: phase.ticker });

      await sleep(workMs);
      if (cancelledRef.current) {
        runningRef.current.delete(roleId);
        return;
      }
      const after = store.getState().agents[roleId];
      if (!after || after.state !== "working") {
        runningRef.current.delete(roleId);
        return;
      }

      // Chain handoff back to parent role.
      const parent = ROLES[profile.parentRoleId];
      const fromRole = store.getState().roles[roleId];
      if (parent && fromRole) {
        store.getState().pushHandoff({
          id: `spec-${roleId}-${counter}-${Date.now()}-${Math.random().toFixed(3)}`,
          fromRoom: fromRole.room,
          toRoom: parent.room,
          color: fromRole.hex,
          label: profile.parentLabel,
          startedAt: Date.now(),
          durationMs: 1700,
        });
        store.getState().pushTicker({
          ts: Date.now(),
          source: roleId,
          text: `→ ${parent.name}: ${profile.parentLabel}`,
        });
      }

      // Revenue per completed phase.
      const usd = REVENUE_PER_PHASE[fromRole?.name ?? ""] ?? 0.05;
      store.getState().addRevenue(roleId, usd);

      await sleep(rand(200, 600));
    }
    runningRef.current.delete(roleId);
  }

  return { startSpecialistLoop };
}
