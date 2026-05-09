/* ========================================================================
   Factory Floor — data layer
   ======================================================================== */

// Role definitions — order matters for rendering
const ROLES = {
  orchestrator: {
    id: 'orchestrator', name: 'Orchestrator',
    title: 'Strategy Lead',
    color: 'var(--role-orchestrator)', colorHex: '#f5a623',
    archetype: 'authoritative', portrait: 'O',
    room: 'strategy',
  },
  research: {
    id: 'research', name: 'Iris Vega',
    title: 'Market Research Analyst',
    color: 'var(--role-research)', colorHex: '#5fd4f0',
    archetype: 'slim', portrait: 'I',
    room: 'research',
  },
  designer: {
    id: 'designer', name: 'Mara Chen',
    title: 'Designer',
    color: 'var(--role-designer)', colorHex: '#ff6b9d',
    archetype: 'relaxed', portrait: 'M',
    room: 'design',
  },
  listing: {
    id: 'listing', name: 'Theo Park',
    title: 'Listing Copywriter',
    color: 'var(--role-listing)', colorHex: '#6bd968',
    archetype: 'office', portrait: 'T',
    room: 'listing',
  },
  publisher: {
    id: 'publisher', name: 'Avery Holt',
    title: 'Publisher',
    color: 'var(--role-listing)', colorHex: '#6bd968',
    archetype: 'office', portrait: 'A',
    room: 'listing',
  },
  cs: {
    id: 'cs', name: 'Lina Okafor',
    title: 'Customer Service',
    color: 'var(--role-cs)', colorHex: '#6aa9ff',
    archetype: 'friendly', portrait: 'L',
    room: 'cs',
  },
  cfo: {
    id: 'cfo', name: 'Roman Voss',
    title: 'CFO',
    color: 'var(--role-cfo)', colorHex: '#c4d943',
    archetype: 'formal', portrait: 'R',
    room: 'finance',
  },
  si: {
    id: 'si', name: 'Sable Wynn',
    title: 'Self-Improvement Lab',
    color: 'var(--role-si)', colorHex: '#b393f5',
    archetype: 'lab', portrait: 'S',
    room: 'silab',
  },
};

// Room definitions — grid coordinates, labels, props
const ROOMS = {
  strategy:  { id:'strategy',  name:'Strategy Room',         occupant:'Orchestrator',         col:0, row:0, kind:'bridge' },
  research:  { id:'research',  name:'Research Lab',          occupant:'Market Research',      col:1, row:0, kind:'analyst' },
  design:    { id:'design',    name:'Design Studio',         occupant:'Designer',             col:2, row:0, kind:'fab' },
  listing:   { id:'listing',   name:'Listing Desk',          occupant:'Copywriter & Publisher', col:0, row:1, kind:'dispatch' },
  cs:        { id:'cs',        name:'CS Booth',              occupant:'Customer Service',     col:1, row:1, kind:'comms' },
  finance:   { id:'finance',   name:'Finance Office',        occupant:'CFO',                  col:2, row:1, kind:'control' },
  silab:     { id:'silab',     name:'Self-Improvement Lab',  occupant:'SI Agent',             col:1, row:2, kind:'rd' },
};

// Initial agent state — what we start the prototype with
const INITIAL_AGENTS = {
  orchestrator: { state:'working', task:'Coordinating',          model:'Sonnet', tokens:2840 },
  research:     { state:'working', task:'web_search etsy trends', model:'Haiku',  tokens:1120 },
  designer:     { state:'working', task:'sdxl render',            model:'Sonnet', tokens:4220 },
  listing:      { state:'idle',    task:'',                       model:'Haiku',  tokens:380  },
  publisher:    { state:'awaiting',task:'pending approval',       model:'Haiku',  tokens:160  },
  cs:           { state:'idle',    task:'',                       model:'Haiku',  tokens:540  },
  cfo:          { state:'working', task:'budget tick',            model:'Haiku',  tokens:90   },
  si:           { state:'paused',  task:'',                       model:'Sonnet', tokens:1980 },
};

