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
   * Human-friendly title for the source of the output — used as the Apple
   * Notes note title, e.g. "Orka · agent n5".
   */
  sourceTitle?: string;
};

/**
 * Render a Claude output as a vertical list of annotatable BlockCards.
 *
 * Default interaction is one-click: hover a block → 📝 → appended to
 * Apple Notes immediately, no editor, no annotation. This covers the
 * >80% daily-use case ("that paragraph is useful, keep it").
 *
 * Secondary interaction: click 💬 to open the note editor. Type a note,
 * optionally click "Save to Notes with note" to dispatch block + note
 * together. Notes persist per-output.
 *
 * Other dispatch destinations (Ask Claude, New skill) are intentionally
 * omitted — they belong to the Walk-into-Session flow (Week 2) where
 * follow-up chat naturally lives.
 */
export function OutputAnnotator({ markdown, runId, sourceTitle }: Props) {
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

  const noteTitle = sourceTitle ? `Orka · ${sourceTitle}` : "Orka · Inbox";

  /**
   * One-click save — the primary default action on every block. Appends
   * the raw block markdown to Apple Notes. No quote formatting, no
   * provenance footer — this matches the "I'm just picking things to
   * keep" mental model.
   */
  async function quickSave(block: Block) {
    try {
      const html = await invokeCmd<string>("markdown_to_html", {
        markdown: block.content,
      });
      await invokeCmd<string>("append_to_apple_note", {
        title: noteTitle,
        htmlBody: html,
      });
    } catch (e) {
      await alertDialog(`Save to Apple Notes failed: ${e}`);
      throw e;
    }
  }

  /**
   * Full save with annotation — the secondary action, only accessible
   * from inside the editor. Adds a quote + your note + a provenance
   * footer so when you read the note later it's obvious where it came
   * from and what you thought at the time.
   */
  async function saveWithNote(block: Block, annotation: string) {
    const quoted = block.content
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const note = annotation.trim() ? `\n\n**Note:** ${annotation.trim()}` : "";
    const footer = `\n\n---\n*From Orka · ${sourceTitle ?? runId} · ${new Date().toLocaleString()}*`;
    const body = `${quoted}${note}${footer}`;

    try {
      const html = await invokeCmd<string>("markdown_to_html", { markdown: body });
      await invokeCmd<string>("append_to_apple_note", {
        title: noteTitle,
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
          onQuickSave={quickSave}
          onSaveToNotes={saveWithNote}
        />
      ))}
    </div>
  );
}
