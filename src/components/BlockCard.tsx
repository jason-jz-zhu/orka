import { useEffect, useRef, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block } from "../lib/markdown-blocks";

type Props = {
  block: Block;
  /** The saved annotation text for this block, if any. */
  annotationText?: string;
  /** True when this block's editor is currently open. */
  active?: boolean;
  /** Called when the user clicks 💬 to open the editor. */
  onToggle?: (block: Block) => void;
  /** Called with the new text when the user presses save (⌘+Enter or blur). */
  onSave?: (block: Block, text: string) => void;
  /** Called when the user removes the annotation. */
  onDelete?: (block: Block) => void;

  /**
   * One-click quick save — no editor, no annotation. Primary hover action
   * because "I want to keep this block" is by far the highest-frequency
   * intent in daily use. Parent typically appends the raw block markdown
   * to Apple Notes.
   */
  onQuickSave?: (block: Block) => Promise<void> | void;
  /**
   * Editor-mode save that also sends block + annotation to the
   * destination. Shown inside the open editor, never on hover.
   */
  onSaveToNotes?: (block: Block, annotation: string) => Promise<void> | void;
};

/**
 * Render a single markdown block with:
 *   - type-aware visual styling (heading/code/bullet/…)
 *   - hover-revealed 💬 indicator (always visible when annotated or active)
 *   - inline editor that expands below the block when active
 *
 * Editor UX:
 *   - textarea auto-focuses on open
 *   - ⌘/Ctrl+Enter saves, Escape closes without saving
 *   - Save on blur
 *   - Delete button when there's an existing annotation
 */
function BlockCardImpl({
  block,
  annotationText,
  active,
  onToggle,
  onSave,
  onDelete,
  onQuickSave,
  onSaveToNotes,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState(annotationText ?? "");
  const [quickState, setQuickState] = useState<"idle" | "saving" | "saved">("idle");
  const [dispatching, setDispatching] = useState<null | "notes">(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const hasAnnotation = !!annotationText && annotationText.trim().length > 0;
  const showIndicator = hovered || hasAnnotation || active;

  // Keep the draft in sync when the saved value changes from outside
  // (e.g., reload from backend, switch blocks while editor is open).
  useEffect(() => {
    setDraft(annotationText ?? "");
  }, [annotationText, block.idx]);

  // Auto-focus when the editor opens.
  useEffect(() => {
    if (active) {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        textareaRef.current.value.length,
        textareaRef.current.value.length,
      );
    }
  }, [active]);

  const commitIfChanged = () => {
    const next = draft.trim();
    const prev = (annotationText ?? "").trim();
    if (next === prev) return;
    if (next === "") {
      if (prev !== "") onDelete?.(block);
    } else {
      onSave?.(block, next);
    }
  };

  const typeClass = `block-card--${block.type}`;
  const activeClass = active ? "block-card--active" : "";
  const annotatedClass = hasAnnotation ? "block-card--annotated" : "";

  return (
    <div
      className={`block-card ${typeClass} ${activeClass} ${annotatedClass}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="block-card__body">{renderBlockBody(block)}</div>

      {showIndicator && (
        <div className="block-card__hover-actions">
          {onQuickSave && !active && (
            <button
              type="button"
              className={`block-card__quick-btn ${quickState === "saved" ? "block-card__quick-btn--saved" : ""}`}
              title="Save this block to Apple Notes"
              disabled={quickState === "saving"}
              onClick={async (e) => {
                e.stopPropagation();
                if (quickState !== "idle") return;
                setQuickState("saving");
                try {
                  await onQuickSave(block);
                  setQuickState("saved");
                  window.setTimeout(() => setQuickState("idle"), 1500);
                } catch {
                  setQuickState("idle");
                }
              }}
            >
              {quickState === "saving" ? "⏳" : quickState === "saved" ? "✓" : "📝"}
            </button>
          )}
          <button
            type="button"
            className={`block-card__indicator ${hasAnnotation ? "block-card__indicator--has" : ""}`}
            title={active ? "Close" : hasAnnotation ? "Edit note" : "Add a note"}
            onClick={(e) => {
              e.stopPropagation();
              if (active) commitIfChanged();
              onToggle?.(block);
            }}
          >
            💬
          </button>
        </div>
      )}

      {active && (
        <div className="block-card__annot-editor nodrag nowheel" onClick={(e) => e.stopPropagation()}>
          <textarea
            ref={textareaRef}
            className="block-card__annot-textarea"
            value={draft}
            placeholder="Your note about this block… (⌘+Enter to save, Esc to close)"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitIfChanged}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitIfChanged();
                onToggle?.(block);
              } else if (e.key === "Escape") {
                e.preventDefault();
                // Revert draft, then close.
                setDraft(annotationText ?? "");
                onToggle?.(block);
              }
            }}
            rows={3}
          />
          <div className="block-card__annot-actions">
            {hasAnnotation && (
              <button
                type="button"
                className="block-card__annot-btn block-card__annot-btn--danger"
                onClick={(e) => {
                  e.preventDefault();
                  setDraft("");
                  onDelete?.(block);
                  onToggle?.(block);
                }}
              >
                Delete
              </button>
            )}
            <div className="block-card__annot-spacer" />
            <button
              type="button"
              className="block-card__annot-btn"
              onClick={(e) => {
                e.preventDefault();
                setDraft(annotationText ?? "");
                onToggle?.(block);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="block-card__annot-btn block-card__annot-btn--primary"
              disabled={draft.trim() === (annotationText ?? "").trim()}
              onClick={(e) => {
                e.preventDefault();
                commitIfChanged();
                onToggle?.(block);
              }}
            >
              Save
            </button>
          </div>

          {onSaveToNotes && (
            <div className="block-card__annot-dispatch">
              <button
                type="button"
                className="block-card__dispatch-btn"
                disabled={dispatching !== null}
                onClick={async (e) => {
                  e.preventDefault();
                  commitIfChanged();
                  setDispatching("notes");
                  try {
                    await onSaveToNotes(block, draft.trim());
                  } finally {
                    setDispatching(null);
                  }
                }}
                title="Append this block and your note to Apple Notes"
              >
                {dispatching === "notes" ? "⏳ Saving…" : "📝 Save to Notes with note"}
              </button>
            </div>
          )}
        </div>
      )}
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
