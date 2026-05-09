interface Props {
  agentId: string;
}

export default function ControlsRow({ agentId }: Props) {
  return (
    <div className="drawer-section">
      <div className="drawer-section-head">Controls</div>
      <div className="controls-grid">
        <button className="ctl-btn" disabled>
          <span className="ctl-glyph">⏸</span> Pause
        </button>
        <button className="ctl-btn primary" disabled>
          <span className="ctl-glyph">▶</span> Resume
        </button>
        <button className="ctl-btn kill" disabled>
          <span className="ctl-glyph">✕</span> Kill
        </button>
        <button className="ctl-btn" disabled>
          <span className="ctl-glyph">↺</span> Restart
        </button>
      </div>
      <div
        className="empty-state"
        style={{ padding: "0 20px 16px", fontSize: 11 }}
      >
        Per-agent controls for <strong>{agentId}</strong> require new Tauri
        commands (P1.1 follow-up).
      </div>
    </div>
  );
}
