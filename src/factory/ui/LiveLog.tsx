import { useFactoryStore } from "../state/factoryStore";
import { SUPERVISOR_ROLE_MAP } from "../state/fixtures";
import type { TickerEntry } from "../state/types";

interface Props {
  agentId: string;
}

type GroupedLine = TickerEntry & { count: number; firstTs: number };

/**
 * Collapse consecutive identical (source, text) ticker entries into one row
 * with a count badge. Two pushes within DEDUPE_WINDOW_MS are treated as the
 * same event firing twice (which happens when the supervisor fans out a
 * notification to multiple subscribers).
 */
const DEDUPE_WINDOW_MS = 60_000;

function collapseRuns(lines: TickerEntry[]): GroupedLine[] {
  const out: GroupedLine[] = [];
  for (const t of lines) {
    const last = out[out.length - 1];
    if (
      last &&
      last.source === t.source &&
      last.text === t.text &&
      t.ts - last.ts < DEDUPE_WINDOW_MS
    ) {
      last.count += 1;
      last.ts = t.ts;
    } else {
      out.push({ ...t, count: 1, firstTs: t.ts });
    }
  }
  return out;
}

function classifyTone(text: string): "info" | "ok" | "warn" | "err" | "handoff" {
  const t = text.toLowerCase();
  if (/^→ |handoff/.test(t)) return "handoff";
  if (/\b(failed|error|crashed|rejected|denied)\b/.test(t)) return "err";
  if (/\b(warn|exited|restart)\b/.test(t)) return "warn";
  if (/\b(completed|done|success|published|approved|online|finished)\b/.test(t)) return "ok";
  return "info";
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function LiveLog({ agentId }: Props) {
  const ticker = useFactoryStore((s) => s.ticker);
  const role = useFactoryStore((s) => s.roles[agentId]);

  const supervisorSources = Object.entries(SUPERVISOR_ROLE_MAP)
    .filter(([, v]) => v === agentId)
    .map(([k]) => k);

  const raw = ticker.filter(
    (t) => t.source === agentId || supervisorSources.includes(t.source)
  );
  const lines = collapseRuns(raw);
  const roleLabel = (role?.title ?? agentId).toUpperCase();

  return (
    <div className="drawer-section" style={{ flex: 1 }}>
      <div className="drawer-section-head">
        <span>Live Log</span>
        {lines.length > 0 && <span className="count">{lines.length}</span>}
      </div>
      <div className="log-list">
        {lines.length === 0 ? (
          <div className="empty-state" style={{ padding: "14px 20px" }}>
            no events yet — the log fills in as the supervisor reports activity
          </div>
        ) : (
          lines.map((t, i) => (
            <div
              key={`${t.firstTs}-${i}`}
              className="log-line"
              data-tone={classifyTone(t.text)}
            >
              <span className="log-line-dot" />
              <div className="log-line-body">
                <div className="log-line-meta">
                  <span className="log-line-ts">{fmtTime(t.ts)}</span>
                  <span className="log-line-tag">{roleLabel}</span>
                  {t.count > 1 && (
                    <span
                      className="log-line-count"
                      title={`${t.count} identical events collapsed`}
                    >
                      ×{t.count}
                    </span>
                  )}
                </div>
                <div className="log-line-msg">{t.text}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
