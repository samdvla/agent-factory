import { useState } from "react";
import { api } from "../../api";

const STEPS = [
  { id: "welcome", title: "Welcome to your factory", sub: "Let's set things up." },
  { id: "keys",    title: "API keys",                 sub: "Stored in your OS keychain." },
  { id: "etsy",    title: "Etsy connection",          sub: "We'll wire this up in P3." },
  { id: "goals",   title: "Goals & niches",           sub: "What kind of shop are you running?" },
  { id: "done",    title: "Ready to run",             sub: 'Press "Start the floor" when you\'re set.' },
];

export default function OnboardingWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [projectName, setProjectName] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);

  if (!open) return null;

  const step = STEPS[idx];

  const next = async () => {
    if (step.id === "keys" && anthropicKey) {
      await api.setSecret("anthropic_api_key", anthropicKey);
      setKeySaved(true);
      setAnthropicKey("");
    }
    if (idx >= STEPS.length - 1) {
      onClose();
      setIdx(0);
    } else {
      setIdx(idx + 1);
    }
  };

  const back = () => setIdx(Math.max(0, idx - 1));

  return (
    <div className="wiz-back">
      <div className="wizard">
        <div className="wiz-rail">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`wiz-step${i < idx ? " done" : ""}${i === idx ? " on" : ""}`}
            >
              <div className="bar" />
              <div className="lb">{s.id}</div>
            </div>
          ))}
        </div>
        <div className="wiz-body">
          <h2>{step.title}</h2>
          <p className="sub">{step.sub}</p>

          {step.id === "welcome" && (
            <>
              <label>Project name</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g. Wabi-Sabi Ceramics"
              />
              <p className="helper">Just a label — you can change this later.</p>
            </>
          )}

          {step.id === "keys" && (
            <>
              <label>Anthropic API key</label>
              <input
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-…"
              />
              <p className="helper">Stored in your OS keychain — never written to disk in plaintext.</p>
              {keySaved && <div className="ck ok">Key saved.</div>}
            </>
          )}

          {step.id === "etsy" && (
            <div className="ck">Etsy seller account + OAuth wiring lands in P3. Skip for now.</div>
          )}

          {step.id === "goals" && (
            <>
              <label>What's your shop's first niche?</label>
              <input type="text" placeholder="e.g. handmade ceramic mugs" />
              <p className="helper">Optional — Research can also pick a niche for you.</p>
            </>
          )}

          {step.id === "done" && (
            <div className="ck ok">All set. Click "Start the floor" to begin.</div>
          )}
        </div>
        <footer className="wiz-f">
          <span className="lh">Step {idx + 1} of {STEPS.length}</span>
          <div className="rh">
            {idx > 0 && <button className="modal-btn" onClick={back}>Back</button>}
            <button className="modal-btn" onClick={onClose}>Skip</button>
            <button className="modal-btn approve" onClick={next}>
              {idx >= STEPS.length - 1 ? "Start the floor" : "Continue"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
