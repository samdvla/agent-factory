import { useSupervisorEvents } from "../hooks/useSupervisorEvents";

export default function LogsView() {
  const events = useSupervisorEvents(1000);

  return (
    <div style={{
      padding: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
    }}>
      {events.length === 0 && (
        <div style={{ color: "#9aa0a8" }}>
          No events yet. Click <em>Start</em> in the bar above, then <em>Send test job</em>.
        </div>
      )}
      {events.map(({ ts, evt }, i) => (
        <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
          <span style={{ color: "#9aa0a8" }}>{new Date(ts).toLocaleTimeString()}</span>
          <span style={{ color: "#7fa3d4" }}>{evt.kind}</span>
          <span style={{ color: "#cfd3da", whiteSpace: "pre-wrap" }}>
            {JSON.stringify(evt, null, 0)}
          </span>
        </div>
      ))}
    </div>
  );
}
