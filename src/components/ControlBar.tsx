import { useEffect, useState } from "react";
import { api, StatusReport } from "../api";

export default function ControlBar() {
  const [status, setStatus] = useState<StatusReport | null>(null);

  const refresh = async () => setStatus(await api.status());

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, []);

  const start = async () => { await api.start(); await refresh(); };
  const stop = async () => { await api.stop(); await refresh(); };
  const sendTest = async () => {
    await api.enqueue("hello", { msg: "world" });
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 16px",
      background: "#1a1f26",
      borderBottom: "1px solid #2a3038",
    }}>
      <strong>agent-factory</strong>
      <span style={{ color: status?.running ? "#7fd47b" : "#9aa0a8" }}>
        {status?.running ? "● running" : "○ stopped"}
      </span>
      <span style={{ color: "#9aa0a8" }}>project #{status?.project_id ?? "—"}</span>
      <div style={{ flex: 1 }} />
      {!status?.running ? (
        <button onClick={start}>Start</button>
      ) : (
        <button onClick={stop}>Stop</button>
      )}
      <button onClick={sendTest} disabled={!status?.running}>Send test job</button>
    </div>
  );
}
