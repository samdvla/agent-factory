# Factory Floor — Design Brief for `frontend-design`

This is the visual brief for **P1: Factory Floor UI** of the multi-agent terminal app. Backend details intentionally left out — only what the design layer needs.

Full spec lives at: `~/docs/superpowers/specs/2026-05-08-multi-agent-terminal-design.md`

---

## 1. The product in one paragraph

A standalone desktop app that runs a team of AI agents 24/7 to pursue a goal (first goal: run a fully-digital Etsy shop). The main view is a **virtual workplace seen from a fixed camera** — an isometric "factory floor" where each agent has a dedicated room. Avatars work at desks, walk to other rooms when collaborating, and visually mirror real backend state (working / idle / paused / crashed). This is an operations dashboard wearing a workplace skin — not a game.

## 2. Visual direction

- **Camera:** isometric 2.5D, rendered from a 3D scene through an orthographic camera. Reference vibe: *Two Point Hospital*, *Project Highrise*, *Rollercoaster Tycoon* — readable, not cute.
- **Mood:** professional, slightly playful, calm. Not gamified, not corporate-flat. The chosen asset stack puts us in **near-future research facility / operations center** territory rather than literal cubicles — leans into the "AI agents running a digital business from a sci-fi facility" feel.
- **Avatars:** Mixamo humanoid characters with skeletal animations. One distinct character archetype per agent role; per-role accent color applied via material tint or under-foot glow ring.
- **Tone:** every animation should mean something. Movement = real event. No idle decorative bouncing.

## 3. Screen layout

```
┌───────────────────────────────────────────────────────────────┐
│  TOP BAR                                                      │
│  [project ▾]   budget bar █████░░░░░ $4.20/$10   ⚠ 1 alert    │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│                                                               │
│              FACTORY FLOOR (isometric, primary)               │
│                                                               │
│   ┌───────────┐  ┌───────────┐  ┌───────────┐                 │
│   │ Strategy  │  │ Research  │  │ Design    │                 │
│   │   Room    │  │   Lab     │  │  Studio   │                 │
│   └───────────┘  └───────────┘  └───────────┘                 │
│   ┌───────────┐  ┌───────────┐  ┌───────────┐                 │
│   │ Listing   │  │ CS Booth  │  │ Finance   │                 │
│   │   Desk    │  │           │  │  Office   │                 │
│   └───────────┘  └───────────┘  └───────────┘                 │
│              ┌───────────┐                                    │
│              │ SI Lab    │                                    │
│              └───────────┘                                    │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│  TICKER  ▸ CFO: budget OK $4.20/$10  •  Designer: rendered…   │
└───────────────────────────────────────────────────────────────┘

  Click an avatar → SIDE DRAWER slides in from the right
  ┌──────────────────────┐
  │  Designer            │
  │  ─────────────────── │
  │  [chat panel]        │
  │  [live log tail]     │
  │  [job queue]         │
  │  [pause/kill/restart]│
  │  [model override]    │
  └──────────────────────┘
```

## 4. Rooms (7 total in v1)

Each room has at least one workstation plus thematic props that hint at function. Rooms can be hovered for a tooltip ("Research Lab — Market Research Analyst"). With the sci-fi modular asset pack, rooms read as a near-future facility — bridge / lab / fabrication bay vibe rather than office furniture.

| Room | Occupants | Sci-fi flavor / props |
|---|---|---|
| Strategy Room | Orchestrator | Command bridge — central holo-table, large data wall, ringed seating |
| Research Lab | Market Research Analyst | Analyst station — dual terminals, scrolling data wall, samples on shelves |
| Design Studio | Designer (+ Mockup Artist when spawned) | Fabrication bay — design tablet rig, mood-board wall, small printer/3D-fab unit |
| Listing Desk | Listing Copywriter, Publisher | Dispatch console — broadcast monitors, outbound tray, comms array |
| CS Booth | Customer Service (+ Dispute Negotiator when spawned) | Comms station — headset, chat windows on wall screens, hold-music indicator |
| Finance Office | CFO | Resource control room — ledger displays, budget gauge, secure terminal |
| Self-Improvement Lab | Self-Improvement Lab agent | R&D bay — experimental rigs, code on screens, server rack, holo-models of patches |

The Guardian agent is **off-floor** — it appears as a small icon near the supervisor status indicator, not in a room.

## 5. Avatar state machine

The whole point of the visual layer: state must be readable at a glance.

| State | Visual | When |
|---|---|---|
| Idle | Standing/sitting at desk, occasional yawn or stretch | No active job |
| Working | Typing animation, faint glow on monitor, status bubble shows current tool call (e.g. "🖼 sdxl render") | Job in progress |
| Walking (handoff) | Avatar moves between rooms carrying a colored doc-sprite | Handoff event fires |
| Awaiting input | "?" speech bubble, gentle pulse | Agent paused waiting for user reply |
| Paused (manual) | "Z" sleep animation | User hit Pause |
| Crashed | Red exclamation mark, room dimmed, restart countdown overlay | Worker died, supervisor backing off |
| Killed (manual) | Empty desk, slight gray tint on the room | User hit Kill |
| Quarantined | Yellow caution tape across desk | Agent has crashed too many times |

Specialists (spawned dynamically) appear with a brief "puff of smoke" entrance animation when they materialize, and walk off-screen when killed.

## 6. Side drawer (clicked avatar)

Slides in from the right, dims the floor behind it. Four stacked sections:

