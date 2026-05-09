import { useEffect } from "react";
import { useFactoryStore } from "../../factory/state/factoryStore";
import { ROLES } from "../../factory/state/fixtures";
import { SIM, REVENUE_PER_PHASE, rand, sleep, pickOne } from "./constants";

type Phase = { task: string; ticker: string };

type RoleLoop = {
  workMin: number;
  workMax: number;
  betweenMin: number;
  betweenMax: number;
  phases: Phase[];
  handoffTo?: string;
  handoffLabel: () => string;
  broadcasts?: string[];
  patrol?: string[];
};

const LOOPS: Record<string, RoleLoop> = {
  research: {
    workMin: 5500, workMax: 8500,
    betweenMin: 200, betweenMax: 600,
    phases: [
      { task: "scrape Etsy bestsellers",      ticker: "scanning bestsellers · boho printables +18%" },
      { task: "Google Trends · seasonal",     ticker: "trends → 'farmhouse SVG' rising 12%" },
      { task: "competitor pricing scan",      ticker: "competition: 14 listings · median $4.20" },
      { task: "keyword tool · long tail",     ticker: "long-tail: 'minimalist line art print'" },
    ],
    handoffTo: "orchestrator",
    handoffLabel: () => "demand brief",
    broadcasts: ["designer", "si"],
  },
  orchestrator: {
    workMin: 5000, workMax: 8000,
    betweenMin: 250, betweenMax: 700,
    phases: [
      { task: "review demand brief",           ticker: "approved brief #381 · scheduling design" },
      { task: "rebalance designer queue",      ticker: "designer queue 4 → 3 · CFO greenlit" },
      { task: "review CS dispute escalations", ticker: "1 dispute escalated → review by Lina + me" },
      { task: "monthly KPI review",            ticker: "weekly KPI: revenue $182.40 · refund 1.2%" },
    ],
    patrol: ["research", "designer", "listing", "publisher", "cs", "cfo", "si"],
    handoffTo: "designer",
    handoffLabel: () => "design ticket",
  },
  designer: {
    workMin: 6500, workMax: 10000,
    betweenMin: 250, betweenMax: 700,
    phases: [
      { task: "render printable v1 + 3 mockups", ticker: "SDXL · printable v1 + 3 lifestyle mockups" },
      { task: "vectorize SVG cut file",          ticker: "SVG · 4 layers · cut-ready" },
      { task: "ebook cover variants",            ticker: "covers: 4 variants · 1200×1800 png" },
      { task: "color story refresh",             ticker: "palette: cream/sage/terracotta locked" },
    ],
    handoffTo: "listing",
    handoffLabel: () => "asset bundle",
    broadcasts: ["orchestrator"],
  },
  listing: {
    workMin: 4500, workMax: 7000,
    betweenMin: 200, betweenMax: 600,
    phases: [
      { task: "draft SEO listing · title + 13 tags", ticker: "title 132ch · 13 tags · density 2.1" },
      { task: "translate description (ES, FR)",       ticker: "i18n · ES + FR description ready" },
      { task: "rewrite materials for Etsy policy",    ticker: "materials: digital · instant download" },
      { task: "alt text for every mockup",            ticker: "alt-text: 4/4 written · WCAG AA" },
    ],
    handoffTo: "publisher",
    handoffLabel: () => "listing draft",
    broadcasts: ["si"],
  },
  publisher: {
    workMin: 3500, workMax: 6000,
    betweenMin: 200, betweenMax: 500,
    phases: [
      { task: "upload to Etsy · attach files",  ticker: "publishing → Etsy · listing #4821 LIVE" },
      { task: "refresh featured listing",        ticker: "renewed listing #4773 · slot up 1h" },
      { task: "sync inventory · mark in stock",  ticker: "inventory: 12 listings synced" },
      { task: "OAuth keepalive",                 ticker: "etsy oauth · token refreshed" },
    ],
    handoffTo: "cs",
    handoffLabel: () => `listing #${4800 + Math.floor(Math.random() * 60)}`,
    broadcasts: ["cfo"],
  },
  cs: {
    workMin: 5000, workMax: 8000,
    betweenMin: 200, betweenMax: 600,
    phases: [
      { task: "answer buyer · file format question", ticker: "msg #221 → answered (PDF + SVG)" },
      { task: "review dispute · refund request",     ticker: "dispute #14 → flagged to orchestrator" },
      { task: "thank-you note + review nudge",        ticker: "nudge sent · order #882" },
      { task: "policy reminder · custom request",     ticker: "msg: custom work declined per policy" },
    ],
    handoffTo: "cfo",
    handoffLabel: () => "outcomes batch",
    broadcasts: ["orchestrator"],
  },
  cfo: {
    workMin: 4000, workMax: 6500,
    betweenMin: 250, betweenMax: 700,
    phases: [
      { task: "reconcile payouts + fees",        ticker: "+$8.50 payout · -$0.18 tokens" },
      { task: "set tomorrow's daily cap",        ticker: "cap: $10/day · designer slice 40%" },
      { task: "tax bucket · 30% set aside",      ticker: "tax: $54.72 set aside (Q2)" },
      { task: "veto expensive Sonnet promotion", ticker: "veto: SI batch swap to Haiku" },
    ],
    handoffTo: "si",
    handoffLabel: () => "ledger",
    broadcasts: ["orchestrator"],
  },
  si: {
    workMin: 6000, workMax: 9500,
    betweenMin: 250, betweenMax: 700,
    phases: [
      { task: "score 7-day outcomes",                ticker: "memory: titles w/ color word convert +18%" },
      { task: "propose A/B variant · keyword density", ticker: "experiment #7 · 4 variants · 7d window" },
      { task: "draft patch · Listing Copywriter",     ticker: "patch proposal: shorter titles (gate pending)" },
      { task: "backtest replay · last 20 jobs",       ticker: "replay: 19/20 pass · 1 regression flagged" },
    ],
    handoffTo: "research",
    handoffLabel: () => "next-niche hint",
    broadcasts: ["listing", "designer"],
  },
};

