import { useEffect } from "react";
import { useFactoryStore } from "../state/factoryStore";

export default function GateModal() {
  const pendingGate = useFactoryStore((s) => s.pendingGate);
  const setPendingGate = useFactoryStore((s) => s.setPendingGate);

  // Test shortcut: press 'g' to populate a fixture gate request.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "g" && !pendingGate) {
        setPendingGate({
          agent: "publisher",
          actionClass: "etsy.publish",
          title: 'Publish listing #41 — "Wabi-Sabi Ceramic Mug, Daylight Matte"',
          rationale:
            "Listing meets all draft checks. Photo variant 2 approved by Designer. Tags pulled from this week's top trending. Price $34, COGS $11, margin 68%. Held at gate per project rule \"publishing requires user approval\".",
          payload: {
            title: "Wabi-Sabi Ceramic Mug · Daylight Matte · Handmade",
            price_usd: 34,
            quantity: 12,
            tags: ["cottagecore mug", "wabi-sabi", "handmade ceramic", "irregular handle", "matte glaze"],
            primary_image: "render_v2.png",
            shop: "sandbox-etsy-001",
          },
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingGate, setPendingGate]);

  if (!pendingGate) return null;

  const close = () => setPendingGate(null);

  return (
    <div className="modal-scrim is-open">
      <div className="modal">
        <div className="modal-head">
          <span className="modal-tag">{pendingGate.actionClass}</span>
          <div className="modal-title">{pendingGate.title}</div>
          <div className="modal-sub">
            Agent: {pendingGate.agent}
          </div>
        </div>
        <div className="modal-body">
          <div className="modal-section">
            <h4 className="section-label">Rationale</h4>
            <p>{pendingGate.rationale}</p>
          </div>
          <div className="modal-section">
            <h4 className="section-label">Payload</h4>
            <pre className="payload">
              {JSON.stringify(pendingGate.payload, null, 2)}
            </pre>
          </div>
        </div>
        <footer className="modal-foot">
          <button className="modal-btn reject" onClick={close}>Reject</button>
          <button className="modal-btn approve" onClick={close}>Approve</button>
        </footer>
      </div>
    </div>
  );
}
