import { useEffect, useState } from "react";
import SvgFactoryFloor from "./factory/svg/SvgFactoryFloor";
import TopBar from "./factory/ui/TopBar";
import Ticker from "./factory/ui/Ticker";
import SideDrawer from "./factory/ui/SideDrawer";
import AlertTray from "./factory/ui/AlertTray";
import GateModal from "./factory/ui/GateModal";
import OnboardingWizard from "./factory/ui/OnboardingWizard";
import SettingsModal from "./factory/ui/SettingsModal";
import CommandRail from "./factory/ui/CommandRail";
import { useSupervisorEventsToStore } from "./hooks/useSupervisorEvents";
import { useDemoFloor } from "./hooks/useDemoFloor";
import { useFactoryStore } from "./factory/state/factoryStore";
import { api } from "./api";
import "./factory/ui/factory-floor.css";
import "./App.css";

const RAIL_STORAGE_KEY = "agentFactory.rail.collapsed";

export default function App() {
  useSupervisorEventsToStore();
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

  // Open onboarding on cold start if no Anthropic credentials at all —
  // either a direct key OR a complete bridge pair (url + key).
  useEffect(() => {
    (async () => {
      const [direct, bridgeUrl, bridgeKey] = await Promise.all([
        api.getSecret("anthropic_api_key").catch(() => null),
        api.getSecret("anthropic_bridge_url").catch(() => null),
        api.getSecret("anthropic_bridge_key").catch(() => null),
      ]);
      const hasDirect = !!direct && direct.length > 0;
      const hasBridge = !!bridgeUrl && bridgeUrl.length > 0 && !!bridgeKey && bridgeKey.length > 0;
      if (!hasDirect && !hasBridge) setWizardOpen(true);
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
      <CommandRail collapsed={railCollapsed} onToggle={handleRailToggle} />
      <TopBar
        onAlertClick={() => setAlertTrayOpen((v) => !v)}
        onSettingsClick={() => setSettingsOpen(true)}
      />
      <div className="floor-wrap" style={{ position: "relative", overflow: "hidden", minHeight: 0 }}>
        {sandbox && (
          <div className="sandbox-banner" role="status" aria-label="Sandbox mode">
            <span className="sandbox-banner-rule" />
            <span>Sandbox mode — synthetic floor activity, no live publishing</span>
            <span className="sandbox-banner-rule" />
          </div>
        )}
        <SvgFactoryFloor />
      </div>
      <Ticker />
      <SideDrawer />
      <AlertTray open={alertTrayOpen} onClose={() => setAlertTrayOpen(false)} />
      <GateModal />
      <OnboardingWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
