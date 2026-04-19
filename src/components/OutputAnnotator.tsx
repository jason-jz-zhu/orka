import { useEffect, useMemo, useState } from "react";
import { BlockCard } from "./BlockCard";
import { parseBlocks, blockHash, type Block } from "../lib/markdown-blocks";
import { useAnnotations, useOutputAnnotations } from "../lib/annotations";

type Props = {
  /** Full Claude output as a markdown string. */
  markdown: string;
  /**
   * Stable id used as the annotation persistence key. Pass a chat node id
   * for on-canvas outputs, or a run id for the Runs tab.
   */
  runId: string;
};

/**
 * Render a Claude output as a vertical list of annotatable BlockCards,
 * wired to the annotations store for persistence.
 *
 * On mount: triggers a one-shot load from `~/<workspace>/annotations/<runId>.json`
 * (no-op if already loaded). On annotation save/delete: optimistic local
 * update + Tauri write-through.
 *
 * Only one editor is open at a time — clicking a different 💬 closes the
 * current editor (blur commits pending changes first).
 */
export function OutputAnnotator({ markdown, runId }: Props) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown]);

  const load = useAnnotations((s) => s.load);
  const upsert = useAnnotations((s) => s.upsert);
  const remove = useAnnotations((s) => s.remove);
  const annotations = useOutputAnnotations(runId);

  const [activeBlockIdx, setActiveBlockIdx] = useState<number | null>(null);

  useEffect(() => {
    if (runId) void load(runId);
  }, [runId, load]);

  if (blocks.length === 0) return null;

  function toggle(block: Block) {
    setActiveBlockIdx((cur) => (cur === block.idx ? null : block.idx));
  }

  function onSave(block: Block, text: string) {
    void upsert(runId, {
      blockIdx: block.idx,
      blockHash: blockHash(block),
      blockType: block.type,
      blockContent: block.content,
      text,
    });
  }

  function onDelete(block: Block) {
    void remove(runId, block.idx);
  }

  return (
    <div className="output-annotator">
      {blocks.map((block) => (
        <BlockCard
          key={`${runId}-${block.idx}`}
          block={block}
          active={activeBlockIdx === block.idx}
          annotationText={annotations.get(block.idx)?.text}
          onToggle={toggle}
          onSave={onSave}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
