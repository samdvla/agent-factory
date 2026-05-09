import { useState } from "react";
import ControlBar from "./components/ControlBar";
import SettingsPanel from "./components/SettingsPanel";
import LogsView from "./components/LogsView";
import "./App.css";
import "./factory/ui/factory-floor.css";

export default function App() {
  const [tab, setTab] = useState<"logs" | "settings">("logs");

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      color: "#e6e6e6",
      background: "#0d0f12",
    }}>
      <ControlBar />
      <div style={{ display: "flex", gap: 4, padding: "8px 16px", background: "#15181d" }}>
        <button onClick={() => setTab("logs")}
                style={tabStyle(tab === "logs")}>Logs</button>
        <button onClick={() => setTab("settings")}
                style={tabStyle(tab === "settings")}>Settings</button>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "logs" ? <LogsView /> : <SettingsPanel />}
      </div>
    </div>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: active ? "#2a3038" : "transparent",
    color: active ? "#fff" : "#9aa0a8",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
  };
}
