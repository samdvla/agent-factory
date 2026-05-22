import { Profiler, useEffect, useState } from "react";
import { profilerCallback } from "./factory/perf/collector";
import SvgFactoryFloor from "./factory/svg/SvgFactoryFloor";
import TopBar from "./factory/ui/TopBar";
import Ticker from "./factory/ui/Ticker";
import SideDrawer from "./factory/ui/SideDrawer";
import AlertTray from "./factory/ui/AlertTray";
import GateModal from "./factory/ui/GateModal";
import OnboardingWizard from "./factory/ui/OnboardingWizard";
import SettingsModal from "./factory/ui/SettingsModal";
import CommandRail from "./factory/ui/CommandRail";
import PipelinePanel from "./factory/ui/PipelinePanel";
import PerfDiag from "./factory/ui/PerfDiag";
import { useSupervisorEventsToStore } from "./hooks/useSupervisorEvents";
import { usePrintifyOperatorBoot } from "./hooks/usePrintifyOperator";
import { useDemoFloor } from "./hooks/useDemoFloor";
import { useFactoryStore } from "./factory/state/factoryStore";
import { mapAppThemeToIso } from "./factory/svg/iso/themes";
import { api } from "./api";
import { installWindowGlobals as installRemoteGlobals } from "./remote";
import "./factory/ui/factory-floor.css";
import "./App.css";

// Expose remote-mode helpers (window.__af_remote.*) for devtools wiring
// before a Settings UI lands. Side-effect-only; safe in laptop mode where
// no localStorage config means every call returns null / throws.
installRemoteGlobals();

const RAIL_STORAGE_KEY = "agentFactory.rail.collapsed";

