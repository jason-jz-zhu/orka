import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invokeCmd, listenEvent } from "../lib/tauri";
import type { SessionInfo } from "../lib/session-types";

type Props = {
  /** Sessions the user selected as "attendees" for this meeting. */
  attendees: SessionInfo[];
  onClose: () => void;
};

type Turn = { role: "user" | "assistant"; text: string };

/**
 * "Call a meeting" — cross-session synthesis reframed as a meeting.
 *
 * In the operator-layer narrative each selected session is an
 * "employee" bringing their recent work to the table. The modal
 * composes those tails into a single briefing prompt, ships to
 * `claude -p`, and streams the answer back as meeting minutes.
 *
 * Mechanically identical to the previous SynthesisModal — same
 * `synthesize_sessions_stream` / `continue_synthesis_stream` Tauri
 * commands, same event plumbing. The change is vocabulary + presets
 * + a meeting-minutes output header.
 */
export function MeetingModal({ attendees, onClose }: Props) {
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sourcesUsed, setSourcesUsed] = useState<number | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamIdRef = useRef<string>(makeStreamId());

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, sending]);

  async function send(overrideText?: string) {
    const question = (overrideText ?? draft).trim();
    if (!question || sending) return;
    setError(null);
    setSavedTo(null);
    setThread((t) => [
      ...t,
      { role: "user", text: question },
      { role: "assistant", text: "" },
    ]);
    if (!overrideText) setDraft("");
    setSending(true);
    const streamId = streamIdRef.current;

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

      const payload = attendees.map((s) => ({
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

  async function saveMinutes() {
    if (thread.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const header = [
      `# Meeting minutes — ${today}`,
      ``,
      `**Attendees:**`,
      ...attendees.map((s) => `- ${projectLabel(s)} (\`${s.id.slice(0, 8)}\`)`),
      ``,
      `---`,
      ``,
    ].join("\n");
    const body = thread
      .map((t) =>
        t.role === "user"
          ? `## 🗣 Agenda\n\n${t.text}\n`
          : `### 📝 Minutes\n\n${t.text}\n`,
      )
      .join("\n");
    try {
      // Resolve the workspace-specific outputs dir and compose the
      // target path. write_output_file takes an absolute path + content;
      // it creates parent dirs as needed.
      const dir = await invokeCmd<string>("outputs_dir");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = `${dir}/meeting-${stamp}.md`;
      const saved = await invokeCmd<string>("write_output_file", {
        path,
        content: header + body,
      });
      setSavedTo(saved);
    } catch (e) {
      setError(`Save failed: ${String(e)}`);
    }
  }

  const isEmpty = thread.length === 0 && !sending;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box meeting-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">☎ Call a meeting</div>
            <div className="modal-subtitle">
              {attendees.length} attendee{attendees.length === 1 ? "" : "s"} ·{" "}
              {sessionId ? (
                <span title={`Meeting session: ${sessionId}`}>
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

        <div className="meeting-modal__attendees">
          <div className="meeting-modal__attendees-label">Attendees</div>
          <div className="meeting-modal__attendees-row">
            {attendees.map((s) => (
              <div key={s.id} className="meeting-modal__attendee" title={s.path}>
                <span className="meeting-modal__attendee-avatar">🤖</span>
                <span className="meeting-modal__attendee-name">
                  {projectLabel(s)}
                </span>
                <span className="meeting-modal__attendee-meta">
                  {s.turn_count} turns
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="meeting-modal__thread" ref={scrollRef}>
          {isEmpty && (
            <div className="meeting-modal__empty">
              <div className="meeting-modal__empty-title">
                Pick an agenda — or write your own.
              </div>
              <div className="meeting-modal__presets">
                {AGENDA_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="meeting-modal__preset"
                    onClick={() => void send(preset)}
                    disabled={sending}
                  >
                    {preset}
                  </button>
                ))}
              </div>
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
                className={`meeting-modal__turn meeting-modal__turn--${turn.role}`}
              >
                <div className="meeting-modal__turn-label">
                  {turn.role === "user" ? "🗣 agenda" : "📝 minutes"}
                </div>
                <div className="meeting-modal__turn-body">
                  {turn.text ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {turn.text}
                    </ReactMarkdown>
                  ) : isStreaming ? (
                    <span className="meeting-modal__pending">⏳ Thinking…</span>
                  ) : null}
                  {isStreaming && turn.text && (
                    <span className="meeting-modal__cursor">▍</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="meeting-modal__input-row">
          <textarea
            className="meeting-modal__input"
            placeholder={
              thread.length === 0
                ? "Or write your own agenda…"
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
            className="modal-btn modal-btn--primary meeting-modal__ask-btn"
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
          >
            {sending ? "⏳" : thread.length === 0 ? "Start meeting" : "Send"}
          </button>
        </div>

        {thread.length > 0 && !sending && (
          <div className="meeting-modal__footer">
            <button
              type="button"
              className="modal-btn meeting-modal__save-btn"
              onClick={() => void saveMinutes()}
              disabled={sending}
            >
              💾 Save as meeting notes
            </button>
            {savedTo && (
              <span
                className="meeting-modal__saved"
                title={savedTo}
              >
                ✓ saved to {savedTo.split("/").slice(-1)[0]}
              </span>
            )}
          </div>
        )}

        {error && !sending && (
          <div className="meeting-modal__error">✗ {error}</div>
        )}
      </div>
    </div>
  );
}

function projectLabel(s: SessionInfo): string {
  const parts = s.project_cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? s.project_cwd;
}

function makeStreamId() {
  return `synth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Pre-baked agendas — one click to run common meeting prompts. */
const AGENDA_PRESETS = [
  "Summarize what each person has been working on recently.",
  "What are the common themes, decisions, or blockers across these conversations?",
  "Draft a decision doc from these conversations — what's decided, what's open.",
];
