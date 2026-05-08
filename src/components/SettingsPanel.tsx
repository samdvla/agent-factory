import { useEffect, useState } from "react";
import { api } from "../api";

export default function SettingsPanel() {
  const [anthropicKey, setAnthropicKey] = useState("");
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    api.getSecret("anthropic_api_key").then((v) => setHasKey(!!v));
  }, []);

  const save = async () => {
    if (!anthropicKey) return;
    await api.setSecret("anthropic_api_key", anthropicKey);
    setAnthropicKey("");
    setHasKey(true);
  };

  return (
    <div style={{ padding: 16, maxWidth: 540 }}>
      <h2>Settings</h2>
      <section style={{ marginBottom: 24 }}>
        <h3>API Keys</h3>
        <p style={{ color: "#9aa0a8" }}>
          Stored in your OS keychain — never written to disk in plaintext.
        </p>
        <label style={{ display: "block", marginBottom: 4 }}>
          Anthropic API key {hasKey && <span style={{ color: "#7fd47b" }}>(set)</span>}
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            placeholder="sk-ant-…"
            style={{ flex: 1, padding: "6px 8px" }}
          />
          <button onClick={save} disabled={!anthropicKey}>Save</button>
        </div>
      </section>
    </div>
  );
}
