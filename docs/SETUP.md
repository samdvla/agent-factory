# Setup — getting your API keys

agent-factory ships with **no credentials**. Every key below is something
*you* create on the provider's site and paste into the app's **Settings**
panel (gear icon). Keys are saved to your OS keychain — never to the repo.

There are three tiers. Start at the top; only the first two are needed to
get the factory running.

---

## 1. Required — the agents' brain

| Setting | What it does | Where to get it |
|---------|--------------|-----------------|
| **Anthropic API key** | Powers every agent (research, design, listing copy, strategy…). Without it, nothing runs. | <https://console.anthropic.com> → API keys. Starts with `sk-ant-`. |

Paste it into **Settings → Anthropic API key**. That's the one mandatory key.

> **Budget caps.** Settings also has hourly / daily / monthly USD caps
> (defaults: $0.50 / $1.00 / $20.00). The factory stops spending when a cap
> is hit. Raise or lower them before letting it run unattended.

## 2. Required to produce models — image + 3D mesh

The designer renders a reference image, then converts it to a 3D mesh. You
need **one image key** and **one mesh provider**.

| Setting | What it does | Where to get it |
|---------|--------------|-----------------|
| **Gemini image key** | Renders the reference image the mesh is built from | <https://aistudio.google.com/apikey> |
| **Tripo** *or* **Meshy** | Turns the image into a GLB + STL mesh. Pick one — they're interchangeable. | Tripo: <https://platform.tripo3d.ai> → API → keys · Meshy: <https://meshy.ai> → Settings → API |

In **Settings → 3D generation**, enter whichever provider you chose and click
**Verify** (it confirms the key and reads your credit balance).

## 3. Optional — marketplace publishing

Enable only the marketplaces you actually sell on. Each is off until you add
its credentials and toggle it on in Settings.

| Marketplace | Credentials needed | Where to get them |
|-------------|--------------------|-------------------|
| **Etsy** | Keystring + shared secret (then an in-app OAuth connect) | <https://www.etsy.com/developers> |
| **Cults3D** | Username (your profile NICK) + API key | <https://cults3d.com/en/api/keys> |
| **MyMiniFactory** | Client ID + client secret (OAuth) | <https://www.myminifactory.com/settings/developer> |
| **Sketchfab** | API token | sketchfab.com → Settings → Password → API |
| **Gumroad** | Access token | gumroad.com → Settings → Advanced → Create access token |
| **Printify** (print-on-demand) | Personal access token | printify.com → Settings → Connections |
| **Pinterest** | Access token (`pins:write` + `boards:read`) + numeric board id | <https://developers.pinterest.com> |
| **GitHub asset hosting** | A repo (`owner/name`) + a token with `contents:write` | github.com → Settings → Developer settings → tokens |

## Optional — Anthropic bridge (advanced)

If you run a proxy in front of the Anthropic API, set **Settings → Advanced →
Bridge URL** and **Bridge key**. When both are set they **override** the
direct Anthropic key, and all workers route through the bridge instead.

Most users leave this blank. Only use it if you know you need it — and if the
bridge host ever goes offline, every worker will fail with a connection
timeout until you either bring it back or clear these fields.

---

## First run checklist

1. `bash scripts/setup.sh` (once — installs frontend deps + each worker's venv)
2. `npm run tauri dev`
3. Open **Settings** (gear icon).
3. Paste your **Anthropic API key**.
4. Add a **Gemini image key** and **one** of Tripo / Meshy → **Verify**.
5. (Optional) Add credentials for any marketplace you want to publish to.
6. Set your **budget caps** to numbers you're comfortable with.
7. Close Settings and start the factory.

## Where keys are stored

- **Release builds:** your OS keychain (`com.agentfactory.app` service).
- **Dev builds (`tauri dev`):** `~/.agent-factory/secrets.dev.json`, created
  with `0600` permissions. This file is gitignored — it never enters the repo.

To wipe all stored keys, delete that file (dev) or remove the
`com.agentfactory.app` entries from your keychain (release).