1. **Header** — avatar portrait, role name, current state pill ("Working" / "Idle" / etc.), today's token spend, model tier badge.
2. **Chat panel** — conversation between user and this specific agent. Threaded, scrollable. Input box at bottom.
3. **Live log** — tail of the last ~50 events for this agent (tool calls, LLM calls, errors). Each line collapsed to one row, click to expand.
4. **Queue** — table of jobs (queued / running / done in last hour). Click a job to open the artifact.
5. **Controls** — Pause / Resume / Kill / Restart buttons. Model override dropdown (Haiku / Sonnet / Opus / default).

## 7. Top bar (always visible)

| Element | Behavior |
|---|---|
| Project selector | Dropdown of active projects (Etsy is the first; goal-agnostic later). |
| Budget bar | Horizontal bar showing today's token spend / cap. Color shifts amber > 70%, red > 90%. |
| Live spend counter | "$4.20 today" — ticks up in real time. |
| Alert pill | Number of unread alerts. Click → slide-down alert tray. |
| All Stop button | Big, slightly intimidating. Confirmation modal before firing. |

## 8. Ticker (bottom dock)

One-line scrolling feed of significant events. Each line:
- Timestamp (relative: "2s ago")
- Source agent (color-coded)
- Event summary

Click any line → camera pans to the source room and pulses that avatar.

## 9. Special states (full-screen overlays)

- **Sandbox mode banner** — when running against the mock Etsy adapter, a striped diagonal banner across the top: "SANDBOX — no real listings, no real money." Persistent until disabled.
- **All Stop active** — entire floor desaturates to grayscale; resume button center-screen.
- **Onboarding wizard** — modal sequence for first-time setup (API keys, Etsy seller account walkthrough, OAuth). Steps render over a dimmed factory floor preview so the user can see what they're building toward.
- **Gate-pending action** — when a gate fires, the relevant avatar holds up a clipboard sprite. Top bar shows a yellow "1 awaiting approval" pill. Click → modal showing the action, payload, rationale, and Approve/Reject buttons.

## 10. Tech stack constraints

- **Shell:** Tauri (Rust core + web frontend).
- **Frontend stack:** open — recommend React or Svelte. Whatever the design skill prefers, justify briefly.
- **Rendering: Three.js with an orthographic camera.** Locked — see asset-sources companion file.
  - Scene built from Quaternius *Ultimate Modular Sci-Fi* FBX assets (rooms, walls, props).
  - Characters from Mixamo (humanoid rig, FBX), animations pulled from the Mixamo library.
  - Camera fixed at iso angle (~30° down, ~45° rotation), no perspective.
  - Three.js loaders: `FBXLoader` direct, or pre-converted `.glb` via Blender / FBX2glTF if perf demands.
- **Realtime:** UI listens for events on a Tauri event channel. Treat as a stream of typed events (`agent.state_changed`, `agent.tool_call`, `job.handoff`, `gate.requested`, `budget.tick`, etc.).
- **Persistence not required client-side** — the supervisor owns state; UI is a thin reader.

## 11. P1 deliverables, in priority order

1. **Static factory-floor scene.** All seven rooms laid out, props placed, avatars rendered in idle state. No interactivity. This is the screenshot you'd show someone to convey the concept.
2. **State machine integration.** Idle / Working / Walking / Paused / Crashed visualized. Driven by a mocked event stream so it can be developed without the backend ready.
3. **Side drawer + chat + log + controls.** Wired to the same mocked event stream.
4. **Top bar + ticker.** Budget bar, alert pill, ticker scrolling.
5. **Special states.** Sandbox banner, All Stop overlay, gate-pending modal.
6. **Onboarding wizard.** Multi-step modal flow.

Ship 1–4 as a runnable demo first, then 5–6 as a follow-up.

## 12. Style guardrails — what to avoid

- **No generic AI-dashboard aesthetics.** No purple-to-blue gradients on every card. No soft glassmorphism. No "Gemini-style" sparkle icons.
- **No game-y excess.** No pixel-art floating coins, no XP bars, no level-ups. We are not building Stardew Valley.
- **No motion for motion's sake.** Every animation must correspond to a real event.
- **No confusing density.** The factory floor should breathe — empty rooms are fine. The eye should find the active rooms first.
- **Typography:** humanist sans for UI chrome (the cool calm of an ops console). Avoid display fonts.
- **Color:** neutral floor and walls; agents are the source of color. Each role gets a signature accent that ties their avatar, their handoff doc, and their event color in the ticker.

## 13. Asset sourcing — locked

See `factory-floor-asset-sources.md` for full details. Summary:

- **Rooms / props:** Quaternius — *Ultimate Modular Sci-Fi* (Feb 2021), FBX format. CC0, free, downloaded.
- **Characters:** Mixamo humanoids. Free, commercial OK.
- **Animations:** Mixamo library (Idle, Typing, Walking, Sleeping Idle, etc.). Free.
- **Renderer:** Three.js, orthographic camera.

Total asset cost: $0. No attribution required, no licensing tracking. Aesthetic shifts from "modern office" to "near-future research facility / operations center" — rooms read as labs, bridges, and fabrication bays rather than cubicles.

## 14. What success looks like

Open the app cold. Within five seconds of looking at the screen, you can answer:
- Which agents are working right now?
- Which are idle?
- Is anything broken?
- How much money has the system spent today?
- Is there anything waiting on me?

If those five answers aren't immediate, the design has failed regardless of how nice it looks.
