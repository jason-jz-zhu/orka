import { useMemo } from "react";
import { BlockCard } from "./BlockCard";
import { parseBlocks, type Block } from "../lib/markdown-blocks";

type Props = {
  /** Full Claude output as a markdown string. */
  markdown: string;
  /**
   * Stable id for the run that produced this output. Used as the key under
   * which annotations are persisted. Pass a chat node id or a Runs row id.
   */
  runId: string;
  /**
   * Optional: called when the user clicks the annotation indicator on a
   * block. Parent owns the sidebar UI for now — Annotator only renders
   * the block list and emits events.
   */
  onAnnotate?: (block: Block, runId: string) => void;
  /**
   * Optional: the block currently being annotated (highlighted while the
   * sidebar is open for it).
   */
  activeBlockIdx?: number;
  /**
   * Optional: set of block indices that have saved annotations, so the
   * 💬 indicator renders as filled.
   */
  annotatedBlockIdxs?: ReadonlySet<number>;
};

/**
 * Render a Claude output as a vertical list of annotatable BlockCards.
 *
 * Parsing is memoized on the markdown input — re-rendering the component
 * with the same output (e.g., on hover of another part of the UI) does
 * not re-run the parser.
 *
 * This component is intentionally stateless about annotations themselves;
 * the parent (typically a chat node or Runs detail view) owns annotation
 * state and the sidebar UI. This keeps the Annotator reusable in any
 * context where Claude output is rendered.
 */
export function OutputAnnotator({
  markdown,
  runId,
  onAnnotate,
  activeBlockIdx,
  annotatedBlockIdxs,
}: Props) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown]);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="output-annotator">
      {blocks.map((block) => (
        <BlockCard
          key={`${runId}-${block.idx}`}
          block={block}
          active={activeBlockIdx === block.idx}
          hasAnnotation={annotatedBlockIdxs?.has(block.idx) ?? false}
          onAnnotateClick={(b) => onAnnotate?.(b, runId)}
        />
      ))}
    </div>
  );
}