const HANDOFF_MS = 1700;
const PATROL_MS  = 900;
const BROADCAST_MS = 1300;

export function useFoundingLoops(
  enabled: boolean,
  cancelledRef: { current: boolean },
): void {
  useEffect(() => {
    if (!enabled) return;

    const store = useFactoryStore;
    const counters: Record<string, number> = {};

    function fireHandoff(
      fromRoleId: string,
      toRoleId: string,
      label: string,
      durationMs: number,
      tag: string,
    ) {
      const from = ROLES[fromRoleId];
      const to = ROLES[toRoleId];
      if (!from || !to) return;
      store.getState().pushHandoff({
        id: `${tag}-${fromRoleId}-${counters[fromRoleId] ?? 0}-${Date.now()}-${Math.random().toFixed(3)}`,
        fromRoom: from.room,
        toRoom: to.room,
        color: from.hex,
        label,
        startedAt: Date.now(),
        durationMs,
      });
    }

    async function runRoleLoop(roleId: string, kickoffDelay: number) {
      await sleep(kickoffDelay);
      const loop = LOOPS[roleId];
      if (!loop) return;

      // Stay in working state across phases. Animations + room glow stay on.
      store.getState().setAgentState(roleId, "working");

      while (!cancelledRef.current) {
        const phase = loop.phases[(counters[roleId] ?? 0) % loop.phases.length];
        counters[roleId] = (counters[roleId] ?? 0) + 1;
        const workMs = rand(loop.workMin, loop.workMax);

        const s = store.getState();
        s.setAgentState(roleId, "working");
        s.setAgentTask(roleId, phase.task);
        s.setAgentJob(roleId, 1000 + counters[roleId]);
        // Suppress mock ticker when a real pipeline event fired recently (last 30s).
        const lastReal = s.realActivityAt[roleId] ?? 0;
        if (Date.now() - lastReal > 30_000) {
          s.pushTicker({ ts: Date.now(), source: roleId, text: phase.ticker });
        }

        // Patrol darts (boss only) — staggered while working
        if (loop.patrol && loop.patrol.length) {
          const stagger = Math.max(180, Math.floor(workMs / loop.patrol.length / 1.1));
          loop.patrol.forEach((sub, i) => {
            setTimeout(() => {
              if (!cancelledRef.current) fireHandoff(roleId, sub, "directive", PATROL_MS, "patrol");
            }, i * stagger);
          });
        }

        // Mid-phase broadcast — randomly fires one cross-team doc-sprite
        // somewhere between 30% and 70% through the work phase.
        if (loop.broadcasts && loop.broadcasts.length) {
          const target = pickOne(loop.broadcasts);
          const offset = workMs * (0.3 + Math.random() * 0.4);
          setTimeout(() => {
            if (!cancelledRef.current) {
              fireHandoff(roleId, target, "data ping", BROADCAST_MS, "bcast");
            }
          }, offset);
        }

        await sleep(workMs);
        if (cancelledRef.current) return;

        // Bump simulated business counters to drive hire-signal thresholds.
        if (roleId === "research")     SIM.nichesQueued += 1;
        if (roleId === "designer")     SIM.designerQueue = Math.max(0, SIM.designerQueue - 1);
        if (roleId === "orchestrator") SIM.designerQueue += Math.random() < 0.7 ? 1 : 0;
        if (roleId === "cs")           SIM.openDisputes += Math.random() < 0.15 ? 1 : 0;
        if (roleId === "publisher")    SIM.intlOrdersPending += Math.random() < 0.25 ? 1 : 0;
        SIM.dayInQuarter = Math.min(90, SIM.dayInQuarter + 0.2);

        // End-of-phase: fire the chain handoff but DO NOT go idle —
        // every agent rolls straight into their next phase.
        if (loop.handoffTo) {
          const label = loop.handoffLabel();
          fireHandoff(roleId, loop.handoffTo, label, HANDOFF_MS, "flow");
          const toRole = ROLES[loop.handoffTo];
          if (toRole) {
            store.getState().pushTicker({
              ts: Date.now(),
              source: roleId,
              text: `→ ${toRole.name}: ${label}`,
            });
          }
        }

        // Award demo revenue for the completed phase — skip when the real pipeline
        // fired recently to avoid double-counting with CFO's actual net_usd.
        const earnerRole = ROLES[roleId];
        if (earnerRole) {
          const recentReal =
            Date.now() - (store.getState().realActivityAt[roleId] ?? 0) < 30_000;
          if (!recentReal) {
            const usd = REVENUE_PER_PHASE[earnerRole.name] ?? 0.05;
            store.getState().addRevenue(roleId, usd);
          }
        }

        // Brief micro-pause — kept very short so visually the agent never
        // looks "idle waiting on someone else".
        await sleep(rand(loop.betweenMin, loop.betweenMax));
      }
    }

    // Stagger kickoffs so loops don't fire in lockstep at start
    const kickoffs: Array<[string, number]> = [
      ["orchestrator", 0],
      ["research", 100],
      ["designer", 250],
      ["cs", 400],
      ["listing", 550],
      ["publisher", 700],
      ["cfo", 900],
      ["si", 1100],
    ];
    for (const [roleId, delay] of kickoffs) {
      runRoleLoop(roleId, delay);
    }
  }, [enabled]);
}