export default function App() {
  useSupervisorEventsToStore();
  usePrintifyOperatorBoot();
  const sandbox = useFactoryStore((s) => s.sandbox);
  useDemoFloor(sandbox);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  // Sync the current sandbox mode to backend secrets once on mount so the
  // supervisor safety check always has the correct ui_sandbox_mode value at
  // startup, even before the user toggles the mode toggle.
  useEffect(() => {
    api.setSecret("ui_sandbox_mode", String(sandbox)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cold-start hydration: seed budget/revenue/per-agent counters AND
  // lifetime-derived wealth/rewards from the DB so a mid-day restart doesn't
  // reset everything to zero. Without this the in-memory zustand store
  // only accumulates from live events, losing morning activity (budget,
  // revenue, per-agent counters) and lifetime context (avatar stars,
  // dissolve-ticker amounts).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Today's totals — single round-trip for budget/revenue/per-agent.
      try {
        const stats = await api.todayStats();
        if (cancelled) return;
        const store = useFactoryStore.getState();
        store.setBudget(stats.budget_today_usd);
        store.setRevenueToday(stats.revenue_today_usd);
        // Lifetime Net pill subscribes to these — they roll up every
        // dollar burned (LLM, Tripo, Meshy, Gemini, Etsy fees) and
        // every dollar earned across every marketplace (revenue_ledger).
        store.setLifetimeTotals(stats.revenue_lifetime_usd, stats.budget_lifetime_usd);
        store.hydratePerAgentTodayStats(stats.per_agent);
      } catch {
        // Swallow — counters fall back to live-event accumulation.
      }
      // Lifetime wealth + avatar stars. listWealth already exists for the
      // WealthLeaderboard, but the leaderboard only loads when its panel is
      // open. Without this hydration the avatar stars are blank until the
      // first sale lands in this session.
      try {
        const rows = await api.listWealth();
        if (cancelled) return;
        const store = useFactoryStore.getState();
        const wealthMap: Record<string, typeof rows[number]> = {};
        let totalLifetimeRevenue = 0;
        for (const r of rows) {
          wealthMap[r.role] = r;
          totalLifetimeRevenue += r.lifetime_revenue_usd ?? 0;
        }
        store.setWealthByRole(wealthMap);
        // revenueByRole is currently incremented under the "publisher" key
        // (eventReducer attributes whole receipts there). Seed it with the
        // sum so the dissolve ticker reflects real lifetime earnings.
        store.setRevenueByRole({ publisher: totalLifetimeRevenue });
        // Backfill avatar stars ONLY if localStorage is empty (i.e. this is
        // the first restart since the persistence fix landed). After that,
        // localStorage is the source of truth and live awardProgress events
        // keep it in sync.
        const currentRewards = useFactoryStore.getState().rewardsByRole;
        if (Object.keys(currentRewards).length === 0 && totalLifetimeRevenue > 0) {
          // Each receipt awards rev/4 of progress to each pipeline role
          // (publisher / designer / listing / research). Feed the average
          // lifetime share through the same star formula to derive a
          // floor — under-counts operator-rating progress, over-counts
          // nothing.
          const sharePerRole = totalLifetimeRevenue / 4;
          const TIER_STAR_USD = [1, 5, 25, 100, 500];
          const derive = (totalProgress: number) => {
            let progress = totalProgress;
            let stars = 0;
            let tier = 0;
            while (progress > 0 && tier <= 4) {
              if (stars >= 10) {
                if (tier >= 4) {
                  progress = 0;
                  break;
                }
                tier += 1;
                stars = 0;
                continue;
              }
              if (progress >= TIER_STAR_USD[tier]) {
                progress -= TIER_STAR_USD[tier];
                stars += 1;
              } else {
                break;
              }
            }
            return { stars, tier, progressUsd: progress };
          };
          const backfilled: Record<string, { stars: number; tier: number; progressUsd: number }> = {};
          for (const role of ["publisher", "designer", "listing", "research"]) {
            backfilled[role] = derive(sharePerRole);
          }
          store.setRewardsByRole(backfilled);
        }
      } catch {
        // Swallow — wealth panel and avatars fall back to empty state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive the initial iso room theme from whatever app theme is active. The
  // SettingsModal updates both in lockstep when the user picks a new theme;
  // this catches the cold-start case where only the app theme is in DOM.
  useEffect(() => {
    const currentApp = document.documentElement.dataset.theme || "claude";
    useFactoryStore.getState().setIsoTheme(mapAppThemeToIso(currentApp));
  }, []);

  // Open onboarding on cold start if no Anthropic credentials at all —
  // either a direct key OR a complete bridge pair (url + key).
  useEffect(() => {
    // `?demo=1` bypasses the wizard for screenshots / preview embeds where
    // the secret-store backend isn't reachable.
    if (typeof window !== "undefined" && window.location.search.includes("demo=1")) {
      setWizardOpen(false);
      return;
    }
    (async () => {
      const [direct, bridgeUrl, bridgeKey] = await Promise.all([
        api.getSecret("anthropic_api_key").catch(() => null),
        api.getSecret("anthropic_bridge_url").catch(() => null),
        api.getSecret("anthropic_bridge_key").catch(() => null),
      ]);
      const hasDirect = !!direct && direct.length > 0;
      const hasBridge = !!bridgeUrl && bridgeUrl.length > 0 && !!bridgeKey && bridgeKey.length > 0;
      setWizardOpen(!hasDirect && !hasBridge);
    })();
  }, []);

  const handleRailToggle = (collapsed: boolean) => {
    setRailCollapsed(collapsed);
    try {
      localStorage.setItem(RAIL_STORAGE_KEY, String(collapsed));
    } catch {}
  };

  return (
    <div className={`app${railCollapsed ? " rail-collapsed" : ""}${sandbox ? " has-sandbox" : ""}`}>
      <PerfDiag />
      <Profiler id="rail" onRender={profilerCallback}>
        <CommandRail collapsed={railCollapsed} onToggle={handleRailToggle} />
      </Profiler>
      <div className="floor-wrap" style={{ position: "relative", overflow: "hidden", minHeight: 0 }}>
        {sandbox && (
          <div className="sandbox-banner" role="status" aria-label="Sandbox mode">
            <span className="sandbox-banner-rule" />
            <span>Sandbox mode — synthetic floor activity, no live publishing</span>
            <span className="sandbox-banner-rule" />
          </div>
        )}
        <SvgFactoryFloor />
        <Profiler id="topbar" onRender={profilerCallback}>
          <TopBar
            onAlertClick={() => setAlertTrayOpen((v) => !v)}
            onSettingsClick={() => setSettingsOpen(true)}
          />
        </Profiler>
        <Profiler id="rightrail" onRender={profilerCallback}>
          <div className="right-rail">
            <PipelinePanel />
            <SideDrawer />
          </div>
        </Profiler>
      </div>
      <Profiler id="ticker" onRender={profilerCallback}>
        <Ticker />
      </Profiler>
      <AlertTray open={alertTrayOpen} onClose={() => setAlertTrayOpen(false)} />
      <GateModal />
      <OnboardingWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
