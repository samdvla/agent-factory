import type { AgentEntry } from "../state/types";

/** Safety cap on a thought string. Curated phrases are short by design; this
 *  just guards against an unexpectedly long generic line spilling past the
 *  small 2-line bubble. */
export const THOUGHT_MAX_CHARS = 38;

type Mode = "working" | "idle" | "crashed" | "paused";

/**
 * Natural, human, first-person-ish phrase banks per role + state. These read
 * like an employee's passing thought, NOT a system log — that's the whole
 * point: the bubbles should feel alive, not echo "job #5 started" /
 * "exited (will restart)" raw ticker noise.
 *
 * Keyed by role id. Any role without an entry (dynamically-hired specialists,
 * the Printify Operator, future workers) falls back to GENERIC so EVERY
 * agent — present or future — always has natural thoughts.
 */
const THOUGHT_BANKS: Record<string, Record<Mode, string[]>> = {
  orchestrator: {
    working: ["what should we make next?", "lining up the queue", "this one could sell", "balancing the workload"],
    idle: ["reviewing the board", "what's next?"],
    crashed: ["quick reset…", "back in a sec"],
    paused: ["holding the line"],
  },
  strategist: {
    working: ["tightening the prompts", "what's converting lately?", "tuning the brief", "studying what sold"],
    idle: ["thinking it over", "any patterns here?"],
    crashed: ["rebooting…", "one moment"],
    paused: ["taking a beat"],
  },
  research: {
    working: ["what's selling today?", "this niche looks hot", "checking the competition", "digging for trends"],
    idle: ["waiting on a brief", "scanning the market"],
    crashed: ["reconnecting…", "back soon"],
    paused: ["on standby"],
  },
  designer: {
    working: ["what's the right pose?", "blocking the silhouette", "handing this to a specialist", "this needs more drama"],
    idle: ["ready for the next one", "sketching ideas"],
    crashed: ["restarting…", "quick hiccup"],
    paused: ["pencils down for now"],
  },
  anime_spec: {
    working: ["big expressive eyes", "dramatic hair + pose", "make her look heroic", "what'll sell on Etsy?"],
    idle: ["doodling characters", "ideas brewing"],
    crashed: ["rebooting…"],
    paused: ["short break"],
  },
  hero_spec: {
    working: ["the cape needs flow", "bold heroic stance", "pure comic energy", "chunky armor plates"],
    idle: ["sketching capes", "who's the hero today?"],
    crashed: ["rebooting…"],
    paused: ["short break"],
  },
  mecha_spec: {
    working: ["more panel detail", "hard-surface it all", "this mech needs weight", "clean mechanical lines"],
    idle: ["drafting frames", "thinking in metal"],
    crashed: ["rebooting…"],
    paused: ["short break"],
  },
  chibi_spec: {
    working: ["make it adorable", "round and squishy", "tiny and kawaii", "max cuteness"],
    idle: ["doodling cuties", "so many ideas"],
    crashed: ["rebooting…"],
    paused: ["short break"],
  },
  deity_spec: {
    working: ["regal and timeless", "carving the relief", "this needs gravitas", "ancient and powerful"],
    idle: ["studying the myths", "channeling the divine"],
    crashed: ["rebooting…"],
    paused: ["short break"],
  },
  creature_spec: {
    working: ["scales or fur?", "make it menacing", "coiled tail, folded wings", "give it real bite"],
    idle: ["sketching beasts", "what lurks next?"],
    crashed: ["rebooting…"],
    paused: ["short break"],
  },
  humanoid_spec: {
    working: ["battle-worn armor", "nailing the proportions", "this ranger needs grit", "more cybernetic detail"],
    idle: ["blocking the figure", "posing it out"],
    crashed: ["rebooting…"],
    paused: ["short break"],
  },
  listing: {
    working: ["the perfect title…", "which tags rank?", "polishing the copy", "hook the buyer fast"],
    idle: ["queue's clear", "ready to write"],
    crashed: ["restarting…"],
    paused: ["pen down for now"],
  },
  publisher: {
    working: ["pushing it live", "uploading the files", "syncing the shop", "almost published"],
    idle: ["all shipped", "standing by"],
    crashed: ["reconnecting…"],
    paused: ["holding uploads"],
  },
  cfo: {
    working: ["are we profitable?", "crunching the margins", "watching the burn", "is this worth it?"],
    idle: ["books are balanced", "numbers look ok"],
    crashed: ["recalculating…"],
    paused: ["ledger's closed"],
  },
  cs: {
    working: ["helping a buyer out", "drafting a kind reply", "smoothing things over", "keeping them happy"],
    idle: ["inbox is quiet", "all caught up"],
    crashed: ["reconnecting…"],
    paused: ["away for a bit"],
  },
  marketing: {
    working: ["what'll get repinned?", "scheduling some pins", "chasing the algorithm", "this'll go viral"],
    idle: ["planning content", "ideas for pins"],
    crashed: ["reconnecting…"],
    paused: ["off the clock"],
  },
  si: {
    working: ["what can we improve?", "testing a new prompt", "measuring the lift", "make it smarter"],
    idle: ["reviewing results", "what's next to tune?"],
    crashed: ["rebooting…"],
    paused: ["lab's quiet"],
  },
};

const GENERIC: Record<Mode, string[]> = {
  working: ["on it", "working through this", "almost there", "making progress"],
  idle: ["standing by", "ready when needed"],
  crashed: ["back in a sec", "rebooting…"],
  paused: ["taking a break"],
};

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function modeForState(state: AgentEntry["state"]): Mode | null {
  switch (state) {
    case "working":
    case "walking":
    case "awaiting":
      return "working";
    case "idle":
      return "idle";
    case "crashed":
      return "crashed";
    case "paused":
      return "paused";
    // killed / quarantined / materializing / dissolving → transient or gone:
    // no bubble.
    default:
      return null;
  }
}

function clamp(text: string): string {
  return text.length > THOUGHT_MAX_CHARS
    ? text.slice(0, THOUGHT_MAX_CHARS - 1).trimEnd() + "…"
    : text;
}

/**
 * Pick the natural thought for one agent. Stable across renders (no wall-clock
 * randomness) but rotates as work progresses: the phrase index is seeded by
 * role id + current job + jobs completed, so a new job naturally surfaces a
 * different line. Returns "" when the agent's state warrants no bubble.
 */
export function thoughtForAgent(roleId: string, agent: AgentEntry): string {
  const mode = modeForState(agent.state);
  if (!mode) return "";
  const bank = THOUGHT_BANKS[roleId] ?? GENERIC;
  const lines = bank[mode]?.length ? bank[mode] : GENERIC[mode];
  if (!lines.length) return "";
  const seed =
    hashStr(roleId) +
    (mode === "working" ? (agent.currentJobId ?? 0) : 0) +
    agent.completedToday;
  return clamp(lines[seed % lines.length]);
}

/**
 * Derive the per-role thought-cloud text for every agent. Pure function — no
 * store access, no wall clock — so it's cheap to unit test and to call inside
 * a useMemo keyed on `agents`. Every agent (including dynamically-hired /
 * future roles via the GENERIC bank) gets a natural thought unless its state
 * warrants none.
 */
export function deriveThoughts(
  agents: Record<string, AgentEntry>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(agents)) {
    const a = agents[id];
    if (!a) continue;
    const phrase = thoughtForAgent(id, a);
    if (phrase) out[id] = phrase;
  }
  return out;
}