// Pre-baked chat threads
const CHAT_HISTORY = {
  designer: [
    { who:'user',  t:'09:14', text:'Push the listing photo to a more handmade ceramic feel — less stock product.' },
    { who:'agent', t:'09:14', text:'On it. Generating three variants with handheld lighting and matte glaze.' },
    { who:'agent', t:'09:21', text:'Variant 2 reads best — soft daylight from camera left, slight grain. Sending to Listing Desk.' },
    { who:'user',  t:'09:23', text:'Save the prompt as a preset called "Daylight Matte" so we can reuse it for the rest of the line.' },
  ],
  research: [
    { who:'user',  t:'08:02', text:'Any new trending tags on Etsy for ceramic mugs this week?' },
    { who:'agent', t:'08:03', text:'"Cottagecore mug", "wabi-sabi pottery", and "irregular handle" all up double-digit week-over-week.' },
    { who:'agent', t:'08:04', text:'Pulling top 20 listings for each — running visual analysis next.' },
  ],
  orchestrator: [
    { who:'user',  t:'07:30', text:'Plan for today?' },
    { who:'agent', t:'07:30', text:'Three new listings, refresh shop banner, reply to 4 open inquiries, and a budget review at 17:00.' },
  ],
};

// Live log fixtures
const LOG_FIXTURES = {
  designer: [
    { t:'09:24:08', tag:'tool',  kind:'tool',  msg:'sdxl_render(prompt="ceramic mug, daylight matte…")' },
    { t:'09:24:02', tag:'llm',   kind:'llm',   msg:'sonnet → 412 tokens · "rendered variant 2 best"' },
    { t:'09:23:51', tag:'tool',  kind:'tool',  msg:'image_compare(a=v1, b=v2, c=v3)' },
    { t:'09:23:30', tag:'event', kind:'event', msg:'handoff received from research · brief.json' },
    { t:'09:23:11', tag:'tool',  kind:'tool',  msg:'sdxl_render(prompt="…", seed=4912)' },
    { t:'09:22:48', tag:'tool',  kind:'tool',  msg:'sdxl_render(prompt="…", seed=4911)' },
    { t:'09:22:18', tag:'tool',  kind:'tool',  msg:'sdxl_render(prompt="…", seed=4910)' },
    { t:'09:21:50', tag:'llm',   kind:'llm',   msg:'sonnet → 880 tokens · prompt rewrite' },
    { t:'09:14:02', tag:'event', kind:'event', msg:'user msg received' },
  ],
  research: [
    { t:'09:24:11', tag:'tool',  kind:'tool',  msg:'web_search("etsy ceramic mug trends 2026")' },
    { t:'09:23:50', tag:'tool',  kind:'tool',  msg:'fetch_listing(id=42810)' },
    { t:'09:23:22', tag:'llm',   kind:'llm',   msg:'haiku → 240 tokens · summarize page' },
    { t:'09:23:00', tag:'tool',  kind:'tool',  msg:'fetch_listing(id=42807)' },
  ],
  orchestrator: [
    { t:'09:23:30', tag:'event', kind:'event', msg:'dispatched: research → designer (handoff)' },
    { t:'09:22:00', tag:'llm',   kind:'llm',   msg:'sonnet → 1.2k tokens · daily plan revision' },
    { t:'09:18:45', tag:'event', kind:'event', msg:'budget tick: $4.20 / $10.00 (42%)' },
  ],
  cfo: [
    { t:'09:24:00', tag:'event', kind:'event', msg:'budget tick: $4.20 / $10.00' },
    { t:'09:23:00', tag:'event', kind:'event', msg:'budget tick: $4.16 / $10.00' },
    { t:'09:22:00', tag:'event', kind:'event', msg:'budget tick: $4.11 / $10.00' },
  ],
  publisher: [
    { t:'09:24:18', tag:'event', kind:'event', msg:'gate.requested: publish_listing#41 (awaiting user)' },
    { t:'09:24:10', tag:'tool',  kind:'tool',  msg:'etsy_draft_listing(id=41)' },
  ],
  listing: [
    { t:'09:20:00', tag:'event', kind:'event', msg:'job.completed: copy_v3 → handed to publisher' },
  ],
  cs: [
    { t:'09:14:18', tag:'event', kind:'event', msg:'inbox empty · idle' },
  ],
  si: [
    { t:'08:55:01', tag:'event', kind:'event', msg:'paused by user' },
    { t:'08:54:50', tag:'tool',  kind:'tool',  msg:'eval_patch(id=p-0119) → score 0.62' },
    { t:'08:54:00', tag:'llm',   kind:'llm',   msg:'sonnet → 2.1k tokens · regression diff' },
  ],
};

