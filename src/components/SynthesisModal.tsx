import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invokeCmd } from "../lib/tauri";
import type { SessionInfo } from "../lib/session-types";

interface SynthResult {
  answer: string;
  sourcesUsed: number;
  sessionId: string | null;
}

type Props = {
  sources: SessionInfo[];
  onClose: () => void;
};

type Turn = { role: "user" | "assistant"; text: string };

/**
 * Cross-session synthesis — thread mode. First question seeds a new
 * Claude session with the selected sources baked into the prompt;
 * subsequent questions --resume that session, so the conversation
 * continues with full context. Model: Claude default (Sonnet) — the
 * sources benefit from good reasoning.
 */
export function SynthesisModal({ sources, onClose }: Props) {
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sourcesUsed, setSourcesUsed] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the thread scrolled to the bottom as answers land.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, sending]);

  async function send() {
    const question = draft.trim();
    if (!question || sending) return;
    setError(null);
    setThread((t) => [...t, { role: "user", text: question }]);
    setDraft("");
    setSending(true);
    try {
      const payload = sources.map((s) => ({
        sessionId: s.id,
        sessionPath: s.path,
        label: projectLabel(s),
      }));
      const result: SynthResult = sessionId
        ? await invokeCmd("continue_synthesis", { sessionId, question })
        : await invokeCmd("synthesize_sessions", {
            question,
            sources: payload,
          });
      setThread((t) => [...t, { role: "assistant", text: result.answer }]);
      if (result.sessionId) setSessionId(result.sessionId);
      if (sourcesUsed == null && result.sourcesUsed > 0) {
        setSourcesUsed(result.sourcesUsed);
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      setThread((t) => [
        ...t,
        { role: "assistant", text: `✗ ${msg}` },
      ]);
    } finally {
      setSending(false);
    }
  }

  const isEmpty = thread.length === 0 && !sending;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box synth-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">📚 Ask across sessions</div>
            <div className="modal-subtitle">
              {sources.length} source{sources.length === 1 ? "" : "s"} ·
              {" "}
              {sessionId ? (
                <span title={`Synthesis session: ${sessionId}`}>
                  thread active (Sonnet)
                </span>
              ) : (
                <span>Sonnet</span>
              )}
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="synth-modal__sources">
          {sources.map((s) => (
            <div key={s.id} className="synth-modal__source">
              <span className="synth-modal__source-id">
                {s.id.slice(0, 8)}
              </span>
              <span className="synth-modal__source-label">{projectLabel(s)}</span>
              <span className="synth-modal__source-turns">
                {s.turn_count} turns
              </span>
            </div>
          ))}
        </div>

        <div className="synth-modal__thread" ref={scrollRef}>
          {isEmpty && (
            <div className="synth-modal__empty">
              Ask anything across these {sources.length} sessions. Replies
              continue in the same thread.
            </div>
          )}
          {thread.map((turn, i) => (
            <div
              key={i}
              className={`synth-modal__turn synth-modal__turn--${turn.role}`}
            >
              <div className="synth-modal__turn-label">
                {turn.role === "user" ? "👤 you" : "🤖 claude"}
              </div>
              <div className="synth-modal__turn-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {turn.text}
                </ReactMarkdown>
              </div>
            </div>
          ))}
          {sending && (
            <div className="synth-modal__turn synth-modal__turn--assistant">
              <div className="synth-modal__turn-label">🤖 claude</div>
              <div className="synth-modal__turn-body synth-modal__pending">
                ⏳ Thinking…
              </div>
            </div>
          )}
        </div>

        <div className="synth-modal__input-row">
          <textarea
            className="synth-modal__input"
            placeholder={
              thread.length === 0
                ? "What do you want to know across these sessions?"
                : "Keep asking…"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={sending}
          />
          <button
            className="modal-btn modal-btn--primary synth-modal__ask-btn"
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
          >
            {sending ? "⏳" : thread.length === 0 ? "Ask" : "Send"}
          </button>
        </div>

        {error && !sending && (
          <div className="synth-modal__error">✗ {error}</div>
        )}
      </div>
    </div>
  );
}

function projectLabel(s: SessionInfo): string {
  const parts = s.project_cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? s.project_cwd;
}
