import { useEffect, useMemo, useRef, useState } from "react";
import { useFactoryStore } from "../state/factoryStore";

type StageDef = {
  id: string;
  label: string;
  sub: string;
};

const PIPELINE: StageDef[] = [
  { id: "research",     label: "Research",     sub: "demand scan" },
  { id: "orchestrator", label: "Orchestrate",  sub: "design ticket" },
  { id: "designer",     label: "Design",       sub: "3D asset" },
  { id: "listing",      label: "Listing",      sub: "copy + tags" },
  { id: "publisher",    label: "Publish",      sub: "Etsy / Cults3D" },
  { id: "cfo",          label: "P&L Close",    sub: "cycle close" },
];

const ACTIVE_STATES = new Set(["working", "walking", "awaiting"]);
const AVG_KEY = "agentFactory.pipeline.avgMs.v1";
const COLLAPSED_KEY = "agentFactory.pipeline.collapsed.v1";
const HISTORY_LIMIT = 10;

type Status = "completed" | "current" | "pending";

type StageState = {
  status: Status;
  startedAt: number | null;
  durationMs: number | null;
  avgMs: number | null;
};

function loadAvgs(): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(AVG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveAvgs(avgs: Record<string, number[]>) {
  try {
    localStorage.setItem(AVG_KEY, JSON.stringify(avgs));
  } catch {}
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export default function PipelinePanel() {
  const agents = useFactoryStore((s) => s.agents);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
  });
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch {}
      return next;
    });
  };

  // Cycle-local state. stageStartedAt[id] is the most recent ts at which the
  // agent entered an active state. stageDurationMs[id] is the last observed
  // duration (only set on the working → idle transition). stageInCycle[id]
  // marks whether this stage has been *seen* in the current cycle so the
  // ordering of "completed" check marks is reliable even if completedToday
  // hasn't been bumped yet.
  const [stageStartedAt, setStageStartedAt] = useState<Record<string, number>>({});
  const [stageDurationMs, setStageDurationMs] = useState<Record<string, number>>({});
  const [stageInCycle, setStageInCycle] = useState<Record<string, boolean>>({});

  const avgsRef = useRef<Record<string, number[]>>(loadAvgs());
  const prevStateRef = useRef<Record<string, string>>({});

  // Wall-clock ticker so the current stage's elapsed/ETA update every second
  // without requiring the rest of the store to re-render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Track agent-state transitions: start → record startedAt, end → record
  // duration and feed it into the rolling avg. Resets the cycle when the
  // CFO completes (the canonical "cycle close").
  useEffect(() => {
    const prev = prevStateRef.current;
    const updatesStart: Record<string, number> = {};
    const updatesDur: Record<string, number> = {};
    const updatesInCycle: Record<string, boolean> = {};
    let cycleJustClosed = false;

    for (const stage of PIPELINE) {
      const cur = agents[stage.id]?.state;
      const wasActive = ACTIVE_STATES.has(prev[stage.id] ?? "idle");
      const isActive = ACTIVE_STATES.has(cur ?? "idle");

      if (isActive && !wasActive) {
        updatesStart[stage.id] = Date.now();
        updatesInCycle[stage.id] = true;
      }
      if (!isActive && wasActive) {
        const startedAt = stageStartedAt[stage.id];
        if (startedAt) {
          const dur = Date.now() - startedAt;
          updatesDur[stage.id] = dur;
          const list = avgsRef.current[stage.id] ?? [];
          const next = [...list, dur].slice(-HISTORY_LIMIT);
          avgsRef.current = { ...avgsRef.current, [stage.id]: next };
          saveAvgs(avgsRef.current);
        }
        updatesInCycle[stage.id] = true;
        // Cycle boundary: CFO finishing wraps the loop.
        if (stage.id === "cfo") cycleJustClosed = true;
      }
      prev[stage.id] = cur ?? "idle";
    }

    if (
      Object.keys(updatesStart).length ||
      Object.keys(updatesDur).length ||
      Object.keys(updatesInCycle).length
    ) {
      if (Object.keys(updatesStart).length) {
        setStageStartedAt((s) => ({ ...s, ...updatesStart }));
      }
      if (Object.keys(updatesDur).length) {
        setStageDurationMs((s) => ({ ...s, ...updatesDur }));
      }
      if (Object.keys(updatesInCycle).length) {
        setStageInCycle((s) => ({ ...s, ...updatesInCycle }));
      }
    }

    if (cycleJustClosed) {
      // Hold the "all green" view for a beat, then drop into pending again
      // so the next cycle reads as a fresh run.
      const t = setTimeout(() => setStageInCycle({}), 2400);
      return () => clearTimeout(t);
    }
  }, [agents, stageStartedAt]);

  const stages: Array<StageState & { def: StageDef }> = useMemo(() => {
    // Determine the current stage = latest pipeline index whose agent is
    // currently in an active state. If multiple are active, the later one
    // wins (handoff is in flight).
    let currentIdx = -1;
    PIPELINE.forEach((stage, idx) => {
      const cur = agents[stage.id]?.state;
      if (ACTIVE_STATES.has(cur ?? "idle")) currentIdx = idx;
    });

    return PIPELINE.map((def, idx) => {
      let status: Status;
      if (idx === currentIdx) {
        status = "current";
      } else if (currentIdx === -1) {
        // No active stage. Either between cycles or completely idle. If the
        // stage was seen in the current cycle, mark it completed.
        status = stageInCycle[def.id] ? "completed" : "pending";
      } else if (idx < currentIdx) {
        // Pipeline assumption: anything before the currently-working stage
        // has effectively been handed off, so render as completed.
        status = "completed";
      } else {
        status = "pending";
      }

      const list = avgsRef.current[def.id] ?? [];
      const avgMs = list.length
        ? Math.round(list.reduce((a, b) => a + b, 0) / list.length)
        : null;

      return {
        def,
        status,
        startedAt: stageStartedAt[def.id] ?? null,
        durationMs: stageDurationMs[def.id] ?? null,
        avgMs,
      };
    });
  }, [agents, stageStartedAt, stageDurationMs, stageInCycle]);

  const completedCount = stages.filter((s) => s.status === "completed").length;
  const isAllIdle = stages.every((s) => s.status !== "current");
  const currentStage = stages.find((s) => s.status === "current");
  const headerLabel = currentStage
    ? "Cycle in progress"
    : completedCount === PIPELINE.length
      ? "Cycle complete"
      : "Idle";

  return (
    <aside
      className={`pipeline-panel${collapsed ? " is-collapsed" : ""}`}
      aria-label="Pipeline stage progress"
    >
      <button
        type="button"
        className="pipeline-panel-head"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand pipeline panel" : "Collapse pipeline panel"}
        title={collapsed ? "Expand pipeline" : "Hide pipeline"}
      >
        <div className="pipeline-panel-title">
          <span className="pipeline-panel-dot" data-status={currentStage ? "live" : "idle"} />
          <span className="pipeline-panel-label">Pipeline</span>
        </div>
        <div className="pipeline-panel-meta">
          <span className="pipeline-panel-state">
            {collapsed && currentStage ? currentStage.def.label : headerLabel}
          </span>
          <span className="pipeline-panel-count">{completedCount}/{PIPELINE.length}</span>
          <span className="pipeline-panel-chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="10" height="10">
              <polyline
                points="4 6 8 10 12 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </button>

      {!collapsed && <>
      <ol className="pipeline-steps">
        {stages.map((s, idx) => {
          const isLast = idx === stages.length - 1;
          let timeNode: React.ReactNode = null;

          if (s.status === "current" && s.startedAt) {
            const elapsed = now - s.startedAt;
            const remaining = s.avgMs ? s.avgMs - elapsed : null;
            if (remaining === null) {
              timeNode = (
                <span className="pipeline-step-time is-live">
                  <span className="pipeline-time-glyph" />
                  {fmtMs(elapsed)} elapsed
                </span>
              );
            } else if (remaining > 1500) {
              timeNode = (
                <span className="pipeline-step-time is-live">
                  <span className="pipeline-time-glyph" />
                  ~{fmtMs(remaining)} left
                </span>
              );
            } else if (remaining > -8000) {
              timeNode = (
                <span className="pipeline-step-time is-live almost">
                  <span className="pipeline-time-glyph" />
                  finishing…
                </span>
              );
            } else {
              // Running over its average — show elapsed instead of negative ETA.
              timeNode = (
                <span className="pipeline-step-time is-live over">
                  <span className="pipeline-time-glyph" />
                  {fmtMs(elapsed)} (overrun)
                </span>
              );
            }
          } else if (s.status === "completed" && s.durationMs) {
            timeNode = (
              <span className="pipeline-step-time is-done">
                {fmtMs(s.durationMs)}
              </span>
            );
          } else if (s.status === "pending" && s.avgMs) {
            timeNode = (
              <span className="pipeline-step-time is-pending">
                ≈ {fmtMs(s.avgMs)}
              </span>
            );
          }

          // Progress bar for the current stage.
          let progress: number | null = null;
          if (s.status === "current" && s.startedAt && s.avgMs) {
            progress = Math.min(1, Math.max(0.04, (now - s.startedAt) / s.avgMs));
          } else if (s.status === "current" && s.startedAt && !s.avgMs) {
            // No history yet — render a slow indeterminate sweep via CSS.
            progress = -1;
          }

          return (
            <li
              key={s.def.id}
              className={`pipeline-step is-${s.status}${isLast ? " is-last" : ""}`}
            >
              <div className="pipeline-step-rail" aria-hidden="true">
                <span className="pipeline-step-node">
                  {s.status === "completed" ? (
                    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                      <path
                        d="M3 8.5L6.5 12L13 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : s.status === "current" ? (
                    <span className="pipeline-step-pulse" />
                  ) : (
                    <span className="pipeline-step-dot" />
                  )}
                </span>
                {!isLast && <span className="pipeline-step-connector" />}
              </div>
              <div className="pipeline-step-body">
                <div className="pipeline-step-row">
                  <span className="pipeline-step-name">{s.def.label}</span>
                  {timeNode}
                </div>
                <div className="pipeline-step-sub">{s.def.sub}</div>
                {progress !== null && (
                  <div
                    className={`pipeline-step-bar${progress < 0 ? " indeterminate" : ""}`}
                    aria-hidden="true"
                  >
                    <span
                      className="pipeline-step-bar-fill"
                      style={progress >= 0 ? { width: `${progress * 100}%` } : undefined}
                    />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {isAllIdle && completedCount === PIPELINE.length && (
        <div className="pipeline-panel-footer">All stages complete · waiting for next cycle</div>
      )}
      </>}
    </aside>
  );
}
