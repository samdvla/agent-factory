import { useState } from "react";

interface Props {
  agentId: string;
}

export default function ChatPanel({ agentId }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    { from: "user" | "agent"; text: string; ts: number }[]
  >([]);

  const send = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // Chat backend not wired in P1A. UI-only.
    setMessages((m) => [...m, { from: "user", text: trimmed, ts: Date.now() }]);
    setInput("");
  };

  return (
    <div className="drawer-section" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div className="drawer-section-head">Chat</div>
      <div className="chat-list" style={{ flex: 1, maxHeight: "none" }}>
        {messages.length === 0 ? (
          <div className="empty-state">
            Chat backend not wired yet (P2). UI ready — type a message to see it locally.
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.from}`}>
              <div className="chat-bubble">{m.text}</div>
              <div className="chat-time">
                {new Date(m.ts).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="chat-input-row">
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Message ${agentId}…`}
        />
        <button className="chat-send" onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
