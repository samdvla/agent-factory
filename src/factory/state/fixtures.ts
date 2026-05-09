import { Role, Room, AgentEntry } from "./types";

export const ROLES: Record<string, Role> = {
  orchestrator: { id:"orchestrator", name:"Orchestrator", title:"Strategy Lead",
    hex:"#f5a623", archetype:"authoritative", portrait:"O", room:"strategy" },
  research: { id:"research", name:"Iris Vega", title:"Market Research Analyst",
    hex:"#5fd4f0", archetype:"slim", portrait:"I", room:"research" },
  designer: { id:"designer", name:"Mara Chen", title:"Designer",
    hex:"#ff6b9d", archetype:"relaxed", portrait:"M", room:"design" },
  listing: { id:"listing", name:"Theo Park", title:"Listing Copywriter",
    hex:"#6bd968", archetype:"office", portrait:"T", room:"listing" },
  publisher: { id:"publisher", name:"Avery Holt", title:"Publisher",
    hex:"#6bd968", archetype:"office", portrait:"A", room:"listing" },
  cs: { id:"cs", name:"Lina Okafor", title:"Customer Service",
    hex:"#6aa9ff", archetype:"friendly", portrait:"L", room:"cs" },
  cfo: { id:"cfo", name:"Roman Voss", title:"CFO",
    hex:"#c4d943", archetype:"formal", portrait:"R", room:"finance" },
  si: { id:"si", name:"Sable Wynn", title:"Self-Improvement Lab",
    hex:"#b393f5", archetype:"lab", portrait:"S", room:"silab" },
};

export const ROOMS: Record<string, Room> = {
  strategy: { id:"strategy", name:"Strategy Room", occupant:"Orchestrator", col:0, row:0, kind:"bridge" },
  research: { id:"research", name:"Research Lab", occupant:"Market Research", col:1, row:0, kind:"analyst" },
  design: { id:"design", name:"Design Studio", occupant:"Designer", col:2, row:0, kind:"fab" },
  listing: { id:"listing", name:"Listing Desk", occupant:"Copywriter & Publisher", col:0, row:1, kind:"dispatch" },
  cs: { id:"cs", name:"CS Booth", occupant:"Customer Service", col:1, row:1, kind:"comms" },
  finance: { id:"finance", name:"Finance Office", occupant:"CFO", col:2, row:1, kind:"control" },
  silab: { id:"silab", name:"Self-Improvement Lab", occupant:"SI Agent", col:1, row:2, kind:"rd" },
};

export const INITIAL_AGENTS: Record<string, AgentEntry> = {
  orchestrator: { role:"orchestrator", name:"Orchestrator", state:"idle", task:"", model:"Sonnet", tokensToday:0, currentJobId:null },
  research: { role:"research", name:"Iris Vega", state:"idle", task:"", model:"Haiku", tokensToday:0, currentJobId:null },
  designer: { role:"designer", name:"Mara Chen", state:"idle", task:"", model:"Sonnet", tokensToday:0, currentJobId:null },
  listing: { role:"listing", name:"Theo Park", state:"idle", task:"", model:"Haiku", tokensToday:0, currentJobId:null },
  publisher: { role:"publisher", name:"Avery Holt", state:"idle", task:"", model:"Haiku", tokensToday:0, currentJobId:null },
  cs: { role:"cs", name:"Lina Okafor", state:"idle", task:"", model:"Haiku", tokensToday:0, currentJobId:null },
  cfo: { role:"cfo", name:"Roman Voss", state:"idle", task:"", model:"Haiku", tokensToday:0, currentJobId:null },
  si: { role:"si", name:"Sable Wynn", state:"idle", task:"", model:"Sonnet", tokensToday:0, currentJobId:null },
};

// P0 only ships the `hello` agent. Map it to one of the designed roles for visual purposes.
// When P2 wires real agents, this mapping goes away.
export const SUPERVISOR_ROLE_MAP: Record<string, string> = {
  hello: "orchestrator",
};
