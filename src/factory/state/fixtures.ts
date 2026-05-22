import { Role, Room, AgentEntry, HireEvent, RoomKit, RoomTag } from "./types";
import { kitFromTag } from "../svg/kit/recipes";

function k(tag: RoomTag, accent: string, cap?: number): RoomKit {
  return kitFromTag(tag, accent, cap);
}

export const ROLES: Record<string, Role> = {
  orchestrator: { id:"orchestrator", name:"Orchestrator", title:"Strategy Lead",
    hex:"#f5a623", archetype:"authoritative", portrait:"O", room:"strategy", permanent:true },
  research: { id:"research", name:"Iris Vega", title:"Market Research Analyst",
    hex:"#5fd4f0", archetype:"slim", portrait:"I", room:"research", permanent:true },
  designer: { id:"designer", name:"Mara Chen", title:"Lead Designer",
    hex:"#ff6b9d", archetype:"relaxed", portrait:"M", room:"design", permanent:true },
  listing: { id:"listing", name:"Theo Park", title:"Listing Copywriter",
    hex:"#6bd968", archetype:"office", portrait:"T", room:"listing", permanent:true },
  publisher: { id:"publisher", name:"Avery Holt", title:"Publisher",
    hex:"#6bd968", archetype:"office", portrait:"A", room:"listing", permanent:true },
  cs: { id:"cs", name:"Lina Okafor", title:"Customer Service",
    hex:"#6aa9ff", archetype:"friendly", portrait:"L", room:"cs", permanent:true },
  marketing: { id:"marketing", name:"Vera Quill", title:"Marketing Lead",
    hex:"#ff6f61", archetype:"friendly", portrait:"V", room:"marketing", permanent:true },
  cfo: { id:"cfo", name:"Roman Voss", title:"CFO",
    hex:"#c4d943", archetype:"formal", portrait:"R", room:"finance", permanent:true },
  si: { id:"si", name:"Sable Wynn", title:"Self-Improvement Lab",
    hex:"#b393f5", archetype:"lab", portrait:"S", room:"silab", permanent:true },
  // Designer-wing specialists. Each one is a small employee desk that the
  // lead designer routes briefs to based on the archetype detected in the
  // brief (see workers/designer/designer/agent.py:_classify_archetype).
  // Distinct accent + distinct silhouette → no two specialists read the
  // same at glance distance.
  anime_spec: { id:"anime_spec", name:"Yuki Hoshino", title:"Anime Stylist",
    hex:"#ff3d8b", archetype:"anime_spec", portrait:"Y", room:"anime", permanent:true },
  hero_spec: { id:"hero_spec", name:"Cal Nakamura", title:"Superhero Designer",
    hex:"#3057ff", archetype:"hero_spec", portrait:"C", room:"hero", permanent:true },
  mecha_spec: { id:"mecha_spec", name:"Ari Kovac", title:"Mecha Engineer",
    hex:"#ff8c2e", archetype:"mecha_spec", portrait:"A", room:"mecha", permanent:true },
  chibi_spec: { id:"chibi_spec", name:"Momo Park", title:"Chibi Mascot Artist",
    hex:"#d8a8ff", archetype:"chibi_spec", portrait:"M", room:"chibi", permanent:true },
  deity_spec: { id:"deity_spec", name:"Inanna Veil", title:"Deity Sculptor",
    hex:"#d8a857", archetype:"deity_spec", portrait:"I", room:"deity", permanent:true },
  creature_spec: { id:"creature_spec", name:"Bram Holloway", title:"Creature Designer",
    hex:"#3e9d6f", archetype:"creature_spec", portrait:"B", room:"creature", permanent:true },
  humanoid_spec: { id:"humanoid_spec", name:"Rune Adair", title:"Humanoid Sculptor",
    hex:"#a87049", archetype:"humanoid_spec", portrait:"R", room:"humanoid", permanent:true },
};

