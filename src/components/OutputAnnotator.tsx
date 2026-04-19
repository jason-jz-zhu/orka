import { useEffect, useMemo, useState } from "react";
import { BlockCard } from "./BlockCard";
import { parseBlocks, blockHash, type Block } from "../lib/markdown-blocks";
import { useAnnotations, useOutputAnnotations } from "../lib/annotations";
import { invokeCmd } from "../lib/tauri";
import { alertDialog } from "../lib/dialogs";

type Props = {
  /** Full Claude output as a markdown string. */
  markdown: string;
  /**
   * Stable id used as the annotation persistence key. Pass a chat node id
   * for on-canvas outputs, or a run id for the Runs tab.
   */
  runId: string;

  /**
   * Human-friendly title for the source of the output — used in dispatch
   * destinations (e.g., Apple Notes title "Orka · weekly-audit").
   */
  sourceTitle?: string;

  /**
   * Hook for "❓ Ask Claude". Parent typically spawns a new chat node on
   * the canvas near the source, pre-filled with block + annotation as
   * context. Omit to hide the button.
   */
  onAskClaude?: (block: Block, annotation: string) => Promise<void> | void;

  /**
   * Hook for "💾 New skill". Parent handles the name prompt and calls the
   * save_node_as_skill command. Omit to hide the button.
   */
  onMakeSkill?: (block: Block, annotation: string) => Promise<void> | void;
};

/**
 * Render a Claude output as a vertical list of annotatable BlockCards
 * with three dispatch actions on each:
 *   - 📝 Apple Notes (built-in; no parent context needed)
 *   - ❓ Ask Claude (requires parent handler)
 *   - 💾 New skill (requires parent handler)
 */
export function OutputAnnotator({
  markdown,
  runId,
  sourceTitle,
  onAskClaude,
  onMakeSkill,
}: Props) {
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

  /** Save to Notes — compose block + annotation as markdown, convert to HTML, append. */
  async function saveToNotes(block: Block, annotation: string) {
    const title = sourceTitle ? `Orka · ${sourceTitle}` : "Orka · Inbox";

    // Compose body: the block as a quote (for visual separation), then the
    // user's note if any, with a source-line footer for provenance.
    const bodyMd = composeDispatchBody(block, annotation, runId, sourceTitle);

    try {
      const html = await invokeCmd<string>("markdown_to_html", {
        markdown: bodyMd,
      });
      await invokeCmd<string>("append_to_apple_note", {
        title,
        htmlBody: html,
      });
    } catch (e) {
      await alertDialog(`Save to Apple Notes failed: ${e}`);
    }
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
          onSaveToNotes={saveToNotes}
          onAskClaude={onAskClaude}
          onMakeSkill={onMakeSkill}
        />
      ))}
    </div>
  );
}

/** Compose the dispatch payload markdown. Shared across Save-to-Notes and
 *  (potentially) other destinations so the block quote + note layout is
 *  consistent. */
export function composeDispatchBody(
  block: Block,
  annotation: string,
  runId: string,
  sourceTitle?: string,
): string {
  const source = sourceTitle ? `${sourceTitle} · ${runId}` : runId;
  const quoted = block.content
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const note = annotation.trim() ? `\n\n**Note:** ${annotation.trim()}\n` : "";
  const footer = `\n\n---\n*From Orka · ${source} · ${new Date().toLocaleString()}*`;
  return `${quoted}${note}${footer}`;
}
