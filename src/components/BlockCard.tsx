import { useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block } from "../lib/markdown-blocks";

type Props = {
  block: Block;
  /** Optional: renders a badge in the top-right when an annotation exists. */
  hasAnnotation?: boolean;
  /** Optional: called when the user clicks the 💬 indicator. */
  onAnnotateClick?: (block: Block) => void;
  /** Optional: highlight this block (e.g., when the annotation panel is open for it). */
  active?: boolean;
};

/**
 * Render a single markdown block as a selectable, annotatable card.
 *
 * Each block type gets type-specific styling so hierarchy is preserved
 * visually (headings larger, code blocks monospaced, blockquotes indented).
 * The annotation indicator only appears on hover, to keep the output
 * reading like clean markdown until the user wants to mark something.
 */
function BlockCardImpl({ block, hasAnnotation, onAnnotateClick, active }: Props) {
  const [hovered, setHovered] = useState(false);
  const showIndicator = hovered || hasAnnotation || active;

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
        <button
          type="button"
          className={`block-card__indicator ${hasAnnotation ? "block-card__indicator--has" : ""}`}
          title={hasAnnotation ? "View annotation" : "Annotate this block"}
          onClick={(e) => {
            e.stopPropagation();
            onAnnotateClick?.(block);
          }}
        >
          💬
        </button>
      )}
    </div>
  );
}

function renderBlockBody(block: Block) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level ?? 1, 1), 6);
      // Render as a heading element directly to avoid ReactMarkdown wrapping it in a <p>.
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
      // Render the bullet content through markdown so inline formatting
      // (bold, code, links) works, but keep the leading list marker visible
      // so the block looks list-like without being in a <ul>.
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

/** Remove the leading bullet marker so ReactMarkdown doesn't re-render a list item. */
function stripLeadingMarker(content: string): string {
  return content.replace(/^(\s*)([-*+]|\d+\.)\s+/, "$1");
}

/** Strip `> ` prefixes — parseBlocks keeps them in .content; ReactMarkdown would turn them into a real <blockquote> causing double nesting. */
function stripBlockquoteMarkers(content: string): string {
  return content
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, ""))
    .join("\n");
}

export const BlockCard = memo(BlockCardImpl);
