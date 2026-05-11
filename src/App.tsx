import { useEffect, useState } from "react";
import SvgFactoryFloor from "./factory/svg/SvgFactoryFloor";
import TopBar from "./factory/ui/TopBar";
import Ticker from "./factory/ui/Ticker";
import SideDrawer from "./factory/ui/SideDrawer";
import AlertTray from "./factory/ui/AlertTray";
import GateModal from "./factory/ui/GateModal";
import OnboardingWizard from "./factory/ui/OnboardingWizard";
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
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  // Open onboarding on cold start if no Anthropic key set
  useEffect(() => {
    api.getSecret("anthropic_api_key").then((v) => {
      if (!v) setWizardOpen(true);
    });
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
      <TopBar onAlertClick={() => setAlertTrayOpen((v) => !v)} />
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
    </div>
  );
}
