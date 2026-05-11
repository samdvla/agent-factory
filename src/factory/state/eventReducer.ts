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
    case "job_completed": {
      if (r && evt.job_id !== undefined) {
        store.setAgentState(r, "idle");
        store.setAgentJob(r, null);
        store.setAgentTask(r, "");
        const result = evt.result as Record<string, unknown> | null | undefined;
        const tickerText =
          result && typeof result["ticker_text"] === "string"
            ? result["ticker_text"]
            : `job #${evt.job_id} done`;
        if (result && result["ok"] === false) {
          store.pushAlert({
            kind: "warn",
            title: `${r} job #${evt.job_id} failed`,
            sub: typeof result["error"] === "string" ? result["error"] : "unknown",
            ts: Date.now(),
            agent: r,
          });
        }
        store.pushTicker({
          ts: Date.now(),
          source: r,
          text: tickerText,
        });
        // Mark real activity so the demo loop suppresses its mock ticker for this role.
        store.markRealActivity(r);
        // CFO net_usd drives the Revenue pill.
        if (evt.role === "cfo" && result) {
          const net = result["net_usd"];
          if (typeof net === "number" && net > 0) {
            store.addRevenue(r, net);
          }
        }
      }
      break;
    }
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
    case "budget_spent": {
      const cost = (evt as any).cost_usd as number;
      if (typeof cost === "number" && cost > 0) {
        store.setBudget(store.budgetTodayUsd + cost);
      }
      break;
    }
    case "asset_rasterized": {
      const pngPath = (evt as any).png_path as string | undefined;
      const bytes = (evt as any).bytes as number | undefined;
      if (typeof pngPath === "string") {
        const filename = pngPath.split("/").pop() ?? pngPath;
        const kb = typeof bytes === "number" ? Math.round(bytes / 1024) : 0;
        store.pushTicker({
          ts: Date.now(),
          source: "designer",
          text: `rasterized: ${filename} (${kb} KB)`,
        });
      }
      break;
    }
    case "etsy_listing_published": {
      const local = (evt as any).local_listing_id as number | undefined;
      const etsy = (evt as any).etsy_listing_id as number | undefined;
      const title = (evt as any).title as string | undefined;
      const stateStr = (evt as any).state as string | undefined;
      store.pushTicker({
        ts: Date.now(),
        source: "publisher",
        text: `Etsy ${stateStr ?? "draft"} #${etsy ?? "?"}: ${title ?? "?"}${
          local !== undefined ? ` (local #${local})` : ""
        }`,
      });
      store.bumpEtsyPublishesRev();
      break;
    }
    case "etsy_listing_publish_failed": {
      const local = (evt as any).local_listing_id as number | undefined;
      const reason = (evt as any).reason as string | undefined;
      store.pushTicker({
        ts: Date.now(),
        source: "publisher",
        text: `Etsy publish failed${local !== undefined ? ` (local #${local})` : ""}: ${
          reason ?? "?"
        }`,
      });
      store.pushAlert({
        kind: "warn",
        title: "Etsy publish failed",
        sub: reason ?? "unknown error",
        ts: Date.now(),
        agent: "publisher",
      });
      break;
    }
    case "etsy_listing_capped": {
      const count = (evt as any).count as number | undefined;
      const cap = (evt as any).cap as number | undefined;
      store.pushTicker({
        ts: Date.now(),
        source: "publisher",
        text: `Etsy daily cap reached (${count ?? "?"}/${cap ?? "?"})`,
      });
      break;
    }
    case "etsy_listing_activated": {
      const etsy = (evt as any).etsy_listing_id as number | undefined;
      store.pushTicker({
        ts: Date.now(),
        source: "publisher",
        text: `Etsy #${etsy ?? "?"} activated`,
      });
      store.bumpEtsyPublishesRev();
      break;
    }
    case "etsy_receipt_ingested": {
      const receiptId = (evt as any).receipt_id as number | undefined;
      const txns = (evt as any).transactions_count as number | undefined;
      const rev = (evt as any).revenue_usd as number | undefined;
      store.pushEtsyReceipt({
        receipt_id: receiptId ?? 0,
        revenue_usd: typeof rev === "number" ? rev : 0,
        txns: typeof txns === "number" ? txns : 0,
        ts: Date.now(),
      });
      store.pushTicker({
        ts: Date.now(),
        source: "etsy",
        text: `etsy · receipt #${receiptId ?? "?"}: ${txns ?? 0} txns · $${
          typeof rev === "number" ? rev.toFixed(2) : "0.00"
        }`,
      });
      break;
    }
    case "etsy_message_ingested": {
      const convId = (evt as any).conversation_id as number | undefined;
      const snippet = (evt as any).snippet as string | undefined;
      const display = (snippet ?? "").slice(0, 80);
      store.pushEtsyMessage({
        conversation_id: convId ?? 0,
        snippet: display,
        ts: Date.now(),
      });
      store.pushTicker({
        ts: Date.now(),
        source: "etsy",
        text: `etsy DM · ${display}${(snippet?.length ?? 0) > 80 ? "…" : ""}`,
      });
      break;
    }
    case "etsy_reply_posted": {
      const convId = (evt as any).conversation_id as number | undefined;
      store.pushTicker({
        ts: Date.now(),
        source: "cs",
        text: `cs → etsy DM #${convId ?? "?"}: replied`,
      });
      break;
    }
    case "etsy_kill_switch_triggered": {
      store.setEtsyKilled(true);
      store.pushTicker({
        ts: Date.now(),
        source: "operator",
        text: "ETSY KILL SWITCH triggered — real publishing halted",
      });
      store.pushAlert({
        kind: "warn",
        title: "Etsy kill switch triggered",
        sub: "real publishing halted — re-enable from the Etsy panel",
        ts: Date.now(),
      });
      break;
    }
    case "pnl_cycle_closed": {
      const cycleId = (evt as any).cycle_id as string | undefined;
      const niche = (evt as any).niche as string | null | undefined;
      const revenue = (evt as any).revenue_usd as number | undefined;
      const cost = (evt as any).total_cost_usd as number | undefined;
      const net = (evt as any).net_usd as number | undefined;
      const shortId = typeof cycleId === "string" ? cycleId.slice(0, 8) : "?";
      const rev = typeof revenue === "number" ? revenue.toFixed(2) : "0.00";
      const cst = typeof cost === "number" ? cost.toFixed(2) : "0.00";
      const n = typeof net === "number" ? net : 0;
      const netStr = `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
      store.pushTicker({
        ts: Date.now(),
        source: "cfo",
        text: `cycle ${shortId}: ${niche || "?"} · rev $${rev} · cost $${cst} · net ${netStr}`,
      });
      break;
    }
    case "budget_capped": {
      const spent = (evt as any).spent_usd as number;
      const cap = (evt as any).cap_usd as number;
      if (typeof spent === "number") {
        store.setBudget(spent);
      }
      store.setBudgetCapped(true);
      store.pushAlert({
        kind: "err",
        title: "Daily budget cap reached",
        sub:
          typeof spent === "number" && typeof cap === "number"
            ? `$${spent.toFixed(2)} / $${cap.toFixed(2)} — workers paused`
            : "workers paused until UTC midnight",
        ts: Date.now(),
      });
      store.pushTicker({
        ts: Date.now(),
        source: "supervisor",
        text:
          typeof spent === "number" && typeof cap === "number"
            ? `BUDGET CAPPED · $${spent.toFixed(2)} / $${cap.toFixed(2)}`
            : "BUDGET CAPPED",
      });
      break;
    }
    default:
      console.warn("Unknown supervisor event kind:", evt.kind, evt);
  }
}
