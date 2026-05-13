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
  designer: { id:"designer", name:"Mara Chen", title:"Designer",
    hex:"#ff6b9d", archetype:"relaxed", portrait:"M", room:"design", permanent:true },
  listing: { id:"listing", name:"Theo Park", title:"Listing Copywriter",
    hex:"#6bd968", archetype:"office", portrait:"T", room:"listing", permanent:true },
  publisher: { id:"publisher", name:"Avery Holt", title:"Publisher",
    hex:"#6bd968", archetype:"office", portrait:"A", room:"listing", permanent:true },
  cs: { id:"cs", name:"Lina Okafor", title:"Customer Service",
    hex:"#6aa9ff", archetype:"friendly", portrait:"L", room:"cs", permanent:true },
  cfo: { id:"cfo", name:"Roman Voss", title:"CFO",
    hex:"#c4d943", archetype:"formal", portrait:"R", room:"finance", permanent:true },
  si: { id:"si", name:"Sable Wynn", title:"Self-Improvement Lab",
    hex:"#b393f5", archetype:"lab", portrait:"S", room:"silab", permanent:true },
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
};

export const INITIAL_AGENTS: Record<string, AgentEntry> = {
  orchestrator: { role:"orchestrator", name:"Orchestrator", state:"idle", task:"", model:"Sonnet", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  research: { role:"research", name:"Iris Vega", state:"idle", task:"", model:"Haiku", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  designer: { role:"designer", name:"Mara Chen", state:"idle", task:"", model:"Sonnet", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  listing: { role:"listing", name:"Theo Park", state:"idle", task:"", model:"Haiku", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  publisher: { role:"publisher", name:"Avery Holt", state:"idle", task:"", model:"Haiku", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  cs: { role:"cs", name:"Lina Okafor", state:"idle", task:"", model:"Haiku", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  cfo: { role:"cfo", name:"Roman Voss", state:"idle", task:"", model:"Haiku", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
  si: { role:"si", name:"Sable Wynn", state:"idle", task:"", model:"Sonnet", tokensToday:0, completedToday:0, failedToday:0, currentJobId:null },
};

export const SUPERVISOR_ROLE_MAP: Record<string, string> = {
  hello: "orchestrator",
  orchestrator: "orchestrator",
  research: "research",
  designer: "designer",
  listing: "listing",
  publisher: "publisher",
  cfo: "cfo",
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
