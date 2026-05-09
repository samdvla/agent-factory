import { useEffect } from "react";
import { useFactoryStore } from "../factory/state/factoryStore";
import { ROLES } from "../factory/state/fixtures";
import { planRoomToRoomPath } from "../factory/svg/pathing";
import { homeStationFor } from "../factory/svg/stations";

type Phase = { task: string; ticker: string };

type RoleLoop = {
  workMin: number;
  workMax: number;
  // Tiny pause between phases so the avatar can rotate stations and the
  // FX animations get to "reset". Stays in working state by default.
  betweenMin: number;
  betweenMax: number;
  phases: Phase[];
  // Primary handoff fired at end of phase
  handoffTo?: string;
  handoffLabel: () => string;
  // Mid-phase broadcast handoffs for cross-team chatter
  broadcasts?: string[];
  // Orchestrator-style: while working, fire short directive sprites
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

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function useDemoFloor(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
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

      while (!cancelled) {
        const phase = loop.phases[(counters[roleId] ?? 0) % loop.phases.length];
        counters[roleId] = (counters[roleId] ?? 0) + 1;
        const workMs = rand(loop.workMin, loop.workMax);

        const s = store.getState();
        s.setAgentState(roleId, "working");
        s.setAgentTask(roleId, phase.task);
        s.setAgentJob(roleId, 1000 + counters[roleId]);
        s.pushTicker({ ts: Date.now(), source: roleId, text: phase.ticker });

        // Patrol darts (boss only) — staggered while working
        if (loop.patrol && loop.patrol.length) {
          const stagger = Math.max(180, Math.floor(workMs / loop.patrol.length / 1.1));
          loop.patrol.forEach((sub, i) => {
            setTimeout(() => {
              if (!cancelled) fireHandoff(roleId, sub, "directive", PATROL_MS, "patrol");
            }, i * stagger);
          });
        }

        // Mid-phase broadcast — randomly fires one cross-team doc-sprite
        // somewhere between 30% and 70% through the work phase.
        if (loop.broadcasts && loop.broadcasts.length) {
          const target = pickOne(loop.broadcasts);
          const offset = workMs * (0.3 + Math.random() * 0.4);
          setTimeout(() => {
            if (!cancelled) {
              fireHandoff(roleId, target, "data ping", BROADCAST_MS, "bcast");
            }
          }, offset);
        }

        await sleep(workMs);
        if (cancelled) return;

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

        // Brief micro-pause — kept very short so visually the agent never
        // looks "idle waiting on someone else".
        await sleep(rand(loop.betweenMin, loop.betweenMax));
      }
    }

    // Orchestrator periodically physically walks through the corridors to
    // a subordinate's room, hangs out a few seconds, then walks home.
    async function orchestratorSiteVisits() {
      await sleep(18000);
      const targets = ["research", "designer", "listing", "cs", "cfo", "si"];
      const orchestratorRole = ROLES["orchestrator"];
      if (!orchestratorRole) return;

      const SEGMENT_MS = 700;

      while (!cancelled) {
        const pick = pickOne(targets);
        const subRole = ROLES[pick];
        if (!subRole) {
          await sleep(20000);
          continue;
        }

        // Outbound path: strategy.home → subRole.room.station 0
        const outbound = planRoomToRoomPath(
          orchestratorRole.room,
          homeStationFor("orchestrator", orchestratorRole.room),
          subRole.room,
          0,
        );
        if (outbound.length >= 2) {
          const totalOutboundMs = (outbound.length - 1) * SEGMENT_MS;
          store.getState().setAgentTravel("orchestrator", {
            roomId: subRole.room,
            stationIdx: 0,
            waypoints: outbound,
            startedAt: Date.now(),
            durationPerSegmentMs: SEGMENT_MS,
          });
          store.getState().pushTicker({
            ts: Date.now(),
            source: "orchestrator",
            text: `walking to ${subRole.name} via corridor`,
          });
          await sleep(totalOutboundMs);
          if (cancelled) return;
        }

        // Spend time at the visited room
        await sleep(4500 + Math.random() * 3500);
        if (cancelled) return;

        // Return path: subRole.room → strategy.home
        const returnPath = planRoomToRoomPath(
          subRole.room,
          0,
          orchestratorRole.room,
          homeStationFor("orchestrator", orchestratorRole.room),
        );
        if (returnPath.length >= 2) {
          const totalReturnMs = (returnPath.length - 1) * SEGMENT_MS;
          store.getState().setAgentTravel("orchestrator", {
            roomId: orchestratorRole.room,
            stationIdx: homeStationFor("orchestrator", orchestratorRole.room),
            waypoints: returnPath,
            startedAt: Date.now(),
            durationPerSegmentMs: SEGMENT_MS,
          });
          store.getState().pushTicker({
            ts: Date.now(),
            source: "orchestrator",
            text: `walking back to strategy room`,
          });
          await sleep(totalReturnMs);
          if (cancelled) return;
        }

        // Clear travel so the agent reverts to its normal station rotation
        store.getState().setAgentTravel("orchestrator", null);

        await sleep(22000 + Math.random() * 22000);
      }
    }

    // Stagger kickoffs so loops don't fire in lockstep at start
    const kickoffs: Array<[string, number]> = [
      ["research", 200],
      ["orchestrator", 1100],
      ["designer", 600],
      ["listing", 1500],
      ["publisher", 2400],
      ["cs", 800],
      ["cfo", 3200],
      ["si", 1800],
    ];
    for (const [roleId, delay] of kickoffs) {
      runRoleLoop(roleId, delay);
    }
    orchestratorSiteVisits();

    return () => {
      cancelled = true;
      store.getState().setAgentTravel("orchestrator", null);
    };
  }, [enabled]);
}
