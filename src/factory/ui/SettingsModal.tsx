import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type EtsyStatus, type GumroadBackfillResult } from "../../api";
import { hirePrintifyOperator, dissolvePrintifyOperator } from "../../hooks/usePrintifyOperator";
import { useFactoryStore } from "../state/factoryStore";
import { ISO_THEMES, ISO_THEME_NAMES, mapAppThemeToIso } from "../svg/iso/themes";
import type { IsoThemeName } from "../state/types";
import {
  getRemoteConfig,
  setRemoteConfig,
  remoteHealthCheck,
  type RemoteConfig,
} from "../../remote";

/* ------------------------------------------------------------------ */
/*  Types                                                                */
/* ------------------------------------------------------------------ */

type SaveState = "idle" | "saving" | "saved" | "error";

interface CredRowState {
  isSet: boolean;
  preview: string | null; // "sk-ant-…vOLy" style, null if not set
  editing: boolean;
  draft: string;
  saveState: SaveState;
  saveError: string | null;
  validationError: string | null;
  showPreview: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                              */
/* ------------------------------------------------------------------ */

function maskPreview(value: string | null): string | null {
  if (!value || value.length < 8) return null;
  return value.slice(0, 7) + "…" + value.slice(-4);
}

function makeInitialCredRow(): CredRowState {
  return {
    isSet: false,
    preview: null,
    editing: false,
    draft: "",
    saveState: "idle",
    saveError: null,
    validationError: null,
    showPreview: false,
  };
}

/* ------------------------------------------------------------------ */
/*  SaveFeedback: inline "Saved" / error badge that auto-clears          */
/* ------------------------------------------------------------------ */

function SaveFeedback({ state, error }: { state: SaveState; error: string | null }) {
  if (state === "saving") {
    return <span className="settings-feedback is-saving">Saving…</span>;
  }
  if (state === "saved") {
    return <span className="settings-feedback is-saved">Saved</span>;
  }
  if (state === "error") {
    return <span className="settings-feedback is-error">{error ?? "Save failed"}</span>;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  CredentialRow                                                         */
/* ------------------------------------------------------------------ */

interface CredRowProps {
  label: string;
  placeholder: string;
  secretKey: string;
  validate?: (v: string) => string | null; // returns error string or null
  onSaveSuccess: () => void;
  helperText?: string;
}

function CredentialRow({ label, placeholder, secretKey, validate, onSaveSuccess, helperText }: CredRowProps) {
  const [state, setState] = useState<CredRowState>(makeInitialCredRow());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load presence on mount
  useEffect(() => {
    let cancelled = false;
    api.getSecret(secretKey).then((v) => {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        isSet: !!v,
        preview: maskPreview(v ?? null),
      }));
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretKey]);

  const openEdit = () => setState((s) => ({ ...s, editing: true, draft: "", validationError: null }));
  const cancelEdit = () => setState((s) => ({ ...s, editing: false, draft: "", validationError: null }));

  const save = async () => {
    const trimmed = state.draft.trim();
    if (!trimmed) {
      setState((s) => ({ ...s, validationError: "Value cannot be empty" }));
      return;
    }
    if (validate) {
      const err = validate(trimmed);
      if (err) {
        setState((s) => ({ ...s, validationError: err }));
        return;
      }
    }
    setState((s) => ({ ...s, saveState: "saving", saveError: null, validationError: null }));
    try {
      await api.setSecret(secretKey, trimmed);
      // Re-check presence for badge update
      const stored = await api.getSecret(secretKey);
      setState((s) => ({
        ...s,
        saveState: "saved",
        editing: false,
        draft: "",
        isSet: !!stored,
        preview: maskPreview(stored ?? null),
      }));
      onSaveSuccess();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => setState((s) => ({ ...s, saveState: "idle" })),
        1500
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, saveState: "error", saveError: msg }));
    }
  };

  // Dismiss on Esc while editing
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") cancelEdit();
    if (e.key === "Enter") save();
  };

  return (
    <div className="settings-cred-row">
      <div className="settings-cred-header">
        <span className="settings-cred-label">{label}</span>
        <span className={`settings-badge ${state.isSet ? "is-set" : "is-unset"}`}>
          {state.isSet ? "Set" : "Not set"}
        </span>
        {state.isSet && !state.editing && (
          <button
            type="button"
            className="settings-link"
            onClick={() => setState((s) => ({ ...s, showPreview: !s.showPreview }))}
          >
            {state.showPreview ? "Hide" : "Show"}
          </button>
        )}
        {!state.editing && (
          <button type="button" className="settings-link" onClick={openEdit}>
            Edit
          </button>
        )}
      </div>
      {state.isSet && !state.editing && state.showPreview && state.preview && (
        <div className="settings-cred-preview">{state.preview}</div>
      )}
      {state.editing && (
        <div className="settings-cred-edit">
          <input
            type="password"
            className="settings-input"
            placeholder={placeholder}
            value={state.draft}
            onChange={(e) => setState((s) => ({ ...s, draft: e.target.value, validationError: null }))}
            onKeyDown={onKeyDown}
            autoFocus
          />
          {state.validationError && (
            <div className="settings-inline-error">{state.validationError}</div>
          )}
          <div className="settings-cred-edit-actions">
            <button type="button" className="modal-btn" onClick={cancelEdit}>Cancel</button>
            <button type="button" className="modal-btn approve" onClick={save}>Save</button>
          </div>
        </div>
      )}
      {helperText && <div className="settings-helper">{helperText}</div>}
      <SaveFeedback state={state.saveState} error={state.saveError} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BridgeUrlRow — plain text input for a URL (not a password)          */
/* ------------------------------------------------------------------ */

function BridgeUrlRow() {
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSecret("anthropic_bridge_url").then((v) => {
      if (cancelled) return;
      setDraft(v ?? "");
      setLoaded(true);
    }).catch(() => { setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaveState("saving");
    setSaveError(null);
    try {
      await api.setSecret("anthropic_bridge_url", draft.trim());
      setSaveState("saved");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setSaveState("idle"), 1500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveState("error");
      setSaveError(msg);
    }
  };

  return (
    <div className="settings-budget-row">
      <div className="settings-budget-header">
        <span className="settings-budget-label">Bridge URL</span>
        <div className="settings-budget-input-wrap" style={{ flex: 1, maxWidth: "none" }}>
          <input
            type="text"
            className="settings-input"
            placeholder="http://your-bridge.example:port"
            value={loaded ? draft : ""}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="button" className="modal-btn settings-inline-save" onClick={save}>
            Save
          </button>
        </div>
      </div>
      <SaveFeedback state={saveState} error={saveError} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ThemeSection — picker for app-wide color theme                       */
/* ------------------------------------------------------------------ */

type ThemeId = "claude" | "espresso" | "pine" | "plum" | "midnight" | "linen";

interface ThemeDef {
  id: ThemeId;
  name: string;
  blurb: string;
  swatch: { bg: string; panel: string; accent: string; ink: string };
}

const THEMES: ThemeDef[] = [
  {
    id: "claude",
    name: "Claude",
    blurb: "Parchment + clay",
    swatch: { bg: "#14110d", panel: "#25201b", accent: "#d97757", ink: "#f4ecd8" },
  },
  {
    id: "espresso",
    name: "Espresso",
    blurb: "Coffee + caramel",
    swatch: { bg: "#12100c", panel: "#221c17", accent: "#c79768", ink: "#efe5d0" },
  },
  {
    id: "pine",
    name: "Pine & Brass",
    blurb: "Forest + brass",
    swatch: { bg: "#0e120e", panel: "#1f261f", accent: "#c5a572", ink: "#ecede4" },
  },
  {
    id: "plum",
    name: "Plum & Honey",
    blurb: "Aubergine + honey",
    swatch: { bg: "#14101a", panel: "#26212f", accent: "#d4a574", ink: "#f1ebe1" },
  },
  {
    id: "linen",
    name: "Linen",
    blurb: "Cream + brown ink",
    swatch: { bg: "#f1e9d8", panel: "#ddd2b9", accent: "#b85d3c", ink: "#2b1f12" },
  },
  {
    id: "midnight",
    name: "Midnight",
    blurb: "Cool blue (original)",
    swatch: { bg: "#07090c", panel: "#131a23", accent: "#5fd4f0", ink: "#e6edf3" },
  },
];

const THEME_STORAGE_KEY = "agentFactory.theme";

function getCurrentTheme(): ThemeId {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null;
    if (t && THEMES.some((th) => th.id === t)) return t;
  } catch {}
  return "claude";
}

/* ------------------------------------------------------------------ */
/*  Remote factory (mini server) — phase 1 client mode                   */
/* ------------------------------------------------------------------ */

function RemoteFactorySection() {
  const initial = getRemoteConfig();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [showToken, setShowToken] = useState(false);
  const [testState, setTestState] =
    useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const isActive = !!initial && !!url && !!token;

  const save = (cfg: RemoteConfig | null) => {
    setRemoteConfig(cfg);
    // Force the laptop to pick up the new mode (event subscription routes
    // through Tauri vs SSE at mount time; reload re-runs the hook).
    window.location.reload();
  };

  const onTest = async () => {
    if (!url) return;
    setTestState("testing");
    setTestMsg(null);
    try {
      const cleanUrl = url.replace(/\/+$/, "");
      // 1. /healthz (no auth)
      const h = await fetch(cleanUrl + "/healthz");
      if (!h.ok) throw new Error(`/healthz returned ${h.status}`);
      const txt = (await h.text()).trim();
      if (txt !== "ok") throw new Error(`/healthz body: ${txt}`);
      // 2. /api/status (auth)
      if (!token) {
        setTestState("ok");
        setTestMsg("Reachable. Add a token to verify auth.");
        return;
      }
      const s = await fetch(cleanUrl + "/api/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (s.status === 401) throw new Error("auth failed (401)");
      if (!s.ok) throw new Error(`/api/status returned ${s.status}`);
      const data = (await s.json()) as { running: boolean; project_id: number };
      setTestState("ok");
      setTestMsg(
        `Connected · supervisor ${data.running ? "running" : "idle"} · project ${data.project_id}`
      );
    } catch (e) {
      setTestState("fail");
      setTestMsg(String((e as Error)?.message ?? e));
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Remote factory (mini server)</div>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "6px 0 12px" }}>
        Point this UI at a remote agent-factory mini. When set, status,
        revenue, recent cycles, listings, and the live agent event stream
        all mirror the mini. Leave blank to keep using the local app.
      </p>

      <label
        style={{ display: "block", fontSize: 11, opacity: 0.75, margin: "4px 0 4px" }}
      >
        Server URL
      </label>
      <input
        type="text"
        spellCheck={false}
        placeholder="http://100.110.160.8:7420"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{
          width: "100%",
          padding: "6px 8px",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 4,
          color: "#e8e8e8",
        }}
      />

      <label
        style={{ display: "block", fontSize: 11, opacity: 0.75, margin: "10px 0 4px" }}
      >
        Bearer token
      </label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type={showToken ? "text" : "password"}
          spellCheck={false}
          placeholder="64-char hex from mini's secrets.json"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{
            flex: 1,
            padding: "6px 8px",
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 4,
            color: "#e8e8e8",
          }}
        />
        <button
          type="button"
          onClick={() => setShowToken((v) => !v)}
          style={{
            padding: "6px 10px",
            fontSize: 11,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 4,
            color: "#ccc",
            cursor: "pointer",
          }}
        >
          {showToken ? "Hide" : "Show"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onTest}
          disabled={!url || testState === "testing"}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            background: "rgba(80,180,255,0.18)",
            border: "1px solid rgba(80,180,255,0.36)",
            borderRadius: 4,
            color: "#9ad0ff",
            cursor: url && testState !== "testing" ? "pointer" : "not-allowed",
          }}
        >
          {testState === "testing" ? "Testing…" : "Test connection"}
        </button>
        <button
          type="button"
          onClick={() => save({ url: url.trim(), token: token.trim() })}
          disabled={!url || !token}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            background: "rgba(120,220,140,0.18)",
            border: "1px solid rgba(120,220,140,0.36)",
            borderRadius: 4,
            color: "#a8e8b6",
            cursor: url && token ? "pointer" : "not-allowed",
          }}
        >
          Save + connect (reload)
        </button>
        {isActive && (
          <button
            type="button"
            onClick={() => save(null)}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              background: "rgba(255,140,140,0.14)",
              border: "1px solid rgba(255,140,140,0.36)",
              borderRadius: 4,
              color: "#ffb0b0",
              cursor: "pointer",
            }}
          >
            Disconnect (reload)
          </button>
        )}
      </div>

      {testMsg && (
        <div
          style={{
            marginTop: 10,
            padding: "6px 10px",
            fontSize: 11,
            background:
              testState === "ok"
                ? "rgba(120,220,140,0.12)"
                : testState === "fail"
                ? "rgba(255,140,140,0.12)"
                : "rgba(255,255,255,0.06)",
            border: `1px solid ${
              testState === "ok"
                ? "rgba(120,220,140,0.32)"
                : testState === "fail"
                ? "rgba(255,140,140,0.32)"
                : "rgba(255,255,255,0.12)"
            }`,
            borderRadius: 4,
            color: testState === "fail" ? "#ffb0b0" : "#e8e8e8",
          }}
        >
          {testMsg}
        </div>
      )}

      {isActive && (
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
          Currently connected to: <code>{initial?.url}</code>
        </div>
      )}
    </section>
  );
}

