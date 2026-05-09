# Factory Floor — Asset Sources & Visual References

Companion to `factory-floor-design-brief.md`. Two parts: **what to look at for visual direction**, and **the locked asset stack**.

---

## Part 1 — Visual reference touchstones

These are the games to study for camera, density, readability, and animation principles. Not for copying the art.

| Reference | Why it's relevant |
|---|---|
| **Two Point Hospital** | Gold standard for isometric workplace simulation. Rooms read instantly, staff animations communicate state, color tells you what's broken. |
| **Project Highrise** | Tighter, building cross-section; useful for "side-scroll if we ever go vertical" thinking. |
| **Rollercoaster Tycoon (classic)** | Original isometric workplace feel. Sprite economy — small characters, big personality through silhouette and motion only. |
| **Mini Metro / Mini Motorways** | Not isometric, but reference for *operational dashboard wearing a calm skin* — what we want emotionally. |
| **Hypnospace Outlaw** | Reference for "interface as a place" rather than "interface as panels." |
| **Citizen Sleeper** | Mood reference — calm, considered, slightly lonely sci-fi facility vibe. |

Avoid: Stardew Valley (too cute), The Sims (too lived-in), Fallout Shelter (too gamified), any Cookie Clicker descendant.

---

## Part 2 — Locked asset stack ✅

**DECIDED.** Path C, Quaternius edition.

### The stack

| Layer | Source | Format | License | Cost |
|---|---|---|---|---|
| **Rooms, walls, doors, props** | Quaternius — *Ultimate Modular Sci-Fi* (Feb 2021) | **FBX** (downloaded) | CC0 — no attribution required | $0 |
| **Characters (humanoids)** | Mixamo (Adobe) | FBX with skeletal rig + animations | Free, commercial OK | $0 |
| **Animations** | Mixamo library | FBX | Free, commercial OK | $0 |
| **Filler / specialty props** | Quaternius other CC0 packs (Ultimate Stylized Nature, Ultimate Animated Character Pack, etc.) or Sketchfab CC0 | FBX or glTF | CC0 / case-by-case | $0 |
| **Renderer** | Three.js with orthographic camera | n/a | MIT | $0 |

**Total asset cost: $0.** Everything CC0 or commercial-OK free.

### Aesthetic shift this implies

Going Quaternius Ultimate Modular Sci-Fi means the factory floor reads as a **near-future research facility / operations center**, not a contemporary office. This actually fits the brief better than literal cubicles — agents are AIs running a digital business, sci-fi facility lands on the right side of "operational vibe."

Update mental model when designing rooms:
- "Strategy Room" → command bridge / situation room.
- "Research Lab" → analyst station with terminals and data wall.
- "Design Studio" → fabrication bay with screens and design tooling.
- "Listing Desk" → broadcast console / dispatch.
- "CS Booth" → comms station with headset.
- "Finance Office" → resource control room with monitors.
- "Self-Improvement Lab" → R&D bay with experimental rigs.

The Etsy domain still works — the metaphor is "your shop is being run from a sci-fi facility," which is honestly more interesting than a literal cubicle farm.

### Pipeline notes (for `frontend-design`)

1. **FBX is fine for direct Three.js use.** Three.js has built-in `FBXLoader`. No conversion strictly needed.
2. **Optional optimization:** if load time matters, batch-convert FBX → glTF (.glb) using Blender (script export) or `FBX2glTF` CLI. glTF is smaller and parses faster in browsers. Defer this until perf tells us we need it.
3. **Mixamo characters** are FBX. Drop them into the same scene; align scale to the Quaternius props (Mixamo characters are usually meters, Quaternius rooms are too — should match without scaling).
4. **Texture handling:** Quaternius uses simple flat-color materials, often single-texture atlases. Three.js renders these cleanly with `MeshStandardMaterial` or `MeshBasicMaterial` for the unlit cartoon look.
5. **Camera:** orthographic, fixed angle (~30° down, ~45° rotation) for the iso look. No perspective.
6. **Performance budget:** scene has 7 rooms × ~20 props each = ~140 static meshes + 7–10 animated characters. Comfortable for any modern browser; instance the props for safety.

### Avatar customization with Mixamo

Each agent role gets a distinct Mixamo character (the library has plenty). Map roles to silhouettes:
- **Orchestrator** — authoritative posture, longer coat
- **Research Analyst** — slim, headset-friendly
- **Designer** — relaxed, slightly artsy
- **Listing Copywriter / Publisher** — neutral office worker
- **CS** — friendly stance
- **CFO** — formal
- **SI Lab** — lab-coat type
- **Guardian** — armored / security archetype (off-floor)

Per-role accent color applied as a tinted glow ring under the feet OR as a recolored vest on the character — both options live in Three.js material space, no asset re-export needed.

### Animation set (pull from Mixamo)

| State | Mixamo animation candidate |
|---|---|
| Idle | "Standing Idle", "Idle 02" |
| Working | "Typing", "Looking Around" |
| Walking (handoff) | "Walking" |
| Awaiting input | "Look Around" with question-mark sprite overlay |
| Paused | "Sleeping Idle" |
| Crashed | Static T-pose with red vignette + exclamation sprite |
| Killed | Avatar removed; empty desk |

Mixamo has hundreds of animations — pick once, reuse across all characters since the rig is shared.

---

## Alternative paths (kept for reference, not chosen)

These are kept here only so the decision is documented and reversible if Quaternius doesn't work out in P1.

- **Synty POLYGON Office** ($46 one-time, or $30/mo subscription for 130+ packs). More office-authentic, costs money, more cubicle-y. Links: [Synty store](https://syntystore.com/products/polygon-office-pack), [Unity Asset Store](https://assetstore.unity.com/packages/3d/props/interior/polygon-office-pack-art-by-synty-159492), [Unreal Marketplace](https://www.unrealengine.com/marketplace/en-US/product/polygon-office-pack).
- **2D isometric sprite packs** (Kenney CC0, itch.io paid). Simpler runtime, less flexible for new agent roles.
- **Top-down 2D** (LimeZu Modern Interiors). Best ratio of office-aesthetic to art-quality, but loses the isometric workplace-cutaway feel.
- **AI-generated** (Scenario.gg, LoRA-locked). Style drift makes this expensive in time. Revisit for one-off specialist designs after base aesthetic is locked.

---

## License recap (the chosen stack is bulletproof)

- **Quaternius (CC0):** use anywhere, modify, sell, no attribution required. The cleanest license possible.
- **Mixamo (Adobe):** free for any use including commercial, including in shipped products. No attribution required. (Adobe ToS does say accounts must be in good standing.)
- **Three.js (MIT):** standard MIT, no concerns.

No license tracking, no royalty splits, no attribution screens needed. Ship freely.
