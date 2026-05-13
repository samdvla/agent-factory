import { useEffect, useRef, useState } from "react";
import { api, type ChatTurn, type SteerEntry } from "../../api";

interface Props {
  agentId: string;
}

type Msg = (ChatTurn | { from: "system"; text: string }) & { ts: number };

const STEER_MAX_LEN = 2000;
// Cap at 5 MB pre-upload so we don't spend cycles encoding files we know
// the Rust side will reject. The 8 MB ceiling in prompts::save_steer_image
// leaves a small margin for base64 expansion and accidental over-cap.
const STEER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const STEER_IMAGE_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

type PendingAttachment = {
  file: File;
  dataUrl: string;
  ext: string;
};

export default function ChatPanel({ agentId }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steerableRoles, setSteerableRoles] = useState<string[] | null>(null);
  const [steers, setSteers] = useState<SteerEntry[]>([]);
  const [steerBusy, setSteerBusy] = useState(false);
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Wipe history when the selected agent changes — chat is per-agent.
  useEffect(() => {
    setMessages([]);
    setError(null);
    setInput("");
    setAttachment(null);
  }, [agentId]);

  // Auto-scroll to bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // One-time fetch: which agent ids accept Steer (the 4 LLM-driven roles).
  useEffect(() => {
    let cancelled = false;
    api
      .agentSteerRoles()
      .then((roles) => {
        if (!cancelled) setSteerableRoles(roles);
      })
      .catch(() => {
        if (!cancelled) setSteerableRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-agent: load current steer count whenever the selected agent changes.
  useEffect(() => {
    let cancelled = false;
    if (!steerableRoles?.includes(agentId)) {
      setSteers([]);
      return;
    }
    api
      .agentSteerList(agentId)
      .then((s) => {
        if (!cancelled) setSteers(s);
      })
      .catch(() => {
        if (!cancelled) setSteers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, steerableRoles]);

  const isSteerable = !!steerableRoles?.includes(agentId);

  const send = async () => {
    const trimmed = input.trim();
    if (!trimmed || pending) return;
    const userMsg: Msg = { from: "user", text: trimmed, ts: Date.now() };
    const nextHistory: Msg[] = [...messages, userMsg];
    setMessages(nextHistory);
    setInput("");
    setError(null);
    setPending(true);
    try {
      // Only user/agent turns go to the bridge — system markers stay local.
      const history: ChatTurn[] = messages
        .filter((m): m is ChatTurn & { ts: number } =>
          m.from === "user" || m.from === "agent",
        )
        .map((m) => ({ from: m.from, text: m.text }));
      const reply = await api.chatWithAgent(agentId, history, trimmed);
      setMessages((m) => [
        ...m,
        { from: "agent", text: reply.text, ts: Date.now() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setPending(false);
    }
  };

  const pickAttachment = () => {
    fileInputRef.current?.click();
  };

  const onAttachmentSelected = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ext = STEER_IMAGE_MIMES[file.type];
    if (!ext) {
      setError(
        `Unsupported image type: ${file.type || "unknown"}. Use PNG, JPG, WebP, or GIF.`,
      );
      return;
    }
    if (file.size > STEER_IMAGE_MAX_BYTES) {
      setError(
        `Image too large: ${(file.size / 1024 / 1024).toFixed(1)} MB ` +
          `(max ${STEER_IMAGE_MAX_BYTES / 1024 / 1024} MB). Resize before attaching.`,
      );
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      setAttachment({ file, dataUrl, ext });
      setError(null);
    } catch (err) {
      setError(`Couldn't read file: ${err instanceof Error ? err.message : err}`);
    }
  };

  const clearAttachment = () => setAttachment(null);

  const steer = async () => {
    const trimmed = input.trim();
    if (!trimmed || steerBusy || !isSteerable) return;
    if (trimmed.length > STEER_MAX_LEN) {
      setError(
        `Steer too long: ${trimmed.length} chars (max ${STEER_MAX_LEN}). ` +
          `Tighten it down to a single rule.`,
      );
      return;
    }
    setError(null);
    setSteerBusy(true);
    try {
      const imagePaths: string[] = [];
      if (attachment) {
        const buf = new Uint8Array(await attachment.file.arrayBuffer());
        const savedPath = await api.agentSteerSaveImage(
          agentId,
          buf,
          attachment.ext,
        );
        imagePaths.push(savedPath);
      }
      await api.agentSteerAdd(agentId, trimmed, imagePaths);
      const refreshed = await api.agentSteerList(agentId);
      setSteers(refreshed);
      setMessages((m) => [
        ...m,
        {
          from: "system",
          text:
            `Standing instruction saved` +
            (imagePaths.length ? " with reference image" : "") +
            `. ${agentId} will honor this on every future job (until you clear it).`,
          ts: Date.now(),
        },
      ]);
      setInput("");
      setAttachment(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSteerBusy(false);
    }
  };

  const clearSteers = async () => {
    if (steerBusy || !isSteerable || steers.length === 0) return;
    setSteerBusy(true);
    try {
      await api.agentSteerClear(agentId);
      setSteers([]);
      setMessages((m) => [
        ...m,
        {
          from: "system",
          text: `Cleared all standing instructions for ${agentId}.`,
          ts: Date.now(),
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSteerBusy(false);
    }
  };

  const inputBusy = pending || steerBusy;
  // How many images are already attached across saved steers — used to
  // tell the user that prior attachments are still active.
  const savedImageCount = steers.reduce(
    (acc, s) => acc + (s.image_paths?.length ?? 0),
    0,
  );

  return (
    <div
      className="drawer-section"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <div className="drawer-section-head">Chat</div>
      <div
        ref={listRef}
        className="chat-list"
        style={{ flex: 1, maxHeight: "none", overflowY: "auto" }}
      >
        {messages.length === 0 && !pending ? (
          <div className="empty-state">
            Say hi, ask what they're up to, or steer their focus. Each agent
            has its own conversation.
          </div>
        ) : (
          <>
            {messages.map((m, i) => {
              if (m.from === "system") {
                return (
                  <div key={i} className="chat-bubble system">
                    {m.text}
                  </div>
                );
              }
              return (
                <div
                  key={i}
                  className={`chat-bubble ${m.from === "user" ? "user" : "agent"}`}
                >
                  {m.text}
                </div>
              );
            })}
            {pending && (
              <div className="chat-bubble agent typing">…</div>
            )}
          </>
        )}
        {error && (
          <div className="chat-bubble system error" style={{ alignSelf: "stretch" }}>
            <div
              style={{
                fontSize: 11,
                opacity: 0.9,
                color: "var(--accent-bad, #e85a5a)",
              }}
            >
              {error.length > 220 ? error.slice(0, 217) + "…" : error}
            </div>
          </div>
        )}
      </div>
      {isSteerable && steers.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 20px",
            fontSize: 11,
            color: "var(--ink-1, #9aa5a0)",
            background: "rgba(120, 200, 140, 0.06)",
            borderTop: "1px solid var(--line)",
          }}
          title={steers
            .map((s, i) => {
              const imgNote = s.image_paths.length
                ? ` [+${s.image_paths.length} image${s.image_paths.length === 1 ? "" : "s"}]`
                : "";
              return `${i + 1}. ${s.text}${imgNote}`;
            })
            .join("\n")}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M9 2 H13 L10.5 5 V8 L13 11 H3 L5.5 8 V5 L3 2 Z" />
              <path d="M8 11 V14" />
            </svg>
            {steers.length} standing instruction
            {steers.length === 1 ? "" : "s"} active
            {savedImageCount > 0 && (
              <span style={{ opacity: 0.7 }}>
                · {savedImageCount} ref image{savedImageCount === 1 ? "" : "s"}
              </span>
            )}
          </span>
          <button
            className="chat-send"
            style={{ padding: "2px 10px", fontSize: 11 }}
            onClick={clearSteers}
            disabled={steerBusy}
          >
            Clear
          </button>
        </div>
      )}
      {isSteerable && attachment && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 20px",
            fontSize: 11,
            color: "var(--ink-1, #9aa5a0)",
            background: "rgba(120, 160, 240, 0.06)",
            borderTop: "1px solid var(--line)",
          }}
        >
          <img
            src={attachment.dataUrl}
            alt="steer reference"
            style={{
              width: 40,
              height: 40,
              objectFit: "cover",
              borderRadius: 4,
              border: "1px solid var(--line)",
            }}
          />
          <span style={{ flex: 1, lineHeight: 1.3 }}>
            <strong style={{ color: "var(--ink-0, #d8dfd9)" }}>
              Reference image attached
            </strong>
            <br />
            <span style={{ opacity: 0.75 }}>
              {attachment.file.name} ·{" "}
              {(attachment.file.size / 1024).toFixed(0)} KB · sent with next
              steer
            </span>
          </span>
          <button
            type="button"
            className="chat-send"
            style={{ padding: "2px 10px", fontSize: 11 }}
            onClick={clearAttachment}
            disabled={steerBusy}
            aria-label="Remove attached reference image"
          >
            Remove
          </button>
        </div>
      )}
      {isSteerable && (
        <div className="chat-steer-bar">
          <button
            type="button"
            className="chat-steer"
            onClick={pickAttachment}
            disabled={inputBusy}
            title="Attach a reference image (PNG, JPG, WebP, or GIF up to 5 MB). The next steer you save will include it."
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M11.5 5 L6 10.5 a2 2 0 1 1-2.8-2.8 L9 2 a3 3 0 0 1 4.2 4.2 L7 12.5 a4 4 0 0 1-5.7-5.7" />
            </svg>
            {attachment ? "Image attached" : "Attach image"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={onAttachmentSelected}
          />
          <button
            type="button"
            className="chat-steer"
            onClick={steer}
            disabled={inputBusy || !input.trim()}
            title="Save the current message as a standing instruction. Applied to every future job until cleared."
          >
            {steerBusy ? "Saving…" : "↳ Steer"}
          </button>
        </div>
      )}
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
          placeholder={
            pending
              ? "Waiting for reply…"
              : steerBusy
                ? "Saving instruction…"
                : `Message ${agentId}…`
          }
          disabled={inputBusy}
        />
        <button
          className="chat-send"
          onClick={send}
          disabled={inputBusy || !input.trim()}
        >
          {pending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
