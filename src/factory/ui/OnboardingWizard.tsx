import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../api";

const STEPS = [
  { id: "welcome", title: "Welcome to your factory", sub: "Let's set things up." },
  { id: "keys",    title: "API keys",                 sub: "Stored locally on this machine." },
  { id: "etsy",    title: "Etsy connection",          sub: "OAuth + draft publish are wired. Connect when ready." },
  { id: "goals",   title: "Goals & niches",           sub: "What kind of shop are you running?" },
  { id: "done",    title: "Ready to run",             sub: 'Press "Start the floor" when you\'re set.' },
];

export default function OnboardingWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [projectName, setProjectName] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [etsyConnected, setEtsyConnected] = useState(false);
  const [etsyShopName, setEtsyShopName] = useState<string | null>(null);
  const [etsyBusy, setEtsyBusy] = useState(false);
  const [etsyErr, setEtsyErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.etsyStatus().then((s) => {
      if (cancelled) return;
      setEtsyConnected(!!s.connected);
      setEtsyShopName(s.shop_name ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, idx]);

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
            <div className="etsy-step">
              {etsyConnected ? (
                <div className="ck ok">
                  Connected to <strong>{etsyShopName || "your shop"}</strong>. You can flip on
                  real publishing from the Etsy panel in the top bar later.
                </div>
              ) : (
                <>
                  <div className="ck">
                    OAuth, draft publishing, receipts polling, and CS auto-replies are all wired.
                    Status: <strong>not connected</strong>.
                  </div>
                  <p className="helper">
                    Click <em>Connect Etsy</em> to start the PKCE flow. Etsy must have approved
                    your Personal app for the authorization page to accept the callback URL
                    (<code>http://localhost:7330/callback</code>). You can also skip this and
                    connect later from the top bar.
                  </p>
                  <button
                    className="modal-btn approve"
                    disabled={etsyBusy}
                    onClick={async () => {
                      setEtsyBusy(true);
                      setEtsyErr(null);
                      try {
                        const { authorize_url } = await api.etsyStartOAuth();
                        await openUrl(authorize_url);
                      } catch (e: any) {
                        setEtsyErr(e?.message || String(e));
                      } finally {
                        setEtsyBusy(false);
                      }
                    }}
                  >
                    {etsyBusy ? "Opening browser…" : "Connect Etsy"}
                  </button>
                  {etsyErr && <div className="ck err">{etsyErr}</div>}
                </>
              )}
            </div>
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