export const ROOMS: Record<string, Room> = {
  strategy: { id:"strategy", name:"Strategy Room", col:0, row:0,
    kit: k("bridge", "#f5a623", 1), occupants:["orchestrator"], createdAt:0 },
  research: { id:"research", name:"Research Lab", col:1, row:0,
    kit: k("analyst", "#5fd4f0", 2), occupants:["research"], createdAt:0 },
  design: { id:"design", name:"Design Studio", col:2, row:0,
    kit: k("creative", "#ff6b9d", 1), occupants:["designer"], createdAt:0 },
  listing: { id:"listing", name:"Listing Desk", col:0, row:1,
    kit: k("copy", "#6bd968", 2), occupants:["listing","publisher"], createdAt:0 },
  cs: { id:"cs", name:"CS Booth", col:1, row:1,
    kit: k("comms", "#6aa9ff", 4), occupants:["cs"], createdAt:0 },
  finance: { id:"finance", name:"Finance Office", col:2, row:1,
    kit: k("finance", "#c4d943", 1), occupants:["cfo"], createdAt:0 },
  silab: { id:"silab", name:"Self-Improvement Lab", col:1, row:2,
    kit: k("rd", "#b393f5", 1), occupants:["si"], createdAt:0 },
  marketing: { id:"marketing", name:"Marketing Studio", col:2, row:2,
    kit: k("marketing", "#ff6f61", 2), occupants:["marketing"], createdAt:0 },
  // Ops Bay is a founding room WITHOUT a permanent occupant — the Printify
  // Operator moves in when POD is enabled and moves out when it's toggled
  // off, but the room itself stays put so it doesn't disappear/reappear.
  ops: { id:"ops", name:"Ops Bay", col:0, row:2,
    kit: k("ops", "#5ed0a8", 3), occupants:[], createdAt:0 },
  // Designer-wing specialists. Clustered in cols 3-5 immediately east of the
  // design studio (2,0) so the visual + corridor flow reads as "lead designer
  // hands off to a specialist next door." Each room is its own tag so the
  // iso renderer can swap in archetype-specific props (katana wall, cape
  // mannequin, gantry, plush bin, altar, bone shelf, sword rack).
  anime:    { id:"anime",    name:"Anime Stylist",      col:3, row:0,
    kit: k("anime_studio",   "#ff3d8b", 1), occupants:["anime_spec"],    createdAt:0 },
  hero:     { id:"hero",     name:"Hero Studio",        col:4, row:0,
    kit: k("hero_studio",    "#3057ff", 1), occupants:["hero_spec"],     createdAt:0 },
  mecha:    { id:"mecha",    name:"Mecha Bay",          col:5, row:0,
    kit: k("mecha_bay",      "#ff8c2e", 1), occupants:["mecha_spec"],    createdAt:0 },
  chibi:    { id:"chibi",    name:"Chibi Corner",       col:3, row:1,
    kit: k("chibi_corner",   "#d8a8ff", 1), occupants:["chibi_spec"],    createdAt:0 },
  deity:    { id:"deity",    name:"Deity Atelier",      col:4, row:1,
    kit: k("deity_atelier",  "#d8a857", 1), occupants:["deity_spec"],    createdAt:0 },
  creature: { id:"creature", name:"Creature Den",       col:5, row:1,
    kit: k("creature_den",   "#3e9d6f", 1), occupants:["creature_spec"], createdAt:0 },
  humanoid: { id:"humanoid", name:"Humanoid Forge",     col:3, row:2,
    kit: k("humanoid_forge", "#a87049", 1), occupants:["humanoid_spec"], createdAt:0 },
};

/** Founding room ids — fixtures-defined rooms that must never be auto-
 *  dissolved when their last occupant leaves. Used by the dissolve path
 *  in hireResolver so Ops Bay (and any future "empty-on-purpose" founding
 *  rooms) survive across the lifecycle of dynamically-hired specialists. */
export const FOUNDING_ROOM_IDS: ReadonlySet<string> = new Set(Object.keys(ROOMS));

// The `model` fields here are only the cold-start fallback. As soon as a
// worker emits its first `budget_spent` event the store overwrites the
// label with whatever model the worker actually billed against, so these
// stay accurate without anyone manually syncing them after a tier-up.
// Source of truth lives in each worker's `MODEL = "..."` constant.
export const INITIAL_AGENTS: Record<string, AgentEntry> = {
  orchestrator: { role:"orchestrator", name:"Orchestrator", state:"idle", task:"", model:"Opus 4.7", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  research: { role:"research", name:"Iris Vega", state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  designer: { role:"designer", name:"Mara Chen", state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  listing: { role:"listing", name:"Theo Park", state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  publisher: { role:"publisher", name:"Avery Holt", state:"idle", task:"", model:"—", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  cs: { role:"cs", name:"Lina Okafor", state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  marketing: { role:"marketing", name:"Vera Quill", state:"idle", task:"", model:"Haiku 4.5", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  cfo: { role:"cfo", name:"Roman Voss", state:"idle", task:"", model:"Opus 4.7", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  si: { role:"si", name:"Sable Wynn", state:"idle", task:"", model:"Opus 4.7", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  strategist: { role:"strategist", name:"Calliope Wren", state:"idle", task:"", model:"Opus 4.7", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  // Designer-wing specialists. Each one shadows the lead designer's Sonnet
  // call when its archetype routes the brief — they don't currently bill on
  // their own (the prompt baseline is one Sonnet call from the designer
  // worker) but they appear in queue panels, the side drawer, and the
  // model column. Surface them at Sonnet 4.6 since that's the model the
  // designer pipeline runs under.
  anime_spec:    { role:"anime_spec",    name:"Yuki Hoshino",  state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  hero_spec:     { role:"hero_spec",     name:"Cal Nakamura",  state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  mecha_spec:    { role:"mecha_spec",    name:"Ari Kovac",     state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  chibi_spec:    { role:"chibi_spec",    name:"Momo Park",     state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  deity_spec:    { role:"deity_spec",    name:"Inanna Veil",   state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  creature_spec: { role:"creature_spec", name:"Bram Holloway", state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  humanoid_spec: { role:"humanoid_spec", name:"Rune Adair",    state:"idle", task:"", model:"Sonnet 4.6", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
};

export const SUPERVISOR_ROLE_MAP: Record<string, string> = {
  hello: "orchestrator",
  orchestrator: "orchestrator",
  research: "research",
  designer: "designer",
  listing: "listing",
  publisher: "publisher",
  cfo: "cfo",
  cs: "cs",
  si: "si",
  strategist: "strategist",
  marketing: "marketing",
};

export const FOUNDING_HIRE_EVENTS: HireEvent[] = Object.values(ROLES).map((role) => ({
  id: `founding-${role.id}`,
  ts: 0,
  roleSpec: {
    name: role.name,
    title: role.title,
    primaryTag: ROOMS[role.room].kit!.primaryTag,
    archetype: role.archetype,
    model: INITIAL_AGENTS[role.id].model,
    accent: role.hex,
    portrait: role.portrait,
  },
  justification: { reason: "founding", metric: "founding role" },
}));
