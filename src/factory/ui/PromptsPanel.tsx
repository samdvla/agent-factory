import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { api, type PromptRow, type PromptHistoryEntry } from "../../api";

/**
 * HUD pill + collapsible drawer that exposes the four LLM-driven roles'
 * system prompts. Each row shows the default, the active override (editable
 * textarea), and the last-tweak metadata. Save/Clear write to
 * `~/.agent-factory/prompts.json` — the Python workers re-read that file on
 * every job, so changes take effect on the next cycle without restart.
 */
const ROLES: Array<{ id: string; label: string }> = [
  { id: "research", label: "Research" },
  { id: "designer", label: "Designer" },
  { id: "listing", label: "Listing" },
  { id: "cs", label: "Customer Service" },
];

function relativeTs(ts: number | null | undefined): string {
  if (!ts) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function PromptRowView({
  roleId,
  label,
  row,
  onRefresh,
}: {
  roleId: string;
  label: string;
  row: PromptRow;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [showDefault, setShowDefault] = useState(false);
  const [draft, setDraft] = useState(row.override ?? "");
  const [busy, setBusy] = useState<"save" | "clear" | "history" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PromptHistoryEntry[] | null>(null);

  useEffect(() => {
    setDraft(row.override ?? "");
  }, [row.override]);

  const sourceLabel = useMemo(() => {
    if (!row.last_tweak_ts) return null;
    const who =
      row.last_tweak_source === "si"
        ? "SI"
        : row.last_tweak_source === "user"
          ? "you"
          : "system";
    return `${relativeTs(row.last_tweak_ts)} by ${who}`;
  }, [row.last_tweak_ts, row.last_tweak_source]);

  const onSave = async () => {
    setError(null);
    if (draft.length < 40 || draft.length > 4000) {
      setError(`prompt must be 40..=4000 chars (got ${draft.length})`);
      return;
    }
    setBusy("save");
    try {
      await api.setPromptOverride(roleId, draft);
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const onClear = async () => {
    setError(null);
    setBusy("clear");
    try {
      await api.clearPromptOverride(roleId);
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const onHistory = async () => {
    setBusy("history");
    try {
      const h = await api.promptHistory(roleId, 5);
      setHistory(h);
    } catch (e) {
      console.warn("history load failed", e);
      setHistory([]);
    } finally {
      setBusy(null);
    }
  };

  const truncatedDefault = row.default.length > 220
    ? row.default.slice(0, 217) + "…"
    : row.default;

  return (
    <div className="prompts-row">
      <button
        type="button"
        className="prompts-row-header"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className={`prompts-row-caret${open ? " is-open" : ""}`}
          width="10" height="10" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="prompts-row-label">{label}</span>
        <span
          className={`prompts-row-tag${row.override ? " is-override" : ""}`}
        >
          {row.override ? "override" : "default"}
        </span>
        {sourceLabel && (
          <span className="prompts-row-ts">{sourceLabel}</span>
        )}
      </button>
      {open && (
        <div className="prompts-row-body">
          <div className="prompts-section">
            <div className="prompts-section-label">
              Default system prompt
              <button
                type="button"
                className="prompts-tiny-toggle"
                onClick={() => setShowDefault((v) => !v)}
              >
                {showDefault ? "collapse" : "expand"}
              </button>
            </div>
            <pre className="prompts-default">
              {showDefault ? row.default : truncatedDefault}
            </pre>
          </div>
          <div className="prompts-section">
            <div className="prompts-section-label">Active override</div>
            <textarea
              className="prompts-override-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="(no override — using default)"
              rows={8}
              spellCheck={false}
            />
            <div className="prompts-row-actions">
              <button
                type="button"
                className="prompts-btn is-primary"
                onClick={onSave}
                disabled={busy !== null || draft === (row.override ?? "")}
              >
                {busy === "save" ? "…" : "Save override"}
              </button>
              <button
                type="button"
                className="prompts-btn"
                onClick={onClear}
                disabled={busy !== null || !row.override}
              >
                {busy === "clear" ? "…" : "Clear override"}
              </button>
              <button
                type="button"
                className="prompts-btn"
                onClick={onHistory}
                disabled={busy !== null}
              >
                {busy === "history" ? "…" : "View SI history"}
              </button>
              <span className="prompts-charcount">
                {draft.length} chars
              </span>
            </div>
            {error && (
              <div className="prompts-error">{error}</div>
            )}
          </div>
          {history !== null && (
            <div className="prompts-section">
              <div className="prompts-section-label">Last 5 tweaks</div>
              {history.length === 0 ? (
                <div className="prompts-empty">no history yet</div>
              ) : (
                <ul className="prompts-history">
                  {history.map((h, i) => (
                    <li key={i} className="prompts-history-item">
                      <span className="prompts-history-ts">
                        {relativeTs(h.ts)}
                      </span>
                      <span className="prompts-history-source">
                        {h.source ?? "system"}
                      </span>
                      <span className="prompts-history-rationale">
                        {h.rationale ?? "(no rationale)"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptsPanelImpl({ alwaysOpen = false }: { alwaysOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const isOpen = alwaysOpen || open;
  const [rows, setRows] = useState<Record<string, PromptRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listPrompts();
      setRows(r);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }, []);

  useEffect(() => {
    if (isOpen && rows === null) {
      refresh();
    }
  }, [isOpen, rows, refresh]);

  const overrideCount = useMemo(() => {
    if (!rows) return 0;
    return Object.values(rows).filter((r) => r.override).length;
  }, [rows]);

  return (
    <div className="prompts-panel-wrap">
      <button
        type="button"
        className="prompts-pill"
        onClick={() => setOpen((v) => !v)}
        title="Prompt customization for the four LLM roles"
      >
        <span className="prompts-pill-label">Prompts</span>
        <span className="prompts-pill-value">{overrideCount}</span>
        <svg
          className={`prompts-pill-caret${isOpen ? " is-open" : ""}`}
          width="10" height="10" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {isOpen && (
        <div className="prompts-panel" role="dialog">
          <div className="prompts-panel-header">
            <span className="prompts-panel-title">Prompt overrides</span>
            <span className="prompts-panel-sub">
              {overrideCount}/{ROLES.length} customized
            </span>
          </div>
          {error && (
            <div className="prompts-error">prompt load failed: {error}</div>
          )}
          {rows === null && !error ? (
            <div className="prompts-empty">loading…</div>
          ) : (
            <div className="prompts-list">
              {ROLES.map(({ id, label }) => {
                const row =
                  rows?.[id] ?? {
                    default: "",
                    override: null,
                    last_tweak_ts: null,
                    last_tweak_source: null,
                    last_tweak_rationale: null,
                  };
                return (
                  <PromptRowView
                    key={id}
                    roleId={id}
                    label={label}
                    row={row}
                    onRefresh={refresh}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PromptsPanel = memo(PromptsPanelImpl);
export default PromptsPanel;
