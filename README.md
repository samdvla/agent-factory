# agent-factory

A self-running desktop "factory" of AI agents that designs 3D-printable
character models and lists them on online marketplaces — all on autopilot.

It's a [Tauri](https://tauri.app) desktop app: a Rust backend, a React
frontend, and a crew of Python "worker" agents (research, designer,
publisher, and more) coordinated by a supervisor. You bring your own API
keys; the factory does the rest.

---

## Prerequisites

You need three things installed. The app handles everything else.

| Tool | Why | Install |
|------|-----|---------|
| **Node.js 18+** | Builds the frontend | <https://nodejs.org> |
| **Rust** (stable) | Builds the Tauri backend | <https://rustup.rs> |
| **uv** | Runs the Python agent workers (it installs Python 3.11+ and worker dependencies automatically — you don't manage virtualenvs) | <https://docs.astral.sh/uv/> |

On macOS you also need the Xcode Command Line Tools (`xcode-select --install`).
On Linux, install the [Tauri system dependencies](https://tauri.app/start/prerequisites/).

## Run it (from source)

```sh
git clone <this-repo-url>
cd agent-factory
bash scripts/setup.sh    # installs frontend deps + builds each worker's venv
npm run tauri dev
```

`scripts/setup.sh` runs `npm install` and then `uv sync` for every Python
worker — each worker gets its own isolated virtualenv, and the app launches
each one through that venv. Run it once after cloning; re-running is safe.

The window opens with **no API keys configured** — that's expected. Click the
gear icon to open **Settings** and paste in your own keys. See
[`docs/SETUP.md`](docs/SETUP.md) for exactly which keys you need and where to
get each one.

Your keys are stored in your operating system's secure store (macOS Keychain /
Windows Credential Manager / Linux libsecret). **They are never written to the
repo** — so the project is safe to clone, fork, and share.

## Build a shareable app

```sh
npm run tauri build
```

This produces a native installer/bundle in
`src-tauri/target/release/bundle/`. Send that to a friend — they install it,
open Settings, and enter their own keys. (macOS builds are unsigned, so the
first launch needs right-click → Open to get past Gatekeeper.)

## API keys — bring your own

Nothing in this repo contains a key. The minimum to get the factory producing:

- **An Anthropic API key** — the brain behind every agent.
- **An image-generation key + one 3D-mesh provider key** — to actually create models.

Marketplace publishing (Etsy, Cults3D, MyMiniFactory, Sketchfab, Gumroad,
Printify, Pinterest) is **all optional** — enable only the ones you sell on.

Full step-by-step guide: **[`docs/SETUP.md`](docs/SETUP.md)**.

## Project layout

```
src/         React frontend (the "factory floor" UI)
src-tauri/   Rust backend — supervisor, marketplace integrations, secret store
workers/     Python agent workers, one self-contained uv project each
docs/        Setup and design docs
scripts/     Headless-server deploy scripts
```

## Tests

```sh
npm test                              # frontend
cd src-tauri && cargo test            # Rust backend
cd workers/<name> && uv run pytest    # a single Python worker
```

## Troubleshooting

**A worker fails with "couldn't reach the Claude API" / a timeout.**
Check your Anthropic API key in Settings and your internet connection. If you
configured an Anthropic *bridge* (Settings → Advanced), the bridge overrides
the direct key — make sure the bridge host is actually online.

**The window opens but nothing happens.**
Open Settings and confirm at least an Anthropic key is set. Worker activity
shows in the live log panel.
