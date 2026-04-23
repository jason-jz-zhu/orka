import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { extractSkillMdDraft, type SkillMdDraft } from "../lib/hire-extract";

type Props = {
  /** Opening user turn pre-filled from the "+ Hire" button context.
   *  Empty string to let the user type the first message themselves. */
  initialGoal?: string;
  onClose: () => void;
  /** Called once the user saves a drafted skill. Parent refreshes the
   *  sidebar and auto-selects the new skill. */
  onSaved?: (slug: string, path: string) => void;
};

type Turn = { role: "user" | "assistant"; text: string };

function makeStreamId() {
  return `hire-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * "Hire by chat" — multi-turn conversation with orka-skill-builder.
 *
 * v1 of the hiring flow was a one-shot promptDialog → seeded runner.
 * v2 turns that into a real back-and-forth: Claude acts as the
 * skill-builder, asks clarifying questions, and drafts a SKILL.md the
 * user can save without ever opening a file. Drafts are detected via
 * a fenced `skill-md` code block in the stream and shown as a
 * preview + "Save as new skill" CTA.
 */
export function HireChatModal({ initialGoal, onClose, onSaved }: Props) {
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState(initialGoal ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillMdDraft | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamIdRef = useRef<string>(makeStreamId());

  // Auto-send the prefilled initial goal on mount so the user doesn't
  // have to click twice. If initialGoal is empty, wait for them to type.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (initialGoal && initialGoal.trim().length > 0) {
      seededRef.current = true;
      void send(initialGoal.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGoal]);

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
        const next = [...t.slice(0, -1), { ...last, text: last.text + text }];
        // Re-scan the current assistant turn for a draft each chunk;
        // the CTA shows up as soon as Claude finishes a fenced block.
        const found = extractSkillMdDraft(next[next.length - 1].text);
        if (found) setSkillDraft(found);
        return next;
      });

    try {
      unlistens.push(
        await listenEvent<{ text: string }>(
          `hire:chunk:${streamId}`,
          (p) => appendChunk(p.text),
        ),
      );
      unlistens.push(
        await listenEvent<{ sessionId?: string | null }>(
          `hire:done:${streamId}`,
          (p) => {
            if (p.sessionId) setSessionId(p.sessionId);
            setSending(false);
          },
        ),
      );
      unlistens.push(
        await listenEvent<{ message: string }>(
          `hire:error:${streamId}`,
          (p) => {
            setError(p.message);
            appendChunk(`\n\n✗ ${p.message}`);
            setSending(false);
          },
        ),
      );

      if (sessionId) {
        await invokeCmd("continue_hire_chat_stream", {
          streamId,
          sessionId,
          userTurn: question,
        });
      } else {
        await invokeCmd("start_hire_chat_stream", {
          streamId,
          userTurn: question,
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

  async function hireNow() {
    if (!skillDraft || saving) return;
    if (!skillDraft.slug) {
      setError("Draft has no `name:` frontmatter — ask the agent to fill it in, or edit manually.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const path = await invokeCmd<string>("save_drafted_skill", {
        slug: skillDraft.slug,
        content: skillDraft.content,
      });
      setSavedTo(path);
      onSaved?.(skillDraft.slug, path);
    } catch (e) {
      setError(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const isEmpty = thread.length === 0 && !sending;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box hire-chat-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">✨ Hire a new agent</div>
            <div className="modal-subtitle">
              Describe what you want automated. The skill-builder drafts a
              SKILL.md you can save with one click.
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="hire-chat-modal__body">
          <div className="hire-chat-modal__thread" ref={scrollRef}>
            {isEmpty && (
              <div className="hire-chat-modal__empty">
                Type one sentence to start. Example:
                <ul className="hire-chat-modal__examples">
                  <li>
                    Every morning at 9, summarise yesterday's PRs I reviewed
                    and email me the top 3.
                  </li>
                  <li>
                    Watch my ~/Desktop/notes folder; weekly, produce a
                    digest and save to Apple Notes.
                  </li>
                  <li>
                    Turn the last Orka run into a meeting note I can paste
                    into Slack.
                  </li>
                </ul>
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
                  className={`hire-chat-modal__turn hire-chat-modal__turn--${turn.role}`}
                >
                  <div className="hire-chat-modal__turn-label">
                    {turn.role === "user" ? "🗣 you" : "🤖 builder"}
                  </div>
                  <div className="hire-chat-modal__turn-body">
                    {turn.text ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {turn.text}
                      </ReactMarkdown>
                    ) : isStreaming ? (
                      <span className="hire-chat-modal__pending">
                        ⏳ Thinking…
                      </span>
                    ) : null}
                    {isStreaming && turn.text && (
                      <span className="hire-chat-modal__cursor">▍</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {skillDraft && (
            <div className="hire-chat-modal__preview">
              <div className="hire-chat-modal__preview-head">
                <span className="hire-chat-modal__preview-label">
                  ✨ DRAFT SKILL
                </span>
                <span className="hire-chat-modal__preview-slug">
                  {skillDraft.slug ?? "(missing name — edit frontmatter)"}
                </span>
              </div>
              <pre className="hire-chat-modal__preview-body">
                {skillDraft.content}
              </pre>
              <div className="hire-chat-modal__preview-actions">
                <button
                  type="button"
                  className="modal-btn modal-btn--primary"
                  onClick={() => void hireNow()}
                  disabled={saving || !skillDraft.slug}
                  title={
                    skillDraft.slug
                      ? `Save as ~/.claude/skills/${skillDraft.slug}/SKILL.md`
                      : "Draft needs a `name:` in its frontmatter before it can be saved"
                  }
                >
                  {saving ? "⏳ Hiring…" : "✓ Hire this agent"}
                </button>
                {savedTo && (
                  <span className="hire-chat-modal__saved">
                    ✓ saved to {savedTo.split("/").slice(-2).join("/")}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="hire-chat-modal__input-row">
          <textarea
            className="hire-chat-modal__input"
            placeholder={
              thread.length === 0
                ? "Describe the agent…"
                : "Keep refining…"
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
            className="modal-btn modal-btn--primary hire-chat-modal__send"
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
          >
            {sending ? "⏳" : thread.length === 0 ? "Start" : "Send"}
          </button>
        </div>

        {error && !sending && (
          <div className="hire-chat-modal__error">✗ {error}</div>
        )}
      </div>
    </div>
  );
}
