import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invokeCmd, listenEvent } from "../lib/tauri";
import type { SessionInfo } from "../lib/session-types";

type Props = {
  sources: SessionInfo[];
  onClose: () => void;
};

type Turn = { role: "user" | "assistant"; text: string };

/** Generate a modal-scoped stream id so concurrent synthesis modals don't
 *  collide on Tauri event names. Lives for the lifetime of the modal. */
function makeStreamId() {
  return `synth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  const streamIdRef = useRef<string>(makeStreamId());

  // Keep the thread scrolled to the bottom as tokens land.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, sending]);

  async function send() {
    const question = draft.trim();
    if (!question || sending) return;
    setError(null);
    // Append both the user turn AND an empty assistant turn that will
    // fill in as stream chunks arrive.
    setThread((t) => [
      ...t,
      { role: "user", text: question },
      { role: "assistant", text: "" },
    ]);
    setDraft("");
    setSending(true);
    const streamId = streamIdRef.current;

    // Subscribe to chunk/done/error events for this stream. Appenders
    // mutate the LAST assistant turn so they don't race with further
    // user turns added later.
    const unlistens: Array<() => void> = [];
    const appendChunk = (text: string) =>
      setThread((t) => {
        if (t.length === 0) return t;
        const last = t[t.length - 1];
        if (last.role !== "assistant") return t;
        return [...t.slice(0, -1), { ...last, text: last.text + text }];
      });

    try {
      unlistens.push(
        await listenEvent<{ text: string }>(
          `synth:chunk:${streamId}`,
          (p) => appendChunk(p.text),
        ),
      );
      unlistens.push(
        await listenEvent<{ sessionId?: string | null; sourcesUsed: number }>(
          `synth:done:${streamId}`,
          (p) => {
            if (p.sessionId) setSessionId(p.sessionId);
            if (sourcesUsed == null && p.sourcesUsed > 0) {
              setSourcesUsed(p.sourcesUsed);
            }
            setSending(false);
          },
        ),
      );
      unlistens.push(
        await listenEvent<{ message: string }>(
          `synth:error:${streamId}`,
          (p) => {
            setError(p.message);
            appendChunk(`\n\n✗ ${p.message}`);
            setSending(false);
          },
        ),
      );

      const payload = sources.map((s) => ({
        sessionId: s.id,
        sessionPath: s.path,
        label: projectLabel(s),
      }));
      if (sessionId) {
        await invokeCmd("continue_synthesis_stream", {
          streamId,
          sessionId,
          question,
        });
      } else {
        await invokeCmd("synthesize_sessions_stream", {
          streamId,
          question,
          sources: payload,
        });
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      appendChunk(`\n\n✗ ${msg}`);
      setSending(false);
    } finally {
      // Always release listeners — even on error the backend has already
      // emitted whatever it was going to. A small timeout gives the done
      // event time to land before we unlisten.
      setTimeout(() => {
        for (const fn of unlistens) {
          try {
            fn();
          } catch {
            /* ignored */
          }
        }
      }, 100);
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
          {thread.map((turn, i) => {
            const isStreaming =
              sending &&
              i === thread.length - 1 &&
              turn.role === "assistant";
            return (
              <div
                key={i}
                className={`synth-modal__turn synth-modal__turn--${turn.role}`}
              >
                <div className="synth-modal__turn-label">
                  {turn.role === "user" ? "👤 you" : "🤖 claude"}
                </div>
                <div className="synth-modal__turn-body">
                  {turn.text ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {turn.text}
                    </ReactMarkdown>
                  ) : isStreaming ? (
                    <span className="synth-modal__pending">⏳ Thinking…</span>
                  ) : null}
                  {isStreaming && turn.text && (
                    <span className="synth-modal__cursor">▍</span>
                  )}
                </div>
              </div>
            );
          })}
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