const QUEUE_FIXTURES = {
  designer: [
    { status:'running', title:'Render listing photo · "Daylight Matte"', time:'2m', cost:'$0.42' },
    { status:'queued',  title:'Banner refresh · ceramic line',           time:'—',  cost:'~$0.20' },
    { status:'done',    title:'Variant grid · 4 mugs',                   time:'8m', cost:'$0.66' },
    { status:'done',    title:'Mood board update',                       time:'14m', cost:'$0.08' },
  ],
  research: [
    { status:'running', title:'Trend pull · ceramic mugs',  time:'1m', cost:'$0.04' },
    { status:'queued',  title:'Competitor pricing scan',    time:'—',  cost:'~$0.12' },
    { status:'done',    title:'Top tags this week',         time:'22m', cost:'$0.09' },
  ],
  orchestrator: [
    { status:'running', title:'Daily plan · 2026-05-08',    time:'live', cost:'$0.18' },
    { status:'done',    title:'Handoff: research→designer', time:'1m',   cost:'$0.02' },
  ],
  cfo: [
    { status:'running', title:'Budget tick (60s)',          time:'live', cost:'$0.00' },
  ],
  publisher: [
    { status:'queued',  title:'Publish listing #41 · awaiting approval', time:'—', cost:'~$0.01' },
  ],
  listing: [
    { status:'done',    title:'Copy v3 · ceramic mug',      time:'4m', cost:'$0.05' },
  ],
  cs: [
    { status:'done',    title:'Reply: shipping inquiry',    time:'46m', cost:'$0.02' },
  ],
  si: [
    { status:'queued',  title:'Patch p-0119 (paused)',      time:'—', cost:'—' },
  ],
};

// Ticker fixtures — looped continuously
const TICKER_FIXTURES = [
  { role:'cfo',          msg:'budget OK · $4.20 / $10.00 (42%)' },
  { role:'designer',     msg:'rendered listing photo "Daylight Matte" · variant 2 selected' },
  { role:'orchestrator', msg:'dispatched handoff · research → designer' },
  { role:'research',     msg:'top tags up 18% w/w · cottagecore, wabi-sabi, irregular handle' },
  { role:'publisher',    msg:'gate requested · publish_listing#41 awaiting approval' },
  { role:'cs',           msg:'inbox empty · 3 replies sent earlier' },
  { role:'si',           msg:'paused by user · 28m' },
  { role:'designer',     msg:'sdxl_render seed=4912 · 14.3s' },
  { role:'cfo',          msg:'haiku call · 90 tokens · $0.0009' },
  { role:'orchestrator', msg:'spawning specialist: Mockup Artist (transient)' },
  { role:'research',     msg:'fetch_listing batch 20 → done in 6.1s' },
  { role:'guardian',     msg:'rate limit window OK · 41 / 100 calls' },
];

// Alert fixtures
const ALERTS = [
  { kind:'warn', title:'Publisher awaiting approval',  sub:'publish_listing#41 — held at gate', time:'2m ago' },
];

// Gate fixture — what shows in the gate-pending modal
const GATE = {
  agent: 'publisher',
  action: 'publish_listing',
  title: 'Publish listing #41 — "Wabi-Sabi Ceramic Mug, Daylight Matte"',
  rationale: 'Listing meets all draft checks. Photo variant 2 approved by Designer. Tags pulled from this week\'s top trending. Price $34, COGS $11, margin 68%. Held at gate per project rule "publishing requires user approval".',
  payload: {
    title: 'Wabi-Sabi Ceramic Mug · Daylight Matte · Handmade',
    price_usd: 34,
    quantity: 12,
    tags: ['cottagecore mug', 'wabi-sabi', 'handmade ceramic', 'irregular handle', 'matte glaze'],
    primary_image: 'render_v2.png',
    shop: 'sandbox-etsy-001',
  }
};

window.FACTORY_DATA = { ROLES, ROOMS, INITIAL_AGENTS, CHAT_HISTORY, LOG_FIXTURES, QUEUE_FIXTURES, TICKER_FIXTURES, ALERTS, GATE };
