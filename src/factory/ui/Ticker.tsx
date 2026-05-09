import { useFactoryStore } from "../state/factoryStore";
import { ROLES } from "../state/fixtures";

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

export default function Ticker() {
  const ticker = useFactoryStore((s) => s.ticker);
  const selectAgent = useFactoryStore((s) => s.selectAgent);

  // Duplicate items for seamless scroll loop (CSS animation runs -50% translateX)
  const items = ticker.length > 0 ? ticker : null;

  return (
    <footer className="ticker" id="ticker">
      <div className="ticker-label">
        <span className="pulse" />
        Live · Floor
      </div>

      <div className="ticker-track">
        <div className="ticker-content" id="tickerRow">
          {items === null ? (
            /* Empty state — rendered twice for loop symmetry */
            <>
              <span className="ticker-line" style={{ opacity: 0.5, cursor: "default" }}>
                <span className="msg">no events yet</span>
              </span>
              <span className="ticker-line" style={{ opacity: 0.5, cursor: "default" }}>
                <span className="msg">no events yet</span>
              </span>
            </>
          ) : (
            /* Two passes so the scroll animation loops seamlessly */
            [0, 1].map((pass) =>
              items.map((entry, i) => {
                const role = ROLES[entry.source];
                const hex = role?.hex ?? "var(--ink-2)";
                return (
                  <span
                    key={`${pass}-${i}`}
                    className="ticker-line"
                    onClick={() => role && selectAgent(role.id)}
                    style={{ cursor: role ? "pointer" : "default" }}
                  >
                    <span className="ts">{timeAgo(entry.ts)}</span>
                    <span
                      className="sw"
                      style={{
                        display: "inline-block",
                        width: 7,
                        height: 7,
                        borderRadius: 1.5,
                        background: hex,
                        flexShrink: 0,
                      }}
                    />
                    <span className="role" style={{ color: hex }}>
                      {role?.name ?? entry.source}
                    </span>
                    <span className="sep">·</span>
                    <span className="msg">{entry.text}</span>
                  </span>
                );
              })
            )
          )}
        </div>
      </div>
    </footer>
  );
}
