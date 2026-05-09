import { useEffect, useState } from "react";
import ThreeFactoryFloor from "./factory/three/ThreeFactoryFloor";
import TopBar from "./factory/ui/TopBar";
import Ticker from "./factory/ui/Ticker";
import SideDrawer from "./factory/ui/SideDrawer";
import AlertTray from "./factory/ui/AlertTray";
import GateModal from "./factory/ui/GateModal";
import OnboardingWizard from "./factory/ui/OnboardingWizard";
import { useSupervisorEventsToStore } from "./hooks/useSupervisorEvents";
import { api } from "./api";
import "./factory/ui/factory-floor.css";
import "./App.css";

export default function App() {
  useSupervisorEventsToStore();
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
        <ThreeFactoryFloor />
      </div>
      <Ticker />
      <SideDrawer />
      <AlertTray open={alertTrayOpen} onClose={() => setAlertTrayOpen(false)} />
      <GateModal />
      <OnboardingWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  );
}
