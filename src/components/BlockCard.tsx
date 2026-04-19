import { useEffect, useMemo, useRef, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block } from "../lib/markdown-blocks";
import type { Annotation, ThreadMessage } from "../lib/annotations";

type Props = {
  block: Block;
  /** Saved annotation (thread + metadata) for this block, if any. */
  annotation?: Annotation;
  /** True when this block's thread card is currently open. */
  active?: boolean;

  /** Toggle the thread card open/closed. */
  onToggle?: (block: Block) => void;

  /**
   * Append a user note to the thread. No AI call. Called when the user
   * types and presses Shift+Enter (or Cmd+S on an empty input).
   */
  onAddNote?: (block: Block, text: string) => Promise<void> | void;

  /**
   * Send a message to Claude; Claude's reply will stream back into the
   * thread via onAddClaudeMessage at the store level. Called on plain
   * Enter with text.
   */
  onAskClaude?: (block: Block, text: string) => Promise<void> | void;

  /** Toggle the "sync to Apple Notes" flag on the annotation. */
  onToggleNotesSync?: (block: Block, next: boolean) => Promise<void> | void;

  /** Delete the entire thread for this block. */
  onDelete?: (block: Block) => Promise<void> | void;
};

/**
 * Render a markdown block with an optional Word-style comment thread.
 *
 * Interaction model (Notion-minimal + Google-Docs hybrid):
 *   - Block renders as normal markdown.
 *   - Hover reveals a 💬 bubble in the top-right; a counter badge shows
 *     when a thread already exists.
 *   - Clicking opens a thread card in-place below the block. The card
 *     shows all past messages (you + Claude) and a text input.
 *   - Plain Enter sends as "Ask Claude" — the reply streams back into
 *     the same thread.
 *   - Shift+Enter sends as "Note only" — saved to the thread, no AI.
 *   - Esc closes the card without sending.
 *   - A "Sync to Notes" toggle mirrors the thread to Apple Notes.
 *
 * The whole surface is ONE data type (Annotation with thread) and ONE
 * visual element (thread card). No separate "annotate" vs "continue chat"
 * flows — it's one comment thread where Claude can be a participant.
 */
function BlockCardImpl({
  block,
  annotation,
  active,
  onToggle,
  onAddNote,
  onAskClaude,
  onToggleNotesSync,
  onDelete,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const thread = annotation?.thread ?? [];
  const hasThread = thread.length > 0;
  const showBubble = hovered || hasThread || active;

  useEffect(() => {
    if (active) {
      textareaRef.current?.focus();
    } else {
      setDraft("");
    }
  }, [active]);

  async function submit(kind: "ask" | "note") {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      if (kind === "ask") {
        await onAskClaude?.(block, text);
      } else {
        await onAddNote?.(block, text);
      }
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  const typeClass = `block-card--${block.type}`;
  const activeClass = active ? "block-card--active" : "";
  const annotatedClass = hasThread ? "block-card--annotated" : "";

  return (
    <div
      className={`block-card ${typeClass} ${activeClass} ${annotatedClass}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="block-card__body">{renderBlockBody(block)}</div>

      {showBubble && (
        <button
          type="button"
          className={`block-card__indicator ${hasThread ? "block-card__indicator--has" : ""}`}
          title={
            active
              ? "Close"
              : hasThread
                ? `${thread.length} message${thread.length === 1 ? "" : "s"}`
                : "Comment on this block"
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.(block);
          }}
        >
          {hasThread ? `💬 ${thread.length}` : "💬"}
        </button>
      )}

      {active && (
        <div
          className="block-card__thread nodrag nowheel"
          onClick={(e) => e.stopPropagation()}
        >
          {thread.length > 0 && (
            <div className="block-card__thread-messages">
              {thread.map((msg, i) => (
                <ThreadBubble key={i} msg={msg} />
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="block-card__thread-input"
            value={draft}
            placeholder={
              hasThread
                ? "Reply (Enter=ask Claude, Shift+Enter=note)"
                : "Ask Claude about this… (Shift+Enter for a note only)"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                void submit("ask");
              } else if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                void submit("note");
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft("");
                onToggle?.(block);
              }
            }}
            rows={2}
            disabled={sending}
          />
          <div className="block-card__thread-actions">
            <label className="block-card__thread-toggle">
              <input
                type="checkbox"
                checked={annotation?.savedToNotes ?? false}
                onChange={(e) =>
                  void onToggleNotesSync?.(block, e.currentTarget.checked)
                }
              />
              Sync to Apple Notes
            </label>
            <div className="block-card__thread-spacer" />
            {hasThread && (
              <button
                type="button"
                className="block-card__thread-btn block-card__thread-btn--danger"
                onClick={(e) => {
                  e.preventDefault();
                  void onDelete?.(block);
                  onToggle?.(block);
                }}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="block-card__thread-btn"
              disabled={!draft.trim() || sending}
              title="Save as note (Shift+Enter)"
              onClick={() => void submit("note")}
            >
              Note
            </button>
            <button
              type="button"
              className="block-card__thread-btn block-card__thread-btn--primary"
              disabled={!draft.trim() || sending}
              title="Ask Claude (Enter)"
              onClick={() => void submit("ask")}
            >
              {sending ? "⏳" : "Ask Claude"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadBubble({ msg }: { msg: ThreadMessage }) {
  const isYou = msg.author === "you";
  const labelClass = isYou ? "block-card__msg--you" : "block-card__msg--claude";
  const label = isYou ? "👤 you" : "🤖 claude";
  const bodyRendered = useMemo(() => msg.text, [msg.text]);
  return (
    <div className={`block-card__msg ${labelClass}`}>
      <div className="block-card__msg-label">{label}</div>
      <div className="block-card__msg-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{bodyRendered}</ReactMarkdown>
      </div>
    </div>
  );
}

function renderBlockBody(block: Block) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level ?? 1, 1), 6);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag className="block-card__heading">{block.content}</Tag>;
    }
    case "code":
      return (
        <pre className="block-card__code">
          <code className={block.language ? `language-${block.language}` : ""}>
            {block.content}
          </code>
        </pre>
      );
    case "hr":
      return <hr className="block-card__hr" />;
    case "bullet":
      return (
        <div className="block-card__bullet">
          <span className="block-card__bullet-marker" aria-hidden>•</span>
          <div className="block-card__bullet-text">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {stripLeadingMarker(block.content)}
            </ReactMarkdown>
          </div>
        </div>
      );
    case "blockquote":
      return (
        <blockquote className="block-card__blockquote">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {stripBlockquoteMarkers(block.content)}
          </ReactMarkdown>
        </blockquote>
      );
    case "paragraph":
    default:
      return (
        <div className="block-card__paragraph">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
        </div>
      );
  }
}

function stripLeadingMarker(content: string): string {
  return content.replace(/^(\s*)([-*+]|\d+\.)\s+/, "$1");
}

function stripBlockquoteMarkers(content: string): string {
  return content
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, ""))
    .join("\n");
}

export const BlockCard = memo(BlockCardImpl);