// Quiet the unused-import warning when remoteHealthCheck isn't called above.
void remoteHealthCheck;

function ThemeSection() {
  const [active, setActive] = useState<ThemeId>(getCurrentTheme);
  const setIsoTheme = useFactoryStore((s) => s.setIsoTheme);

  const apply = (id: ThemeId) => {
    setActive(id);
    try {
      document.documentElement.setAttribute("data-theme", id);
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {}
    api.setSecret("ui_theme", id).catch(() => {});
    // Keep the iso room theme aligned with the app theme.
    setIsoTheme(mapAppThemeToIso(id));
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Appearance</div>
      <div className="settings-helper" style={{ marginBottom: 12 }}>
        Theme applies instantly across the whole app and persists across launches.
      </div>
      <div className="theme-grid">
        {THEMES.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`theme-card${isActive ? " is-active" : ""}`}
              onClick={() => apply(t.id)}
              aria-pressed={isActive}
            >
              <div
                className="theme-preview"
                style={{ background: t.swatch.bg, borderColor: t.swatch.panel }}
              >
                <div
                  className="theme-preview-panel"
                  style={{ background: t.swatch.panel }}
                >
                  <span
                    className="theme-preview-bar"
                    style={{ background: t.swatch.accent }}
                  />
                  <span
                    className="theme-preview-line"
                    style={{ background: t.swatch.ink, opacity: 0.85 }}
                  />
                  <span
                    className="theme-preview-line is-short"
                    style={{ background: t.swatch.ink, opacity: 0.45 }}
                  />
                </div>
                <span
                  className="theme-preview-dot"
                  style={{ background: t.swatch.accent }}
                />
              </div>
              <div className="theme-meta">
                <span className="theme-name">{t.name}</span>
                <span className="theme-blurb">{t.blurb}</span>
              </div>
              {isActive && (
                <span className="theme-active-tick" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  IsoThemeSection — picker for factory-floor iso room theme            */
/* ------------------------------------------------------------------ */

const ISO_THEME_BLURBS: Record<IsoThemeName, string> = {
  warm: "Cream parchment + wood floor",
  clinic: "Bright white + cool blue glass",
  night: "Dark slabs + neon glass",
};

function IsoThemeSection() {
  const active = useFactoryStore((s) => s.isoTheme);
  const setIsoTheme = useFactoryStore((s) => s.setIsoTheme);
  return (
    <section className="settings-section">
      <div className="settings-section-title">Factory floor</div>
      <div className="settings-helper" style={{ marginBottom: 12 }}>
        Visual theme for the iso rooms — applies to floors, walls, glass, and
        ambient lighting across every room.
      </div>
      <div className="theme-grid">
        {ISO_THEME_NAMES.map((id) => {
          const t = ISO_THEMES[id];
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              className={`theme-card${isActive ? " is-active" : ""}`}
              onClick={() => setIsoTheme(id)}
              aria-pressed={isActive}
            >
              <div
                className="theme-preview"
                style={{ background: t.sky, borderColor: t.wallTrim }}
              >
                <div
                  className="theme-preview-panel"
                  style={{ background: t.platform, border: `1px solid ${t.wallTrim}` }}
                >
                  <span
                    className="theme-preview-bar"
                    style={{ background: t.wallBack }}
                  />
                  <span
                    className="theme-preview-line"
                    style={{ background: t.floor, opacity: 0.95 }}
                  />
                  <span
                    className="theme-preview-line is-short"
                    style={{ background: t.skirting, opacity: 0.85 }}
                  />
                </div>
                <span
                  className="theme-preview-dot"
                  style={{ background: t.glassFill.replace(/rgba?\(([^)]+)\)/, (_m, inside) => `rgb(${inside.split(",").slice(0, 3).join(",")})`) }}
                />
              </div>
              <div className="theme-meta">
                <span className="theme-name">{id[0].toUpperCase() + id.slice(1)}</span>
                <span className="theme-blurb">{ISO_THEME_BLURBS[id]}</span>
              </div>
              {isActive && (
                <span className="theme-active-tick" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  BudgetRow                                                             */
/* ------------------------------------------------------------------ */

interface BudgetRowProps {
  label: string;
  secretKey: string;
  defaultValue: number;
  helper: string;
}

function BudgetRow({ label, secretKey, defaultValue, helper }: BudgetRowProps) {
  const [draft, setDraft] = useState<string>("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSecret(secretKey).then((v) => {
      if (cancelled) return;
      const num = parseFloat(v ?? "");
      setDraft(Number.isFinite(num) ? String(num) : String(defaultValue));
    }).catch(() => setDraft(String(defaultValue)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretKey, defaultValue]);

  const save = async () => {
    const num = parseFloat(draft);
    if (!Number.isFinite(num) || num <= 0) {
      setValidationError("Must be a number greater than 0");
      return;
    }
    setValidationError(null);
    setSaveState("saving");
    setSaveError(null);
    try {
      await api.setSecret(secretKey, String(num));
      setSaveState("saved");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setSaveState("idle"), 1500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveState("error");
      setSaveError(msg);
    }
  };

  return (
    <div className="settings-budget-row">
      <div className="settings-budget-header">
        <span className="settings-budget-label">{label}</span>
        <div className="settings-budget-input-wrap">
          <span className="settings-budget-prefix">$</span>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={draft}
            min={0.01}
            step={0.01}
            onChange={(e) => { setDraft(e.target.value); setValidationError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          />
          <button type="button" className="modal-btn settings-inline-save" onClick={save}>
            Save
          </button>
        </div>
      </div>
      {validationError && <div className="settings-inline-error">{validationError}</div>}
      <div className="settings-helper">{helper}</div>
      <SaveFeedback state={saveState} error={saveError} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PrintifySection: enter PAT, verify, shows connected Etsy shop        */
/* ------------------------------------------------------------------ */

function PrintifySection() {
  const [keyDraft, setKeyDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    keyPresent: boolean;
    shopId: number | null;
    shopTitle: string | null;
    podEnabled: boolean;
  }>({ keyPresent: false, shopId: null, shopTitle: null, podEnabled: false });

  useEffect(() => {
    api.printifyStatus().then((s) => {
      setStatus({
        keyPresent: s.key_present,
        shopId: s.shop_id,
        shopTitle: null,
        podEnabled: s.pod_enabled,
      });
    }).catch(() => {});
  }, []);

  const handleVerify = async () => {
    if (!keyDraft.trim()) return;
    setVerifyState("verifying");
    setVerifyError(null);
    try {
      const result = await api.printifyVerify(keyDraft.trim());
      setVerifyState("ok");
      setStatus((s) => ({
        ...s,
        keyPresent: true,
        shopId: result.shop_id,
        shopTitle: result.shop_title,
      }));
      setKeyDraft("");
    } catch (e) {
      setVerifyState("error");
      setVerifyError(String(e));
    }
  };

  const handleTogglePod = async () => {
    const next = !status.podEnabled;
    await api.setSecret("pod_enabled", String(next));
    setStatus((s) => ({ ...s, podEnabled: next }));
    // Toggling POD materializes (or dissolves) the Printify Operator on the
    // floor. The dynamic hire system places a fresh "Ops Bay" room automatically
    // via placeNewRoom (up to the 10×10 grid limit).
    if (next) hirePrintifyOperator();
    else dissolvePrintifyOperator();
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Print-on-demand (Printify)</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        When on, sticker designs route through Printify → Etsy instead of being
        digital-download drafts. Requires a Printify account with SabiWabiGifts
        connected as an Etsy sales channel, and a production-partner declared in
        Etsy Seller Dashboard. Etsy also requires AI-design disclosure in every
        listing — added automatically.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Printify status</span>
          <span className="settings-helper">
            {status.keyPresent && status.shopId
              ? `Connected · shop_id=${status.shopId}${status.shopTitle ? ` · ${status.shopTitle}` : ""}`
              : "Not connected"}
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Personal access token</span>
          <span className="settings-helper">
            {status.keyPresent
              ? "Token already saved (hidden for security). Leave blank to keep it; paste a new one + Verify to replace."
              : "Generate in Printify → My account → Connections → API. Verifying saves the token and the discovered Etsy shop_id."}
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.keyPresent ? "•••••• (saved)" : "Printify PAT"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !keyDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : status.keyPresent ? "Replace" : "Verify"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — token saved.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {verifyError}
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">POD pipeline</span>
          <span className="settings-helper">
            Off until verified. When on, sticker jobs go through Printify; other
            product types still go through the existing digital pipeline.
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.podEnabled ? " is-on" : ""}`}
          onClick={handleTogglePod}
          disabled={!status.keyPresent || !status.shopId}
        >
          {status.podEnabled ? "ON" : "OFF"}
        </button>
      </div>

      <PodDailyCapRow />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  ShopFocusSection: 3D-only / 2D-only / Mixed                         */
/* ------------------------------------------------------------------ */

function ShopFocusSection() {
  const [focus, setFocus] = useState<string>("3d_only");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getShopFocus()
      .then((r) => setFocus(r.value))
      .catch(() => {});
  }, []);

  const handleSet = async (next: string) => {
    if (next === focus) return;
    setSaving(true);
    try {
      await api.setShopFocus(next);
      setFocus(next);
    } finally {
      setSaving(false);
    }
  };

  const options: Array<{ value: string; label: string; sub: string }> = [
    {
      value: "3d_only",
      label: "3D only",
      sub: "STL + GLB downloads (Etsy + Cults3D). Pivoted here after 58 unsold 2D drafts.",
    },
    {
      value: "mixed",
      label: "Mixed",
      sub: "2D + 3D. Useful while testing both markets.",
    },
    {
      value: "2d_only",
      label: "2D only",
      sub: "Stickers, prints, mugs, tees, posters. Original mode.",
    },
  ];

  return (
    <section className="settings-section">
      <div className="settings-section-title">Shop focus</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Drives what kinds of products the orchestrator + research + designer
        pursue. Restart the supervisor after changing so workers pick up the
        new SHOP_FOCUS env value.
      </div>
      <div className="shop-focus-row">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`shop-focus-btn${focus === o.value ? " is-active" : ""}`}
            onClick={() => handleSet(o.value)}
            disabled={saving}
          >
            <span className="shop-focus-btn-label">{o.label}</span>
            <span className="shop-focus-btn-sub">{o.sub}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  CharacterPoolSection: which archetype tiers the pipeline mines       */
/* ------------------------------------------------------------------ */

function CharacterPoolSection() {
  const [pool, setPool] = useState<string>("all");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getCharacterPool()
      .then((r) => setPool(r.value))
      .catch(() => {});
  }, []);

  const handleSet = async (next: string) => {
    if (next === pool) return;
    setSaving(true);
    try {
      await api.setCharacterPool(next);
      setPool(next);
    } finally {
      setSaving(false);
    }
  };

  const options: Array<{ value: string; label: string; sub: string; risk?: boolean }> = [
    {
      value: "safe",
      label: "Safe (recommended)",
      sub: "Rotates across original anime + mythology + own-universe. Zero IP risk on every draft. Use this until the manual-approval IP gate ships.",
    },
    {
      value: "original_anime",
      label: "Original anime only",
      sub: "Generic anime archetypes (shonen swordsman, mecha pilot). Zero IP risk.",
    },
    {
      value: "mythology",
      label: "Mythology + public-domain",
      sub: "Greek/Norse gods, yokai, Cthulhu, Arthurian, fairy tales. No IP risk.",
    },
    {
      value: "own_universe",
      label: "Own universe only",
      sub: "Original IP we coin from scratch. Best long-term franchise value.",
    },
    {
      value: "all",
      label: "All four",
      sub: "Includes popular-IP fan art (Naruto/Marvel/Star Wars). Will auto-publish those to Etsy until the IP gate ships. DMCA risk.",
      risk: true,
    },
    {
      value: "popular_ip",
      label: "Popular IP only",
      sub: "Naruto, Marvel, Star Wars, etc. Same DMCA risk as 'All four' until the IP gate ships. Pick deliberately.",
      risk: true,
    },
  ];

  return (
    <section className="settings-section">
      <div className="settings-section-title">Character pool</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Controls which archetype tiers the orchestrator + research pull from
        when picking a 3D niche. Popular-IP drafts are flagged ip_risk=high
        and held for your approval before publish — no auto-leak. Restart
        the supervisor after changing.
      </div>
      <div className="shop-focus-row">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`shop-focus-btn${pool === o.value ? " is-active" : ""}`}
            onClick={() => handleSet(o.value)}
            disabled={saving}
          >
            <span
              className="shop-focus-btn-label"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {o.label}
              {o.risk && (
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-label="DMCA risk"
                  focusable="false"
                >
                  <path d="M8 2 L14.5 13.5 H1.5 Z" />
                  <path d="M8 6.5 V9.5" />
                  <circle cx="8" cy="11.7" r="0.5" fill="currentColor" />
                </svg>
              )}
            </span>
            <span className="shop-focus-btn-sub">{o.sub}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  ImageTo3dProviderSection: tripo vs meshy for image→3D                */
/* ------------------------------------------------------------------ */

function ImageTo3dProviderSection() {
  const [provider, setProvider] = useState<string>("tripo");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getImageTo3dProvider()
      .then((r) => setProvider(r.value))
      .catch(() => {});
  }, []);

  const handleSet = async (next: string) => {
    if (next === provider) return;
    setSaving(true);
    try {
      await api.setImageTo3dProvider(next);
      setProvider(next);
    } finally {
      setSaving(false);
    }
  };

  const options: Array<{ value: string; label: string; sub: string }> = [
    {
      value: "tripo",
      label: "Tripo (default)",
      sub: "User's preferred provider. Needs TRIPO_API_KEY. If the key is missing the designer falls back to Meshy so the job still completes.",
    },
    {
      value: "meshy",
      label: "Meshy",
      sub: "Needs MESHY_API_KEY. Falls back to Tripo if the key is missing.",
    },
  ];

  return (
    <section className="settings-section">
      <div className="settings-section-title">3D generation provider</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Which provider the designer prefers for both text-to-3D (no reference
        image) and image-to-3D (nanobanana → 3D). The other provider is the
        auto-fallback when the preferred key isn't set.
      </div>
      <div className="shop-focus-row">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`shop-focus-btn${provider === o.value ? " is-active" : ""}`}
            onClick={() => handleSet(o.value)}
            disabled={saving}
          >
            <span className="shop-focus-btn-label">{o.label}</span>
            <span className="shop-focus-btn-sub">{o.sub}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  MeshGenerationToggleSection: textures / rig / animation overrides    */
/* ------------------------------------------------------------------ */

/**
 * Operator overrides for Meshy 6 mesh generation. Each toggle SUPERSEDES
 * any heuristic in the designer / meshy submit path:
 *   - Textures: forces enable_pbr + should_texture off when disabled.
 *     Saves ~$0.20 per image-to-3D call (30 → 20 credits) and skips the
 *     text-to-3D refine stage entirely. GLB ships flat-shaded.
 *   - Rigging: gates rig_and_animate. When off, no humanoid character
 *     ever gets rigged regardless of the brief. Skipping saves 5 credits
 *     per humanoid (~$0.10).
 *   - Animation: when on, the +3-credit Animation Library call fires
 *     after rigging. When off, rigging still happens (and the free
 *     walking + running loops bundled with the rigging task are still
 *     downloaded), but the operator-chosen action is skipped.
 *
 * Implicit dependency: Meshy auto-rig requires a textured input, so
 * disabling textures auto-disables rigging at the worker. The UI
 * surfaces this with a sub-text note; we don't hard-disable the toggle
 * because the operator may want to flip textures back on later.
 *
 * Wired through src-tauri/src/commands.rs::cmd_start as
 * MESHY_TEXTURES_ENABLED / MESHY_RIG_ENABLED / MESHY_ANIMATION_ENABLED
 * env vars; takes effect on the next supervisor start (matches the
 * coarse contract of the other env-flag-backed settings).
 */
function MeshGenerationToggleSection() {
  const [textures, setTextures] = useState(true);
  const [rig, setRig] = useState(true);
  const [animation, setAnimation] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getSecret("meshy_textures_enabled"),
      api.getSecret("meshy_rig_enabled"),
      api.getSecret("meshy_animation_enabled"),
    ]).then(([t, r, a]) => {
      // Default ON when the secret is absent or anything other than
      // "false" — matches the Rust _bool_secret helper.
      setTextures(!(t && t.toLowerCase() === "false"));
      setRig(!(r && r.toLowerCase() === "false"));
      setAnimation(!(a && a.toLowerCase() === "false"));
    }).catch(() => {});
  }, []);

  const flip = async (
    key: "meshy_textures_enabled" | "meshy_rig_enabled" | "meshy_animation_enabled",
    cur: boolean,
    setLocal: (v: boolean) => void,
  ) => {
    const next = !cur;
    setSavingKey(key);
    try {
      await api.setSecret(key, next ? "true" : "false");
      setLocal(next);
    } catch (e) {
      console.warn(`${key} save failed`, e);
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Mesh generation</div>
      <div className="settings-helper" style={{ marginBottom: 12 }}>
        Operator-locked overrides for Meshy 6. Each toggle supersedes the
        designer's per-job heuristic. Changes take effect on the next
        supervisor restart.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Textures (PBR)</span>
          <span className="settings-helper">
            ON: Meshy 6 image-to-3D ships with full PBR maps (base color,
            normal, roughness, emission) — 30 credits per call. OFF: skips
            texturing and the text-to-3D refine stage — 20 credits, GLB
            ships flat-shaded.
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${textures ? " is-on" : ""}`}
          onClick={() => flip("meshy_textures_enabled", textures, setTextures)}
          disabled={savingKey !== null}
        >
          {savingKey === "meshy_textures_enabled" ? "…" : textures ? "ON" : "OFF"}
        </button>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Auto-rigging</span>
          <span className="settings-helper">
            ON: full-body humanoid characters get a rigged GLB + free
            walking/running loops — 5 credits per character. OFF: never
            rig regardless of the brief.{" "}
            {!textures && (
              <em style={{ color: "rgba(245, 166, 35, 0.85)" }}>
                Textures are off, so rigging is auto-disabled (Meshy's
                auto-rig requires a textured input).
              </em>
            )}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${rig ? " is-on" : ""}`}
          onClick={() => flip("meshy_rig_enabled", rig, setRig)}
          disabled={savingKey !== null}
        >
          {savingKey === "meshy_rig_enabled" ? "…" : rig ? "ON" : "OFF"}
        </button>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Animation</span>
          <span className="settings-helper">
            ON: after rigging, fire one preset Animation Library action
            (default: Idle) — 3 credits per character. OFF: rig only,
            skip the Animation API call. Free walking + running loops
            from the rigging task still ship either way.{" "}
            {!rig && (
              <em style={{ color: "rgba(255, 255, 255, 0.5)" }}>
                Rigging is off, so this setting has no effect.
              </em>
            )}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${animation ? " is-on" : ""}`}
          onClick={() => flip("meshy_animation_enabled", animation, setAnimation)}
          disabled={savingKey !== null}
        >
          {savingKey === "meshy_animation_enabled" ? "…" : animation ? "ON" : "OFF"}
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  GitHubAssetHostSection: configure repo+token for public asset hosting */
/* ------------------------------------------------------------------ */

function GitHubAssetHostSection() {
  const [repoDraft, setRepoDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{ repo: string | null; tokenPresent: boolean }>({
    repo: null,
    tokenPresent: false,
  });

  useEffect(() => {
    Promise.all([
      api.getSecret("github_asset_repo"),
      api.getSecret("github_asset_token"),
    ]).then(([r, t]) => {
      setStatus({
        repo: r && r.length ? r : null,
        tokenPresent: !!(t && t.length),
      });
    }).catch(() => {});
  }, []);

  const handleVerify = async () => {
    if (!repoDraft.trim() || !tokenDraft.trim()) return;
    setVerifyState("verifying");
    setErr(null);
    try {
      const r = await api.githubAssetHostVerify(repoDraft.trim(), tokenDraft.trim());
      setVerifyState("ok");
      setStatus({ repo: r.repo, tokenPresent: true });
      setTokenDraft("");
    } catch (e) {
      setVerifyState("error");
      setErr(String(e));
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Asset hosting (GitHub Releases)</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Cults3D pulls assets from public HTTPS URLs (no multipart upload).
        Point us at a PUBLIC repo you own; each 3D asset becomes a release
        artifact with an immutable download URL. Generate a PAT with{" "}
        <code>contents:write</code> scope at github.com → Settings →
        Developer settings → Personal access tokens.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Repo (owner/name)</span>
          <span className="settings-helper">
            {status.repo ? `Saved: ${status.repo}` : "e.g. samdavila/agent-factory-assets"}
          </span>
        </div>
        <input
          type="text"
          className="settings-cred-input"
          placeholder={status.repo ?? "owner/name"}
          value={repoDraft}
          onChange={(e) => setRepoDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Personal access token</span>
          <span className="settings-helper">
            {status.tokenPresent
              ? "Token saved (hidden). Paste a new one + Verify to replace."
              : "Fine-grained PAT, contents:write on the asset repo."}
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.tokenPresent ? "•••••• (saved)" : "ghp_…"}
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !repoDraft.trim() || !tokenDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : "Verify + save"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — repo is public and writeable.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {err}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Cults3DSection: API creds + Enable toggle                            */
/* ------------------------------------------------------------------ */

function Cults3DSection() {
  const [userDraft, setUserDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    credsPresent: boolean;
    hostConfigured: boolean;
    enabled: boolean;
    todayCount: number;
  }>({
    credsPresent: false,
    hostConfigured: false,
    enabled: false,
    todayCount: 0,
  });

  const reload = async () => {
    try {
      const s = await api.cults3dStatus();
      setStatus({
        credsPresent: s.creds_present,
        hostConfigured: s.asset_host_configured,
        enabled: s.enabled,
        todayCount: s.today_count,
      });
    } catch {
      /* boot */
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleVerify = async () => {
    if (!userDraft.trim() || !keyDraft.trim()) return;
    setVerifyState("verifying");
    setErr(null);
    try {
      await api.cults3dVerify(userDraft.trim(), keyDraft.trim());
      setVerifyState("ok");
      setUserDraft("");
      setKeyDraft("");
      reload();
    } catch (e) {
      setVerifyState("error");
      setErr(String(e));
    }
  };

  const handleToggle = async () => {
    const next = !status.enabled;
    await api.cults3dSetEnabled(next);
    setStatus((s) => ({ ...s, enabled: next }));
  };

  const canEnable = status.credsPresent && status.hostConfigured;

  return (
    <section className="settings-section">
      <div className="settings-section-title">Cults3D publishing</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Cross-list every 3D asset (STL / GLB) to Cults3D in parallel with
        Etsy. Requires the GitHub asset host above (Cults3D pulls assets from
        public HTTPS URLs). AI-disclosure is mandatory and set automatically
        via the <code>madeWithAi: true</code> field.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Status</span>
          <span className="settings-helper">
            {status.credsPresent
              ? "Creds saved"
              : "No creds — verify below"}
            {" · "}
            {status.hostConfigured ? "Asset host ready" : "Asset host missing"}
            {" · "}
            {status.todayCount} published today
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Cults3D nick</span>
          <span className="settings-helper">
            {status.credsPresent
              ? "Saved (verify again to replace)."
              : "Your Cults3D NICK — the handle in your profile URL (cults3d.com/en/users/<nick>). Not your email or display name."}
          </span>
        </div>
        <input
          type="text"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "username"}
          value={userDraft}
          onChange={(e) => setUserDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">API key</span>
          <span className="settings-helper">
            Generate at cults3d.com/en/api/keys. Verifying saves both.
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "Cults3D API key"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !userDraft.trim() || !keyDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : "Verify + save"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — credentials saved.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {err}
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Enable Cults3D fan-out</span>
          <span className="settings-helper">
            {canEnable
              ? "On = every 3D publisher job also gets cross-listed to Cults3D."
              : "Off — needs Cults3D creds + GitHub asset host configured first."}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.enabled ? " is-on" : ""}`}
          onClick={handleToggle}
          disabled={!canEnable}
        >
          {status.enabled ? "ON" : "OFF"}
        </button>
      </div>

    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  PinterestSection: manual-token paste + Enable + daily cap            */
/* ------------------------------------------------------------------ */

function PinterestSection() {
  const [tokenDraft, setTokenDraft] = useState("");
  const [boardDraft, setBoardDraft] = useState("");
  const [verifyState, setVerifyState] = useState<
    "idle" | "verifying" | "ok" | "error"
  >("idle");
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    credsPresent: boolean;
    boardName: string | null;
    enabled: boolean;
    dailyCap: number;
    todayCount: number;
  }>({
    credsPresent: false,
    boardName: null,
    enabled: false,
    dailyCap: 5,
    todayCount: 0,
  });
  const [capDraft, setCapDraft] = useState<string>("");

  const reload = async () => {
    try {
      const s = await api.pinterestStatus();
      setStatus({
        credsPresent: s.creds_present,
        boardName: s.board_name,
        enabled: s.enabled,
        dailyCap: s.daily_cap,
        todayCount: s.today_count,
      });
      setCapDraft(String(s.daily_cap));
    } catch {
      /* boot */
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleVerify = async () => {
    if (!tokenDraft.trim() || !boardDraft.trim()) return;
    setVerifyState("verifying");
    setErr(null);
    try {
      await api.pinterestVerify(tokenDraft.trim(), boardDraft.trim());
      setVerifyState("ok");
      setTokenDraft("");
      setBoardDraft("");
      reload();
    } catch (e) {
      setVerifyState("error");
      setErr(String(e));
    }
  };

  const handleToggle = async () => {
    const next = !status.enabled;
    await api.pinterestSetEnabled(next);
    setStatus((s) => ({ ...s, enabled: next }));
  };

  const handleSaveCap = async () => {
    const n = parseInt(capDraft, 10);
    if (!Number.isFinite(n) || n < 0) return;
    await api.pinterestSetDailyCap(n);
    setStatus((s) => ({ ...s, dailyCap: n }));
  };

  const handleDisconnect = async () => {
    await api.pinterestDisconnect();
    reload();
  };

  const canEnable = status.credsPresent;

  return (
    <section className="settings-section">
      <div className="settings-section-title">Pinterest pin posting</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Pinterest drives ~41% of Etsy's external traffic. Every successful
        Etsy publish auto-pins the 1000×1500 pin image (generated by the
        publisher) to your board, linking back to the Etsy listing. Manual
        token paste — full OAuth comes later once we've validated lift.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Status</span>
          <span className="settings-helper">
            {status.credsPresent
              ? `Connected${status.boardName ? ` · board "${status.boardName}"` : ""}`
              : "Not connected — paste an access token + board id"}
            {" · "}
            {status.todayCount}/{status.dailyCap} pinned today
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Access token</span>
          <span className="settings-helper">
            Generate a 30-day token at developers.pinterest.com with the{" "}
            <code>pins:write</code> + <code>boards:read</code> scopes.
            Re-paste when it expires.
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "Pinterest access token"}
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Board id</span>
          <span className="settings-helper">
            Numeric id from your board URL (pinterest.com/{`<user>`}/{`<board>`}).
            Use the API's GET /v5/boards to list yours, or copy from the
            board's settings panel.
          </span>
        </div>
        <input
          type="text"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "board id"}
          value={boardDraft}
          onChange={(e) => setBoardDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={
            verifyState === "verifying" ||
            !tokenDraft.trim() ||
            !boardDraft.trim()
          }
        >
          {verifyState === "verifying" ? "Verifying…" : "Verify + save"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — credentials saved.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {err}
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Enable auto-pinning</span>
          <span className="settings-helper">
            {canEnable
              ? "On = every successful Etsy publish also posts a pin to your board."
              : "Off — needs a verified access token + board id first."}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.enabled ? " is-on" : ""}`}
          onClick={handleToggle}
          disabled={!canEnable}
        >
          {status.enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Daily cap</span>
          <span className="settings-helper">
            Max pins per UTC day. Default 5 — Pinterest's spam heuristics
            are aggressive on new accounts; raise once the account has
            history.
          </span>
        </div>
        <input
          type="number"
          min={0}
          max={50}
          className="settings-cred-input settings-input-number"
          value={capDraft}
          onChange={(e) => setCapDraft(e.target.value)}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleSaveCap}
          disabled={!capDraft.trim()}
        >
          Save
        </button>
      </div>

      {status.credsPresent && (
        <div className="settings-field-row">
          <div className="settings-field-label-col">
            <span className="settings-field-label">Disconnect</span>
            <span className="settings-helper">
              Clears the access token + board id from the keychain. Use
              this when rotating tokens or migrating boards.
            </span>
          </div>
          <button
            type="button"
            className="settings-cred-save"
            onClick={handleDisconnect}
          >
            Disconnect
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  TelegramSection: bot token + chat id for the rater bot.             */
/* ------------------------------------------------------------------ */

function TelegramSection() {
  const [tokenDraft, setTokenDraft] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [verifyState, setVerifyState] = useState<
    "idle" | "verifying" | "ok" | "error"
  >("idle");
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    credsPresent: boolean;
    botUsername: string | null;
    chatId: number | null;
    enabled: boolean;
  }>({
    credsPresent: false,
    botUsername: null,
    chatId: null,
    enabled: false,
  });

  const reload = async () => {
    try {
      const s = await api.telegramStatus();
      setStatus({
        credsPresent: s.creds_present,
        botUsername: s.bot_username,
        chatId: s.chat_id,
        enabled: s.enabled,
      });
    } catch {
      /* boot */
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleVerify = async () => {
    const t = tokenDraft.trim();
    const c = parseInt(chatDraft.trim(), 10);
    if (!t || !Number.isFinite(c) || c === 0) return;
    setVerifyState("verifying");
    setErr(null);
    try {
      await api.telegramVerify(t, c);
      setVerifyState("ok");
      setTokenDraft("");
      setChatDraft("");
      reload();
    } catch (e) {
      setVerifyState("error");
      setErr(String(e));
    }
  };

  const handleToggle = async () => {
    const next = !status.enabled;
    await api.telegramSetEnabled(next);
    setStatus((s) => ({ ...s, enabled: next }));
  };

  const handleDisconnect = async () => {
    await api.telegramDisconnect();
    reload();
  };

  const canEnable = status.credsPresent;

  return (
    <section className="settings-section">
      <div className="settings-section-title">Telegram rater bot</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Posts every new Etsy draft to your private Telegram chat with a
        photo, the STL/GLB attached, a 1-5 star keyboard, and a 3D viewer
        link. Star ratings + reply-notes train the orchestrator's
        niche-picking on the very next cycle. Run the worker locally with{" "}
        <code>uv run --project workers/rater_bot python -m rater_bot</code>.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Status</span>
          <span className="settings-helper">
            {status.credsPresent
              ? `Connected${status.botUsername ? ` as @${status.botUsername}` : ""}${
                  status.chatId ? ` · chat ${status.chatId}` : ""
                }`
              : "Not connected — paste a BotFather token + your chat id"}
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Bot token</span>
          <span className="settings-helper">
            Create a bot via @BotFather in Telegram (<code>/newbot</code>);
            it returns a token like <code>1234:AA...</code>.
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "BotFather token"}
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Chat id</span>
          <span className="settings-helper">
            Send any message to your bot in Telegram, then visit{" "}
            <code>api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> in a
            browser and copy the <code>chat.id</code> integer.
          </span>
        </div>
        <input
          type="text"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "numeric chat id"}
          value={chatDraft}
          onChange={(e) => setChatDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={
            verifyState === "verifying" ||
            !tokenDraft.trim() ||
            !chatDraft.trim()
          }
        >
          {verifyState === "verifying" ? "Verifying…" : "Verify + save"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — telegram.json written.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {err}
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Enable rating loop</span>
          <span className="settings-helper">
            {canEnable
              ? "On = the rater bot will post each new draft to your chat once it's running."
              : "Off — verify a bot token + chat id first."}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.enabled ? " is-on" : ""}`}
          onClick={handleToggle}
          disabled={!canEnable}
        >
          {status.enabled ? "ON" : "OFF"}
        </button>
      </div>

      {status.credsPresent && (
        <div className="settings-field-row">
          <div className="settings-field-label-col">
            <span className="settings-field-label">Disconnect</span>
            <span className="settings-helper">
              Deletes telegram.json so a leaked token can't be reused. Re-run
              BotFather <code>/revoke</code> if you suspect the token is out.
            </span>
          </div>
          <button
            type="button"
            className="settings-cred-save"
            onClick={handleDisconnect}
          >
            Disconnect
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  HiggsfieldSection: enable toggle + CLI/auth status                  */
/* ------------------------------------------------------------------ */

function HiggsfieldSection() {
  const [status, setStatus] = useState<{
    cliInstalled: boolean;
    cliAuthed: boolean;
    enabled: boolean;
  }>({ cliInstalled: false, cliAuthed: false, enabled: false });

  const reload = async () => {
    try {
      const s = await api.higgsfieldStatus();
      setStatus({
        cliInstalled: s.cli_installed,
        cliAuthed: s.cli_authed,
        enabled: s.enabled,
      });
    } catch {
      /* boot */
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleToggle = async () => {
    const next = !status.enabled;
    await api.higgsfieldSetEnabled(next);
    setStatus((s) => ({ ...s, enabled: next }));
  };

  const canEnable = status.cliInstalled && status.cliAuthed;

  return (
    <section className="settings-section">
      <div className="settings-section-title">Higgsfield product-photoshoot</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        After the designer renders a 3D preview, optionally upgrade it with a
        Higgsfield product-photoshoot pass (gpt_image_2 backend) for
        brand-quality listing thumbnails. Cost ≈ a few Higgsfield credits per
        listing. Falls back silently to the original render if the CLI isn't
        installed, isn't authenticated, or the job fails.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">CLI</span>
          <span className="settings-helper">
            {status.cliInstalled
              ? "Installed (higgsfield on $PATH)."
              : "Not installed. Run in a terminal: curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh"}
          </span>
        </div>
        <button
          type="button"
          className="settings-cred-save"
          onClick={reload}
        >
          Re-check
        </button>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Auth</span>
          <span className="settings-helper">
            {status.cliAuthed
              ? "Authenticated. Higgsfield CLI is signed in."
              : "Not authenticated. Run in a terminal: higgsfield auth login (interactive)."}
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Enhance listing thumbnails</span>
          <span className="settings-helper">
            {canEnable
              ? "On = every 3D job's preview render gets enhanced via Higgsfield product-photoshoot before publishing."
              : "Off — needs CLI installed and authenticated first."}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.enabled ? " is-on" : ""}`}
          onClick={handleToggle}
          disabled={!canEnable}
        >
          {status.enabled ? "ON" : "OFF"}
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  TrendSignalsSection: research-agent trend sources + YouTube key     */
/* ------------------------------------------------------------------ */

function TrendSignalsSection() {
  const [keyDraft, setKeyDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [sampleTitle, setSampleTitle] = useState<string | null>(null);
  const [status, setStatus] = useState<{ keyPresent: boolean }>({ keyPresent: false });

  useEffect(() => {
    api.youtubeStatus().then((s) => setStatus({ keyPresent: s.key_present })).catch(() => {});
  }, []);

  const handleVerify = async () => {
    if (!keyDraft.trim()) return;
    setVerifyState("verifying");
    setErr(null);
    try {
      const r = await api.youtubeVerify(keyDraft.trim());
      setVerifyState("ok");
      setSampleTitle(r.sample_video_title);
      setStatus({ keyPresent: true });
      setKeyDraft("");
    } catch (e) {
      setVerifyState("error");
      setErr(String(e));
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Trend signals (research agent)</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Before every research run, the agent pulls live trending topics from
        Reddit + Google Trends + YouTube and mines them for niche categories
        (filtering out IP and current events). Reddit + Google Trends require
        no setup. YouTube needs a free Google Cloud API key with the YouTube
        Data API v3 enabled.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Reddit</span>
          <span className="settings-helper">
            Active — pulling hot posts from r/3Dprinting, r/PrintedMinis,
            r/Etsy, r/DnD, r/Warhammer40k, r/halloween, r/christmas. No key
            required.
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Google Trends</span>
          <span className="settings-helper">
            Active — pulling daily trending searches (US). No key required.
            Install <code>pytrends</code> in the research worker for richer
            data; the RSS fallback works without it.
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">YouTube Data API key</span>
          <span className="settings-helper">
            {status.keyPresent
              ? "Key saved. Paste a new one + Verify to replace."
              : "Generate at console.cloud.google.com → Enable YouTube Data API v3 → Create credentials (API key). Free tier = 10k units/day, plenty for trend polling."}
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.keyPresent ? "•••••• (saved)" : "AIza…"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !keyDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : status.keyPresent ? "Replace" : "Verify"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — top trending video: "{sampleTitle}". Restart the
          supervisor for workers to pick up the key.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {err}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  MmfSection: API key + Enable + sell-paid                             */
/* ------------------------------------------------------------------ */

function MmfSection() {
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [clientSecretDraft, setClientSecretDraft] = useState("");
  const [connectState, setConnectState] = useState<
    "idle" | "connecting" | "ok" | "error"
  >("idle");
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    credsPresent: boolean;
    enabled: boolean;
    sellPaid: boolean;
    todayCount: number;
    clientId: string | null;
    oauthUserId: string | null;
  }>({
    credsPresent: false,
    enabled: false,
    sellPaid: false,
    todayCount: 0,
    clientId: null,
    oauthUserId: null,
  });

  const reload = async () => {
    try {
      const s = await api.mmfStatus();
      setStatus({
        credsPresent: s.creds_present,
        enabled: s.enabled,
        sellPaid: s.sell_paid,
        todayCount: s.today_count,
        clientId: s.client_id,
        oauthUserId: s.oauth_user_id,
      });
    } catch {
      /* boot */
    }
  };
  useEffect(() => {
    reload();
    let unlistenOk: UnlistenFn | undefined;
    let unlistenErr: UnlistenFn | undefined;
    (async () => {
      unlistenOk = await listen("mmf_connected", () => {
        setConnectState("ok");
        setClientIdDraft("");
        setClientSecretDraft("");
        setErr(null);
        reload();
      });
      unlistenErr = await listen<string>("mmf_oauth_error", (e) => {
        setConnectState("error");
        setErr(String(e.payload || "OAuth failed"));
      });
    })();
    return () => {
      unlistenOk?.();
      unlistenErr?.();
    };
  }, []);

  const handleConnect = async () => {
    if (!clientIdDraft.trim() || !clientSecretDraft.trim()) return;
    setConnectState("connecting");
    setErr(null);
    try {
      const { authorize_url } = await api.mmfStartOAuth(
        clientIdDraft.trim(),
        clientSecretDraft.trim(),
      );
      await openUrl(authorize_url);
      // Connect-state stays "connecting" until the mmf_connected /
      // mmf_oauth_error event fires (handled by the listeners above).
    } catch (e) {
      setConnectState("error");
      setErr(String(e));
    }
  };

  const handleDisconnect = async () => {
    await api.mmfDisconnect();
    setConnectState("idle");
    setErr(null);
    reload();
  };

  const handleToggle = async () => {
    const next = !status.enabled;
    await api.mmfSetEnabled(next);
    setStatus((s) => ({ ...s, enabled: next }));
  };
  const handleTogglePaid = async () => {
    const next = !status.sellPaid;
    await api.mmfSetSellPaid(next);
    setStatus((s) => ({ ...s, sellPaid: next }));
  };

  const connected = status.credsPresent;

  return (
    <section className="settings-section">
      <div className="settings-section-title">MyMiniFactory publishing</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Cross-list every 3D asset to MyMiniFactory. MMF requires OAuth 2.0 for
        uploads — personal API keys only work for reads. Register an app at{" "}
        <code>myminifactory.com/settings/developer</code> (set redirect URI to{" "}
        <code>http://localhost:7330/callback</code>), then paste{" "}
        <code>client_id</code> + <code>client_secret</code> below.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Status</span>
          <span className="settings-helper">
            {connected
              ? `Connected via OAuth${status.oauthUserId ? ` · user ${status.oauthUserId}` : ""}`
              : "Not connected — paste client_id + client_secret below"}
            {" · "}
            {status.todayCount} published today
            {" · "}
            {status.sellPaid ? "Paid listings" : "Free listings"}
          </span>
        </div>
      </div>

      {!connected && (
        <>
          <div className="settings-field-row">
            <div className="settings-field-label-col">
              <span className="settings-field-label">Client ID</span>
              <span className="settings-helper">
                From your MMF developer app. Stored locally, used only to
                build the OAuth authorize URL.
              </span>
            </div>
            <input
              type="text"
              className="settings-cred-input"
              placeholder="MMF client_id"
              value={clientIdDraft}
              onChange={(e) => setClientIdDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="settings-field-row">
            <div className="settings-field-label-col">
              <span className="settings-field-label">Client secret <em style={{ opacity: 0.6 }}>(optional)</em></span>
              <span className="settings-helper">
                From the same MMF developer app. <strong>Leave blank</strong> if MMF
                treats your app as a public client (no separate secret on
                the dev page). We'll fall through to public-client OAuth
                automatically.
              </span>
            </div>
            <input
              type="password"
              className="settings-cred-input"
              placeholder="MMF client_secret (or leave blank)"
              value={clientSecretDraft}
              onChange={(e) => setClientSecretDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="settings-cred-save"
              onClick={handleConnect}
              disabled={
                connectState === "connecting" ||
                !clientIdDraft.trim()
              }
            >
              {connectState === "connecting"
                ? "Waiting for browser…"
                : "Connect via OAuth"}
            </button>
          </div>
          {connectState === "connecting" && (
            <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
              Browser opened. Approve the app on myminifactory.com — this
              section will switch to "Connected" automatically when the
              redirect fires.
            </div>
          )}
          {connectState === "error" && (
            <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
              {err}
            </div>
          )}
        </>
      )}

      {connected && (
        <div className="settings-field-row">
          <div className="settings-field-label-col">
            <span className="settings-field-label">Disconnect</span>
            <span className="settings-helper">
              Drops the OAuth tokens. Keeps client_id/client_secret so a
              reconnect is one click.
            </span>
          </div>
          <button
            type="button"
            className="settings-cred-save"
            onClick={handleDisconnect}
          >
            Disconnect
          </button>
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Enable MMF fan-out</span>
          <span className="settings-helper">
            {status.credsPresent
              ? "On = every 3D publisher job also uploads to MyMiniFactory."
              : "Off — needs MMF API key configured first."}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.enabled ? " is-on" : ""}`}
          onClick={handleToggle}
          disabled={!status.credsPresent}
        >
          {status.enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Charge for downloads</span>
          <span className="settings-helper">
            On = upload at the publisher's price. Off = free listing (builds
            audience while MMF Store payouts/approval get sorted).
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.sellPaid ? " is-on" : ""}`}
          onClick={handleTogglePaid}
          disabled={!status.credsPresent}
        >
          {status.sellPaid ? "ON" : "OFF"}
        </button>
      </div>

    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  GumroadSection: access token + Enable toggle                         */
/* ------------------------------------------------------------------ */

function GumroadSection() {
  const [tokenDraft, setTokenDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [verifiedAccount, setVerifiedAccount] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    credsPresent: boolean;
    enabled: boolean;
    todayCount: number;
  }>({
    credsPresent: false,
    enabled: false,
    todayCount: 0,
  });
  const [backfillState, setBackfillState] = useState<"idle" | "running" | "done">("idle");
  const [backfillResult, setBackfillResult] = useState<GumroadBackfillResult | null>(null);

  const reload = async () => {
    try {
      const s = await api.gumroadStatus();
      setStatus({
        credsPresent: s.creds_present,
        enabled: s.enabled,
        todayCount: s.today_count,
      });
    } catch {
      /* boot */
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleVerify = async () => {
    if (!tokenDraft.trim()) return;
    setVerifyState("verifying");
    setErr(null);
    try {
      const r = await api.gumroadVerify(tokenDraft.trim());
      setVerifyState("ok");
      setVerifiedAccount(r.account);
      setTokenDraft("");
      reload();
    } catch (e) {
      setVerifyState("error");
      setErr(String(e));
    }
  };

  const handleToggle = async () => {
    const next = !status.enabled;
    await api.gumroadSetEnabled(next);
    setStatus((s) => ({ ...s, enabled: next }));
  };

  const handleBackfill = async () => {
    setBackfillState("running");
    setBackfillResult(null);
    try {
      const r = await api.gumroadBackfillFiles();
      setBackfillResult(r);
    } catch (e) {
      setBackfillResult({
        checked: 0,
        fixed: 0,
        skipped_missing_assets: 0,
        errors: 1,
        details: [String(e)],
      });
    }
    setBackfillState("done");
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Gumroad publishing</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Cross-list every 3D asset to Gumroad as a paid digital product. The STL
        and textured GLB upload via Gumroad's presign flow and the first
        preview render is attached as the cover image. Products land as Gumroad
        drafts — publish from their dashboard after review. AI disclosure added
        automatically.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Status</span>
          <span className="settings-helper">
            {status.credsPresent ? "Token saved" : "No token — verify below"}
            {" · "}
            {status.todayCount} published today
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Access token</span>
          <span className="settings-helper">
            Generate at gumroad.com → Settings → Advanced → "Create access
            token". Verifying saves the token.
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "Gumroad access token"}
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !tokenDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : "Verify + save"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified as {verifiedAccount} — token saved.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {err}
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Enable Gumroad fan-out</span>
          <span className="settings-helper">
            {status.credsPresent
              ? "On = every 3D publisher job also creates a Gumroad product."
              : "Off — needs Gumroad access token configured first."}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.enabled ? " is-on" : ""}`}
          onClick={handleToggle}
          disabled={!status.credsPresent}
        >
          {status.enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Backfill missing files</span>
          <span className="settings-helper">
            Re-uploads the STL/GLB and cover image onto Gumroad products that an
            earlier broken integration created empty. Listings whose source
            assets are no longer on disk are reported as skipped.
          </span>
        </div>
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleBackfill}
          disabled={!status.credsPresent || backfillState === "running"}
        >
          {backfillState === "running" ? "Backfilling…" : "Run backfill"}
        </button>
      </div>
      {backfillState === "done" && backfillResult && (
        <div className="settings-helper">
          <div
            style={{
              color:
                backfillResult.errors > 0
                  ? "var(--accent-bad)"
                  : "var(--accent-ok)",
            }}
          >
            Checked {backfillResult.checked} · fixed {backfillResult.fixed} ·
            skipped {backfillResult.skipped_missing_assets} · errors{" "}
            {backfillResult.errors}
          </div>
          {backfillResult.details.length > 0 && (
            <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
              {backfillResult.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  SketchfabSection: API token + Enable toggle + Sell-on-Store          */
/* ------------------------------------------------------------------ */

function SketchfabSection() {
  const [tokenDraft, setTokenDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [verifiedUsername, setVerifiedUsername] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    credsPresent: boolean;
    enabled: boolean;
    sellOnStore: boolean;
    todayCount: number;
  }>({
    credsPresent: false,
    enabled: false,
    sellOnStore: false,
    todayCount: 0,
  });

  const reload = async () => {
    try {
      const s = await api.sketchfabStatus();
      setStatus({
        credsPresent: s.creds_present,
        enabled: s.enabled,
        sellOnStore: s.sell_on_store,
        todayCount: s.today_count,
      });
    } catch {
      /* boot */
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleVerify = async () => {
    if (!tokenDraft.trim()) return;
    setVerifyState("verifying");
    setErr(null);
    try {
      const r = await api.sketchfabVerify(tokenDraft.trim());
      setVerifyState("ok");
      setVerifiedUsername(r.username);
      setTokenDraft("");
      reload();
    } catch (e) {
      setVerifyState("error");
      setErr(String(e));
    }
  };

  const handleToggle = async () => {
    const next = !status.enabled;
    await api.sketchfabSetEnabled(next);
    setStatus((s) => ({ ...s, enabled: next }));
  };

  const handleToggleSell = async () => {
    const next = !status.sellOnStore;
    await api.sketchfabSetSellOnStore(next);
    setStatus((s) => ({ ...s, sellOnStore: next }));
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Sketchfab publishing</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Cross-list every 3D asset (STL / GLB) to Sketchfab in parallel with
        Etsy and Cults3D. No asset host required — Sketchfab accepts direct
        multipart uploads and renders its own thumbnails. AI disclosure is
        added automatically via the <code>ai-generated</code> tag.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Status</span>
          <span className="settings-helper">
            {status.credsPresent ? "Token saved" : "No token — verify below"}
            {" · "}
            {status.todayCount} published today
            {" · "}
            {status.sellOnStore ? "Selling on Store" : "Free downloads (CC BY)"}
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">API token</span>
          <span className="settings-helper">
            Generate at sketchfab.com → Settings → Password → API. Verifying
            saves the token.
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.credsPresent ? "•••••• (saved)" : "Sketchfab API token"}
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !tokenDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : "Verify + save"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified as {verifiedUsername} — token saved.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {err}
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Enable Sketchfab fan-out</span>
          <span className="settings-helper">
            {status.credsPresent
              ? "On = every 3D publisher job also gets cross-listed to Sketchfab."
              : "Off — needs Sketchfab token configured first."}
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.enabled ? " is-on" : ""}`}
          onClick={handleToggle}
          disabled={!status.credsPresent}
        >
          {status.enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Sell on Sketchfab Store</span>
          <span className="settings-helper">
            On = upload as paid Store listing (requires Pro+ subscription). Off
            = free download under CC BY 4.0 (works on any account).
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${status.sellOnStore ? " is-on" : ""}`}
          onClick={handleToggleSell}
          disabled={!status.credsPresent}
        >
          {status.sellOnStore ? "ON" : "OFF"}
        </button>
      </div>

    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  MeshySection: enter key, verify, show remaining credit balance       */
/* ------------------------------------------------------------------ */

function MeshySection() {
  const [keyDraft, setKeyDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    keyPresent: boolean;
    balance: number | null;
  }>({ keyPresent: false, balance: null });

  useEffect(() => {
    api.meshyStatus().then((s) => {
      setStatus({ keyPresent: s.key_present, balance: s.balance });
    }).catch(() => {});
  }, []);

  const handleVerify = async () => {
    if (!keyDraft.trim()) return;
    setVerifyState("verifying");
    setVerifyError(null);
    try {
      const result = await api.meshyVerify(keyDraft.trim());
      setVerifyState("ok");
      setStatus({ keyPresent: true, balance: result.balance });
      setKeyDraft("");
    } catch (e) {
      setVerifyState("error");
      setVerifyError(String(e));
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">3D generation (Meshy — preferred)</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Text-to-3D via Meshy. When connected, orchestrator rotates STL /
        3D-model product types into the mix and designer routes 3D briefs to
        Meshy's preview pass (~30s, ~5 credits). Yields GLB + STL pair plus a
        listing thumbnail. Etsy AI-disclosure added automatically. Restart the
        supervisor after verifying so workers pick up the key.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Meshy status</span>
          <span className="settings-helper">
            {status.keyPresent
              ? `Connected${status.balance != null ? ` · ${status.balance} credits` : ""}`
              : "Not connected"}
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">API key</span>
          <span className="settings-helper">
            {status.keyPresent
              ? "Key already saved (hidden). Paste a new one + Verify to replace."
              : "Generate at meshy.ai → Settings → API → keys. Verifying saves the key and reads your credit balance."}
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.keyPresent ? "•••••• (saved)" : "Meshy API key"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !keyDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : status.keyPresent ? "Replace" : "Verify"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — key saved. Stop + Start the supervisor for workers to pick it up.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {verifyError}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  GoogleAiSection: Gemini 2.5 Flash Image ("nanobanana") API key       */
/* ------------------------------------------------------------------ */

function GoogleAiSection() {
  const [keyDraft, setKeyDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ keyPresent: boolean }>({ keyPresent: false });

  useEffect(() => {
    api.googleStatus().then((s) => {
      setStatus({ keyPresent: s.key_present });
    }).catch(() => {});
  }, []);

  const handleVerify = async () => {
    if (!keyDraft.trim()) return;
    setVerifyState("verifying");
    setVerifyError(null);
    try {
      await api.googleVerify(keyDraft.trim());
      setVerifyState("ok");
      setStatus({ keyPresent: true });
      setKeyDraft("");
    } catch (e) {
      setVerifyState("error");
      setVerifyError(String(e));
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">Reference renders (Google AI — nanobanana)</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        Gemini 2.5 Flash Image generates a 2K vertical character reference
        render that the image-to-3D provider (Tripo by default) turns into a
        printable mesh. Without this key, designer falls back to text-to-3D
        directly — fine for objects, weaker for characters. Restart the
        supervisor after verifying.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Google AI status</span>
          <span className="settings-helper">
            {status.keyPresent ? "Connected" : "Not connected"}
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">API key</span>
          <span className="settings-helper">
            {status.keyPresent
              ? "Key already saved (hidden). Paste a new one + Verify to replace."
              : "Generate at aistudio.google.com → Get API key. Verifying makes one test image-gen call to confirm billing + access."}
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.keyPresent ? "•••••• (saved)" : "Google API key"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !keyDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : status.keyPresent ? "Replace" : "Verify"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — key saved. Stop + Start the supervisor for workers to pick it up.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {verifyError}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  TripoSection: enter key, verify, show remaining credit balance       */
/* ------------------------------------------------------------------ */

function TripoSection() {
  const [keyDraft, setKeyDraft] = useState("");
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "error">("idle");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    keyPresent: boolean;
    balance: number | null;
  }>({ keyPresent: false, balance: null });

  useEffect(() => {
    api.tripoStatus().then((s) => {
      setStatus({ keyPresent: s.key_present, balance: s.balance });
    }).catch(() => {});
  }, []);

  const handleVerify = async () => {
    if (!keyDraft.trim()) return;
    setVerifyState("verifying");
    setVerifyError(null);
    try {
      const result = await api.tripoVerify(keyDraft.trim());
      setVerifyState("ok");
      setStatus({ keyPresent: true, balance: result.balance });
      setKeyDraft("");
    } catch (e) {
      setVerifyState("error");
      setVerifyError(String(e));
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">3D generation (Tripo)</div>
      <div className="settings-helper" style={{ marginBottom: 8 }}>
        When connected, the orchestrator rotates STL / 3D-model product types
        into the mix alongside stickers and digital prints. Designer routes 3D
        briefs to Tripo's text-to-model API, producing GLB + STL pairs. Etsy
        AI-disclosure is added automatically. Restart the supervisor after
        verifying so workers pick up the key.
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">Tripo status</span>
          <span className="settings-helper">
            {status.keyPresent
              ? `Connected${status.balance != null ? ` · ${status.balance} credits` : ""}`
              : "Not connected"}
          </span>
        </div>
      </div>

      <div className="settings-field-row">
        <div className="settings-field-label-col">
          <span className="settings-field-label">API key</span>
          <span className="settings-helper">
            {status.keyPresent
              ? "Key already saved (hidden). Paste a new one + Verify to replace."
              : "Generate at platform.tripo3d.ai → API → keys. Verifying saves the key and reads your credit balance."}
          </span>
        </div>
        <input
          type="password"
          className="settings-cred-input"
          placeholder={status.keyPresent ? "•••••• (saved)" : "Tripo API key"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="settings-cred-save"
          onClick={handleVerify}
          disabled={verifyState === "verifying" || !keyDraft.trim()}
        >
          {verifyState === "verifying" ? "Verifying…" : status.keyPresent ? "Replace" : "Verify"}
        </button>
      </div>
      {verifyState === "ok" && (
        <div className="settings-helper" style={{ color: "var(--accent-ok)" }}>
          Verified — key saved. Stop + Start the supervisor for workers to pick it up.
        </div>
      )}
      {verifyState === "error" && (
        <div className="settings-helper" style={{ color: "var(--accent-bad)" }}>
          {verifyError}
        </div>
      )}
    </section>
  );
}

function PodDailyCapRow() {
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSecret("pod_daily_cap").then((v) => {
      const num = parseInt(v ?? "", 10);
      setDraft(Number.isFinite(num) && num > 0 ? String(num) : "2");
    }).catch(() => setDraft("2"));
  }, []);

  const save = async () => {
    const num = parseInt(draft, 10);
    if (!Number.isFinite(num) || num < 1) return;
    setSaving(true);
    try {
      await api.setSecret("pod_daily_cap", String(num));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-field-row">
      <div className="settings-field-label-col">
        <span className="settings-field-label">POD daily cap</span>
        <span className="settings-helper">
          Max sticker publishes per day. Default 2 — Etsy auto-suspends new
          shops that publish too fast. Raise to ~5 after the first 10 reviews.
        </span>
      </div>
      <input
        type="number"
        min={1}
        max={50}
        className="settings-input settings-input-number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        disabled={saving}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main SettingsModal                                                    */
/* ------------------------------------------------------------------ */

type SettingsTabId = "account" | "pipeline" | "generation" | "etsy" | "cross";

interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
  sublabel: string;
  icon: ReactNode;
}

const SETTINGS_TABS: SettingsTabDef[] = [
  {
    id: "account",
    label: "Account",
    sublabel: "Keys · budgets · bridge",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    ),
  },
  {
    id: "pipeline",
    label: "Pipeline",
    sublabel: "Behavior · strategy",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M6 8.5V14a4 4 0 0 0 4 4h5.5" />
      </svg>
    ),
  },
  {
    id: "generation",
    label: "Generation",
    sublabel: "AI providers",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2l1.8 4.6L18.5 8l-3.5 3.4.9 4.6L12 13.8 8.1 16l.9-4.6L5.5 8l4.7-1.4L12 2z" />
      </svg>
    ),
  },
  {
    id: "etsy",
    label: "Etsy",
    sublabel: "Shop · Printify",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7l9-4 9 4-9 4-9-4z" />
        <path d="M3 12l9 4 9-4" />
        <path d="M3 17l9 4 9-4" />
      </svg>
    ),
  },
  {
    id: "cross",
    label: "Cross-listing",
    sublabel: "3D marketplaces",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12h10" />
        <path d="M10 6l6 6-6 6" />
        <path d="M20 4v16" />
      </svg>
    ),
  },
];

export default function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("account");
  const [etsyStatus, setEtsyStatus] = useState<EtsyStatus | null>(null);
  const [etsyEnabled, setEtsyEnabled] = useState(false);
  const [etsyEnabledSaving, setEtsyEnabledSaving] = useState(false);
  const [etsyCap, setEtsyCap] = useState(3);
  const [etsyCapDraft, setEtsyCapDraft] = useState("3");
  const [etsyCapSaveState, setEtsyCapSaveState] = useState<SaveState>("idle");
  const [etsyCapSaveError, setEtsyCapSaveError] = useState<string | null>(null);
  const [etsyCapValidationError, setEtsyCapValidationError] = useState<string | null>(null);
  const [etsyLastError, setEtsyLastError] = useState<string | null>(null);
  const [clearingError, setClearingError] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Kill switch state — confirmation gate before halting Etsy publishing.
  const [killConfirm, setKillConfirm] = useState(false);
  const [killing, setKilling] = useState(false);

  // Smoke-test state — fires a single end-to-end cycle for QA / pre-publish
  // validation. Steps tick off as supervisor events come in.
  const [smokeRunning, setSmokeRunning] = useState(false);
  const [smokeSteps, setSmokeSteps] = useState({
    research: false,
    asset: false,
    listing: false,
    draft: false,
  });
  const [smokeListingId, setSmokeListingId] = useState<number | null>(null);
  const [smokeDone, setSmokeDone] = useState(false);
  const [smokeError, setSmokeError] = useState<string | null>(null);

  // Autonomous behavior toggles
  const [autonomousLoops, setAutonomousLoops] = useState(false);
  const [autonomousLoopsSaving, setAutonomousLoopsSaving] = useState(false);
  const [fakeCs, setFakeCs] = useState(false);
  const [fakeCsSaving, setFakeCsSaving] = useState(false);
  const [siLoop, setSiLoop] = useState(false);
  const [siLoopSaving, setSiLoopSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const load = async () => {
      try {
        const [status, enabled, cap, lastErr, autoLoops, fakeMsg, siEnabled] = await Promise.all([
          api.etsyStatus(),
          api.etsyGetEnabled(),
          api.etsyGetListingCap(),
          api.etsyLastError().catch(() => null),
          api.getSecret("autonomous_loops_enabled").catch(() => null),
          api.getSecret("fake_cs_messages_enabled").catch(() => null),
          api.getSecret("si_loop_enabled").catch(() => null),
        ]);
        if (cancelled) return;
        setEtsyStatus(status);
        setEtsyEnabled(enabled);
        setEtsyCap(cap);
        setEtsyCapDraft(String(cap));
        setEtsyLastError(lastErr && lastErr.length > 0 ? lastErr : null);
        setAutonomousLoops(autoLoops === "true");
        setFakeCs(fakeMsg === "true");
        setSiLoop(siEnabled === "true");
      } catch (e) {
        console.warn("Settings modal load failed:", e);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [open]);

  // Dismiss on Esc
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Listen for supervisor events while the modal is open so smoke-test steps
  // tick off as research/asset/listing/draft phases complete. Must be defined
  // BEFORE any early return so the hook count stays stable across renders.
  useEffect(() => {
    if (!open) return;
    let unlisten: UnlistenFn | undefined;
    listen<Record<string, unknown>>("supervisor:event", (e) => {
      const evt = e.payload;
      switch (evt.kind) {
        case "job_completed":
          if (evt.role === "research") {
            setSmokeSteps((s) => ({ ...s, research: true }));
          } else if (evt.role === "listing") {
            setSmokeSteps((s) => ({ ...s, listing: true }));
          }
          break;
        case "asset_rasterized":
          setSmokeSteps((s) => ({ ...s, asset: true }));
          break;
        case "etsy_listing_published":
          setSmokeSteps((s) => ({ ...s, draft: true }));
          if (typeof evt.local_listing_id === "number") {
            setSmokeListingId(evt.local_listing_id as number);
          }
          break;
        case "smoke_test_cycle_complete":
          setSmokeRunning(false);
          setSmokeDone(true);
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open]);

  if (!open) return null;

  /* -- Etsy publish toggle -- */
  const toggleEtsyEnabled = async () => {
    const next = !etsyEnabled;
    setEtsyEnabledSaving(true);
    try {
      await api.etsySetEnabled(next);
      setEtsyEnabled(next);
    } catch (e) {
      console.warn("etsySetEnabled failed", e);
    } finally {
      setEtsyEnabledSaving(false);
    }
  };

  /* -- Etsy listing cap -- */
  const saveEtsyCap = async () => {
    const n = parseInt(etsyCapDraft, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setEtsyCapValidationError("Must be a number between 0 and 100");
      return;
    }
    setEtsyCapValidationError(null);
    setEtsyCapSaveState("saving");
    setEtsyCapSaveError(null);
    try {
      await api.etsySetListingCap(n);
      setEtsyCap(n);
      setEtsyCapSaveState("saved");
      if (capTimerRef.current) clearTimeout(capTimerRef.current);
      capTimerRef.current = setTimeout(() => setEtsyCapSaveState("idle"), 1500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setEtsyCapSaveState("error");
      setEtsyCapSaveError(msg);
    }
  };

  /* -- Clear Etsy error -- */
  const clearEtsyError = async () => {
    setClearingError(true);
    try {
      await api.etsyClearLastError();
      setEtsyLastError(null);
    } catch (e) {
      console.warn("etsyClearLastError failed", e);
    } finally {
      setClearingError(false);
    }
  };

  /* -- Disconnect Etsy -- */
  const doDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.etsyDisconnect();
      const s = await api.etsyStatus();
      setEtsyStatus(s);
      setDisconnectConfirm(false);
    } catch (e) {
      console.warn("etsyDisconnect failed", e);
    } finally {
      setDisconnecting(false);
    }
  };

  /* -- Etsy kill switch -- */
  const doKill = async () => {
    setKilling(true);
    try {
      await api.etsyKillSwitch();
      setEtsyEnabled(false);
      setKillConfirm(false);
    } catch (e) {
      console.warn("etsy kill switch failed", e);
    } finally {
      setKilling(false);
    }
  };

  /* -- Smoke-test cycle -- */
  const startSmoke = async () => {
    setSmokeError(null);
    setSmokeRunning(true);
    setSmokeSteps({ research: false, asset: false, listing: false, draft: false });
    setSmokeListingId(null);
    setSmokeDone(false);
    try {
      await api.startSmokeTest();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSmokeError(msg);
      setSmokeRunning(false);
    }
  };
  const resumeSmoke = async () => {
    try {
      await api.resumeFromSmokeTest();
    } finally {
      setSmokeRunning(false);
      setSmokeDone(false);
    }
  };

  /* -- Autonomous loops toggles -- */
  const toggleAutonomousLoops = async () => {
    const next = !autonomousLoops;
    setAutonomousLoopsSaving(true);
    try {
      await api.setSecret("autonomous_loops_enabled", next ? "true" : "false");
      setAutonomousLoops(next);
    } catch (e) {
      console.warn("autonomous_loops_enabled save failed", e);
    } finally {
      setAutonomousLoopsSaving(false);
    }
  };

  const toggleFakeCs = async () => {
    const next = !fakeCs;
    setFakeCsSaving(true);
    try {
      await api.setSecret("fake_cs_messages_enabled", next ? "true" : "false");
      setFakeCs(next);
    } catch (e) {
      console.warn("fake_cs_messages_enabled save failed", e);
    } finally {
      setFakeCsSaving(false);
    }
  };

  const toggleSiLoop = async () => {
    const next = !siLoop;
    setSiLoopSaving(true);
    try {
      await api.setSecret("si_loop_enabled", next ? "true" : "false");
      setSiLoop(next);
    } catch (e) {
      console.warn("si_loop_enabled save failed", e);
    } finally {
      setSiLoopSaving(false);
    }
  };

  const appVersion = import.meta.env.DEV ? "debug build" : (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "release";

  return (
    <div
      className="settings-back"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="settings-modal settings-modal--tabbed">
        {/* Header */}
        <div className="settings-modal-head">
          <div className="settings-modal-head-left">
            <span className="settings-modal-tag">Config</span>
            <span className="settings-modal-title">Settings</span>
          </div>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Shell: left rail + right pane */}
        <div className="settings-shell">
          <nav className="settings-rail" aria-label="Settings sections">
            {SETTINGS_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`settings-tab-btn${isActive ? " is-active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={isActive ? "page" : undefined}
                >
                  <span className="settings-tab-icon" aria-hidden="true">{tab.icon}</span>
                  <span className="settings-tab-text">
                    <span className="settings-tab-label">{tab.label}</span>
                    <span className="settings-tab-sublabel">{tab.sublabel}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Scrollable pane */}
          <div className="settings-pane" key={activeTab}>

          {activeTab === "account" && <>
          <RemoteFactorySection />
          <ThemeSection />
          <IsoThemeSection />

          {/* ---- Section 1: Credentials ---- */}
          <section className="settings-section">
            <div className="settings-section-title">Credentials</div>
            <CredentialRow
              label="Anthropic API key"
              placeholder="sk-ant-…"
              secretKey="anthropic_api_key"
              onSaveSuccess={() => {}}
              helperText="Direct Anthropic API key (sk-ant-...). Ignored when a bridge is configured below."
            />
            <CredentialRow
              label="Etsy keystring"
              placeholder="24-character keystring"
              secretKey="etsy_api_keystring"
              validate={(v) => v.length !== 24 ? "Etsy keystring must be exactly 24 characters" : null}
              onSaveSuccess={() => {}}
            />
            <CredentialRow
              label="Etsy shared secret"
              placeholder="10-character shared secret"
              secretKey="etsy_shared_secret"
              validate={(v) => v.length !== 10 ? "Etsy shared secret must be exactly 10 characters" : null}
              onSaveSuccess={() => {}}
            />
          </section>

          {/* ---- Section 2: Budget caps ---- */}
          <section className="settings-section">
            <div className="settings-section-title">Budget caps (USD)</div>
            <BudgetRow
              label="Hourly cap"
              secretKey="hourly_budget_usd"
              defaultValue={0.50}
              helper="Default 0.50 — workers stop claiming jobs when this hour's spend would breach the cap"
            />
            <BudgetRow
              label="Daily cap"
              secretKey="daily_budget_usd"
              defaultValue={1.00}
              helper="Default 1.00 — total spend ceiling for the current UTC day"
            />
            <BudgetRow
              label="Monthly cap"
              secretKey="monthly_budget_usd"
              defaultValue={20.00}
              helper="Default 20.00 — total spend ceiling for the current UTC month"
            />
          </section>
          </>}

          {activeTab === "etsy" && <>
          {/* ---- Section 3: Etsy publishing ---- */}
          <section className="settings-section">
            <div className="settings-section-title">Etsy publishing</div>

            {/* Real-publish toggle */}
            <div className="settings-field-row">
              <div className="settings-field-label-col">
                <span className="settings-field-label">Real publishing</span>
                <span className="settings-helper">When off, listings are saved as drafts only</span>
              </div>
              <button
                type="button"
                className={`settings-toggle${etsyEnabled ? " is-on" : ""}`}
                onClick={toggleEtsyEnabled}
                disabled={etsyEnabledSaving}
              >
                {etsyEnabledSaving ? "…" : etsyEnabled ? "ON" : "OFF"}
              </button>
            </div>

            {/* Daily listing cap */}
            <div className="settings-field-row">
              <div className="settings-field-label-col">
                <span className="settings-field-label">Daily listing cap</span>
                <span className="settings-helper">Maximum listings to publish per day (0–100)</span>
              </div>
              <div className="settings-inline-number-wrap">
                <input
                  type="number"
                  className="settings-input settings-input-number settings-input-sm"
                  value={etsyCapDraft}
                  min={0}
                  max={100}
                  onChange={(e) => { setEtsyCapDraft(e.target.value); setEtsyCapValidationError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") saveEtsyCap(); }}
                />
                <button type="button" className="modal-btn settings-inline-save" onClick={saveEtsyCap}>
                  Save
                </button>
              </div>
            </div>
            {etsyCapValidationError && <div className="settings-inline-error">{etsyCapValidationError}</div>}
            <SaveFeedback state={etsyCapSaveState} error={etsyCapSaveError} />
            {etsyCapSaveState === "idle" && etsyCap !== parseInt(etsyCapDraft, 10) && Number.isFinite(parseInt(etsyCapDraft, 10)) && (
              <span className="settings-unsaved-note">Unsaved changes</span>
            )}

            {/* Connection status */}
            <div className="settings-field-row settings-status-row">
              <span className="settings-field-label">Etsy connection</span>
              <span className={`settings-conn-badge ${etsyStatus?.connected ? "is-connected" : "is-disconnected"}`}>
                {etsyStatus?.connected
                  ? `Connected to ${etsyStatus.shop_name ?? "your shop"}`
                  : "Not connected"}
              </span>
            </div>

            {/* Disconnect button */}
            {etsyStatus?.connected && (
              <div className="settings-field-row settings-disconnect-row">
                {!disconnectConfirm ? (
                  <button
                    type="button"
                    className="settings-danger-btn"
                    onClick={() => setDisconnectConfirm(true)}
                  >
                    Disconnect Etsy
                  </button>
                ) : (
                  <div className="settings-confirm-wrap">
                    <span className="settings-confirm-question">Disconnect and remove saved tokens?</span>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => setDisconnectConfirm(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="modal-btn reject"
                      onClick={doDisconnect}
                      disabled={disconnecting}
                    >
                      {disconnecting ? "Disconnecting…" : "Yes, disconnect"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Last OAuth error */}
            {etsyLastError && (
              <div className="settings-etsy-error-panel">
                <div className="settings-etsy-error-header">
                  <span>Last OAuth error</span>
                  <button
                    type="button"
                    className="settings-link"
                    onClick={clearEtsyError}
                    disabled={clearingError}
                  >
                    {clearingError ? "Clearing…" : "Clear"}
                  </button>
                </div>
                <pre className="settings-etsy-error-body">{etsyLastError}</pre>
              </div>
            )}
          </section>

          {/* ---- Etsy safety: kill switch ---- */}
          {etsyStatus?.connected && (
            <section className="settings-section">
              <div className="settings-section-title">Safety</div>
              <div className="settings-field-row">
                <div className="settings-field-label-col">
                  <span className="settings-field-label">Emergency kill switch</span>
                  <span className="settings-helper">
                    Immediately halts all real Etsy publishing. The toggle above flips to OFF;
                    re-enable manually when ready.
                  </span>
                </div>
                {!killConfirm ? (
                  <button
                    type="button"
                    className="settings-danger-btn"
                    onClick={() => setKillConfirm(true)}
                  >
                    Kill publishing
                  </button>
                ) : (
                  <div className="settings-confirm-wrap">
                    <span className="settings-confirm-question">Halt all Etsy publishing now?</span>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => setKillConfirm(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="modal-btn reject"
                      onClick={doKill}
                      disabled={killing}
                    >
                      {killing ? "Halting…" : "Yes, kill"}
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ---- Diagnostics: smoke test ---- */}
          {etsyStatus?.connected && (
            <section className="settings-section">
              <div className="settings-section-title">Diagnostics</div>
              <div className="settings-field-row">
                <div className="settings-field-label-col">
                  <span className="settings-field-label">Smoke-test cycle</span>
                  <span className="settings-helper">
                    Runs one end-to-end cycle (research → asset → listing → draft) so you can
                    verify the pipeline before turning real publishing back on.
                  </span>
                </div>
                <button
                  type="button"
                  className="modal-btn approve"
                  disabled={smokeRunning}
                  onClick={startSmoke}
                >
                  {smokeRunning ? "Running…" : "Run smoke test"}
                </button>
              </div>
              {smokeRunning && (
                <ul className="smoke-steps">
                  <li className={smokeSteps.research ? "ok" : ""}>Research</li>
                  <li className={smokeSteps.asset    ? "ok" : ""}>Asset</li>
                  <li className={smokeSteps.listing  ? "ok" : ""}>Listing</li>
                  <li className={smokeSteps.draft    ? "ok" : ""}>Draft published</li>
                </ul>
              )}
              {smokeDone && (
                <div className="settings-helper" style={{ marginTop: 8 }}>
                  <div className="ck ok">
                    Draft posted{smokeListingId ? ` (listing id ${smokeListingId})` : ""}. Review on Etsy, then resume.
                  </div>
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={resumeSmoke}
                    style={{ marginTop: 8 }}
                  >
                    Resume loops
                  </button>
                </div>
              )}
              {smokeError && <div className="settings-inline-error">{smokeError}</div>}
            </section>
          )}

          <PrintifySection />
          </>}

          {activeTab === "account" && <>
          {/* ---- Anthropic bridge ---- */}
          <section className="settings-section">
            <div className="settings-section-title">Anthropic bridge</div>
            <div className="settings-helper" style={{ marginBottom: 8 }}>
              If both Bridge URL and Bridge key are set, workers call the bridge using the bridge
              key. Otherwise they call api.anthropic.com using the Anthropic API key.
            </div>
            <BridgeUrlRow />
            <CredentialRow
              label="Bridge key"
              placeholder="brg_live_…"
              secretKey="anthropic_bridge_key"
              onSaveSuccess={() => {}}
              helperText="Auth key sent to the bridge as x-api-key."
            />
            <div className="settings-helper" style={{ marginTop: 6 }}>
              Restart the supervisor (Stop &rarr; Start) after changing bridge settings for them to apply.
            </div>
          </section>

          {/* ---- Diagnostics ---- */}
          <section className="settings-section settings-section-diagnostics">
            <div className="settings-section-title">Diagnostics</div>
            <div className="settings-diag-row">
              <span className="settings-diag-label">Secrets file</span>
              <code className="settings-diag-value">~/.agent-factory/secrets.dev.json</code>
            </div>
            <div className="settings-diag-row">
              <span className="settings-diag-label">Build</span>
              <code className="settings-diag-value">{appVersion}</code>
            </div>
          </section>
          </>}

          {activeTab === "pipeline" && <>
          {/* ---- Autonomous behavior ---- */}
          <section className="settings-section">
            <div className="settings-section-title">Autonomous behavior</div>

            {/* Autonomous loops master switch */}
            <div className="settings-field-row">
              <div className="settings-field-label-col">
                <span className="settings-field-label">Autonomous loops</span>
                <span className="settings-helper">
                  Master switch — when off, the supervisor only processes jobs you
                  explicitly enqueue. When on, it runs the orchestrator/CS/SI loops
                  continuously.
                </span>
              </div>
              <button
                type="button"
                className={`settings-toggle${autonomousLoops ? " is-on" : ""}`}
                onClick={toggleAutonomousLoops}
                disabled={autonomousLoopsSaving}
              >
                {autonomousLoopsSaving ? "…" : autonomousLoops ? "ON" : "OFF"}
              </button>
            </div>

            {/* Fake CS messages */}
            <div className="settings-field-row">
              <div className="settings-field-label-col">
                <span className="settings-field-label">Fake CS messages</span>
                <span className="settings-helper">
                  Fire a synthetic buyer message every 90s for CS testing. Only
                  useful while iterating on CS prompts; leave off for real operation.
                </span>
              </div>
              <button
                type="button"
                className={`settings-toggle${fakeCs ? " is-on" : ""}`}
                onClick={toggleFakeCs}
                disabled={fakeCsSaving}
              >
                {fakeCsSaving ? "…" : fakeCs ? "ON" : "OFF"}
              </button>
            </div>

            {/* SI prompt-tuning loop */}
            <div className="settings-field-row">
              <div className="settings-field-label-col">
                <span className="settings-field-label">SI prompt-tuning loop</span>
                <span className="settings-helper">
                  Every 5 min, run the SI agent to propose prompt improvements based
                  on recent outcomes. Costs ~$0.05 per tick.
                </span>
              </div>
              <button
                type="button"
                className={`settings-toggle${siLoop ? " is-on" : ""}`}
                onClick={toggleSiLoop}
                disabled={siLoopSaving}
              >
                {siLoopSaving ? "…" : siLoop ? "ON" : "OFF"}
              </button>
            </div>
          </section>

          <ShopFocusSection />
          <CharacterPoolSection />
          <TrendSignalsSection />
          </>}

          {activeTab === "generation" && <>
          <GoogleAiSection />
          <MeshySection />
          <TripoSection />
          <ImageTo3dProviderSection />
          <MeshGenerationToggleSection />
          <HiggsfieldSection />
          </>}

          {activeTab === "cross" && <>
          <GitHubAssetHostSection />
          <Cults3DSection />
          <SketchfabSection />
          <MmfSection />
          <GumroadSection />
          <PinterestSection />
          <TelegramSection />
          </>}

          </div>
        </div>
      </div>
    </div>
  );
}
