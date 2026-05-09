import { FactoryStore } from "./factoryStore";
import { SUPERVISOR_ROLE_MAP } from "./fixtures";

export type SupervisorEvent = {
  kind: string;
  role?: string;
  job_id?: number;
  result?: unknown;
  error?: string;
  method?: string;
  params?: unknown;
  project_id?: number;
  usd_today?: number;
  code?: number | null;
};

function visualRole(r: string | undefined): string | null {
  if (!r) return null;
  return SUPERVISOR_ROLE_MAP[r] ?? r;
}

export function applySupervisorEvent(
  store: FactoryStore,
  evt: SupervisorEvent
): void {
  const r = visualRole(evt.role);
  switch (evt.kind) {
    case "agent_started":
      if (r) {
        store.setAgentState(r, "idle");
        store.pushTicker({
          ts: Date.now(),
          source: r,
          text: "started",
        });
      }
      break;
    case "agent_exited":
      if (r) {
        store.setAgentState(r, "crashed");
        store.pushTicker({
          ts: Date.now(),
          source: r,
          text: "exited (will restart)",
        });
        store.pushAlert({
          kind: "warn",
          title: `${r} exited`,
          sub: "supervisor will restart",
          ts: Date.now(),
          agent: r,
        });
      }
      break;
    case "job_started":
      if (r && evt.job_id !== undefined) {
        store.setAgentState(r, "working");
        store.setAgentJob(r, evt.job_id);
        store.setAgentTask(r, "process_job");
        store.pushTicker({
          ts: Date.now(),
          source: r,
          text: `job #${evt.job_id} started`,
        });
      }
      break;
    case "job_completed":
      if (r && evt.job_id !== undefined) {
        store.setAgentState(r, "idle");
        store.setAgentJob(r, null);
        store.setAgentTask(r, "");
        store.pushTicker({
          ts: Date.now(),
          source: r,
          text: `job #${evt.job_id} done`,
        });
      }
      break;
    case "job_failed":
      if (r && evt.job_id !== undefined) {
        store.setAgentState(r, "crashed");
        store.setAgentJob(r, null);
        store.pushTicker({
          ts: Date.now(),
          source: r,
          text: `job #${evt.job_id} failed: ${evt.error ?? "?"}`,
        });
        store.pushAlert({
          kind: "err",
          title: `${r} job failed`,
          sub: evt.error ?? "unknown",
          ts: Date.now(),
          agent: r,
        });
      }
      break;
    case "worker_notification":
      if (r && evt.method) {
        store.pushTicker({
          ts: Date.now(),
          source: r,
          text: `note: ${evt.method}`,
        });
      }
      break;
    case "budget_tick":
      if (typeof evt.usd_today === "number") {
        store.setBudget(evt.usd_today);
      }
      break;
    default:
      console.warn("Unknown supervisor event kind:", evt.kind, evt);
  }
}
