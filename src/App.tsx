import { useEffect, useState } from "react";
import SvgFactoryFloor from "./factory/svg/SvgFactoryFloor";
import TopBar from "./factory/ui/TopBar";
import Ticker from "./factory/ui/Ticker";
import SideDrawer from "./factory/ui/SideDrawer";
import AlertTray from "./factory/ui/AlertTray";
import GateModal from "./factory/ui/GateModal";
import OnboardingWizard from "./factory/ui/OnboardingWizard";
import { useSupervisorEventsToStore } from "./hooks/useSupervisorEvents";
import { useDemoFloor } from "./hooks/useDemoFloor";
import { useFactoryStore } from "./factory/state/factoryStore";
import { api } from "./api";
import "./factory/ui/factory-floor.css";
import "./App.css";

export default function App() {
  useSupervisorEventsToStore();
  const sandbox = useFactoryStore((s) => s.sandbox);
  useDemoFloor(sandbox);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);

  // Open onboarding on cold start if no Anthropic key set
  useEffect(() => {
    api.getSecret("anthropic_api_key").then((v) => {
      if (!v) setWizardOpen(true);
    });
  }, []);

  return (
    <div className="app">
      <TopBar onAlertClick={() => setAlertTrayOpen((v) => !v)} />
      <div style={{ position: "relative", overflow: "hidden", minHeight: 0 }}>
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
