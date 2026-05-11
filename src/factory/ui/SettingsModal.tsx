import { useEffect, useRef, useState } from "react";
import { api, type EtsyStatus } from "../../api";

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
/*  BridgeUrlRow                                                          */
/* ------------------------------------------------------------------ */

function BridgeUrlRow() {
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSecret("anthropic_base_url").then((v) => {
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
      await api.setSecret("anthropic_base_url", draft.trim());
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
      <div className="settings-helper">
        Optional. Set to route all Anthropic calls through a local proxy. Leave empty to use
        https://api.anthropic.com directly. Paste the bridge's auth key into the Anthropic API Key
        field above.
      </div>
      <div className="settings-helper" style={{ marginTop: 2 }}>
        Restart the supervisor (Stop &rarr; Start) after changing this for it to apply.
      </div>
      <SaveFeedback state={saveState} error={saveError} />
    </div>
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
/*  Main SettingsModal                                                    */
/* ------------------------------------------------------------------ */

export default function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
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
      <div className="settings-modal">
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

        {/* Scrollable body */}
        <div className="settings-modal-body">

          {/* ---- Section 1: Credentials ---- */}
          <section className="settings-section">
            <div className="settings-section-title">Credentials</div>
            <CredentialRow
              label="Anthropic API key"
              placeholder="sk-ant-…"
              secretKey="anthropic_api_key"
              onSaveSuccess={() => {}}
              helperText="If using a bridge, paste the bridge's key here instead of an Anthropic API key."
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

          {/* ---- Section 4: Anthropic bridge ---- */}
          <section className="settings-section">
            <div className="settings-section-title">Anthropic bridge</div>
            <BridgeUrlRow />
          </section>

          {/* ---- Section 5: Autonomous behavior ---- */}
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

          {/* ---- Section 6: Diagnostics ---- */}
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

        </div>
      </div>
    </div>
  );
}
