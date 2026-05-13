import { useEffect, useState } from "react";
import { useFactoryStore } from "../state/factoryStore";
import { SUPERVISOR_ROLE_MAP } from "../state/fixtures";

interface Props {
  agentId: string;
}

const JOB_RX = /\bjob\s*#?(\d+)\b/i;
const COMPLETED_RX = /\b(completed|finished|done|success|published|approved)\b/i;
const FAILED_RX = /\b(failed|error|rejected|crashed|denied)\b/i;
const STARTED_RX = /\b(started|claimed|begin)\b/i;

type RecentJob = {
  id: number;
  status: "ok" | "fail" | "started";
  ts: number;
};

function fmtElapsed(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function fmtElapsedRunning(ms: number): string {
  if (ms < 1000) return "just started";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `running ${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `running ${m}m ${rem}s`;
}

export default function QueuePanel({ agentId }: Props) {
  const agent = useFactoryStore((s) => s.agents[agentId]);
  const ticker = useFactoryStore((s) => s.ticker);

  // Re-render every second so "elapsed" stays live while the drawer is open.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!agent) {
    return (
      <div className="drawer-section">
        <div className="drawer-section-head">Queue</div>
        <div className="empty-state" style={{ padding: "14px 20px" }}>
          unknown agent
        </div>
      </div>
    );
  }

  // Supervisor-side source keys may differ from role id (e.g. "etsy_publisher"
  // → "publisher"), so include any source that maps to this agent.
  const supervisorSources = Object.entries(SUPERVISOR_ROLE_MAP)
    .filter(([, v]) => v === agentId)
    .map(([k]) => k);
  const stream = ticker.filter(
    (t) => t.source === agentId || supervisorSources.includes(t.source)
  );

  // Mine the ticker for recent jobs this agent touched.
  const seen = new Set<number>();
  const recent: RecentJob[] = [];
  for (let i = stream.length - 1; i >= 0 && recent.length < 8; i--) {
    const t = stream[i];
    const m = t.text.match(JOB_RX);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    if (seen.has(id) || id === agent.currentJobId) continue;
    seen.add(id);
    const status: RecentJob["status"] = FAILED_RX.test(t.text)
      ? "fail"
      : COMPLETED_RX.test(t.text)
        ? "ok"
        : "started";
    recent.push({ id, status, ts: t.ts });
  }

  // When did the current job start? Walk backward for the last "started"
  // mention of currentJobId.
  let currentStartedAt: number | null = null;
  if (agent.currentJobId != null) {
    for (let i = stream.length - 1; i >= 0; i--) {
      const t = stream[i];
      const m = t.text.match(JOB_RX);
      if (!m) continue;
      if (parseInt(m[1], 10) === agent.currentJobId && STARTED_RX.test(t.text)) {
        currentStartedAt = t.ts;
        break;
      }
    }
  }

  // Stats counts come from authoritative per-agent state, fed by real
  // job_completed/job_failed supervisor events. The ticker-mined `recent`
  // list above is purely for the visible history rail underneath.
  const completed = agent.completedToday;
  const failed = agent.failedToday;

  return (
    <div className="drawer-section">
      <div className="drawer-section-head">
        <span>Queue</span>
        {agent.currentJobId != null && <span className="count">1 active</span>}
      </div>

      {/* Active job — rich detail */}
      <div className="queue-active-wrap">
        {agent.currentJobId != null ? (
          <div className="queue-active-card" data-status="running">
            <div className="queue-active-top">
              <span className="queue-active-pulse" />
              <span className="queue-active-id">job #{agent.currentJobId}</span>
              <span className="queue-active-elapsed">
                {currentStartedAt
                  ? fmtElapsedRunning(Date.now() - currentStartedAt)
                  : "in progress"}
              </span>
            </div>
            {agent.task && (
              <div className="queue-active-task">{agent.task}</div>
            )}
            <div className="queue-active-meta">
              <span className="queue-meta-pill">{agent.model}</span>
              <span className="queue-meta-sep">·</span>
              <span>{agent.tokensToday.toLocaleString()} tok today</span>
            </div>
          </div>
        ) : (
          <div className="queue-active-card is-empty">
            <div className="queue-active-top">
              <span className="queue-active-id queue-active-id--muted">
                no active job
              </span>
            </div>
            <div className="queue-active-task queue-active-task--muted">
              {agent.state === "idle"
                ? "ready to claim the next job from the queue"
                : agent.state === "paused"
                  ? "paused — won't claim new jobs"
                  : agent.state === "awaiting"
                    ? "waiting on an upstream handoff"
                    : "—"}
            </div>
          </div>
        )}
      </div>

      {/* Stats strip */}
      <div className="queue-stats">
        <div className="queue-stat">
          <span className="queue-stat-num">{completed}</span>
          <span className="queue-stat-lbl">completed</span>
        </div>
        <div className="queue-stat">
          <span
            className="queue-stat-num"
            data-tone={failed > 0 ? "bad" : undefined}
          >
            {failed}
          </span>
          <span className="queue-stat-lbl">failed</span>
        </div>
        <div className="queue-stat">
          <span className="queue-stat-num">{agent.tokensToday.toLocaleString()}</span>
          <span className="queue-stat-lbl">tokens</span>
        </div>
      </div>

      {/* Recent history */}
      <div className="queue-section-head">Recent</div>
      {recent.length === 0 ? (
        <div className="empty-state" style={{ padding: "10px 20px", fontSize: 11 }}>
          no recent jobs yet
        </div>
      ) : (
        <ul className="queue-recent">
          {recent.map((r) => (
            <li key={r.id} className="queue-recent-row" data-status={r.status}>
              <span className="queue-recent-dot" />
              <span className="queue-recent-id">#{r.id}</span>
              <span className="queue-recent-status">
                {r.status === "ok" ? "completed" : r.status === "fail" ? "failed" : "started"}
              </span>
              <span className="queue-recent-ts">{fmtElapsed(Date.now() - r.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
