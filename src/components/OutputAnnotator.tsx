import { useEffect, useMemo, useState } from "react";
import { BlockCard } from "./BlockCard";
import { parseBlocks, blockHash, type Block } from "../lib/markdown-blocks";
import {
  useAnnotations,
  useOutputAnnotations,
  type Annotation,
} from "../lib/annotations";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { alertDialog } from "../lib/dialogs";

type Props = {
  markdown: string;
  runId: string;
  sourceTitle?: string;
  /**
   * Session id captured from the source run (from the stream-json
   * `system init` event). Required for "Ask Claude" follow-ups to
   * `--resume` the same conversation.
   */
  sessionId?: string;
};

export function OutputAnnotator({
  markdown,
  runId,
  sourceTitle,
  sessionId,
}: Props) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown]);

  const load = useAnnotations((s) => s.load);
  const appendMessage = useAnnotations((s) => s.appendMessage);
  const upsert = useAnnotations((s) => s.upsert);
  const remove = useAnnotations((s) => s.remove);
  const annotations = useOutputAnnotations(runId);

  const [activeBlockIdx, setActiveBlockIdx] = useState<number | null>(null);

  useEffect(() => {
    if (runId) void load(runId);
  }, [runId, load]);

  if (blocks.length === 0) return null;

  const noteTitle = sourceTitle ? `Orka · ${sourceTitle}` : "Orka · Inbox";

  function toggle(block: Block) {
    setActiveBlockIdx((cur) => (cur === block.idx ? null : block.idx));
  }

  function blockInfo(block: Block) {
    return {
      blockIdx: block.idx,
      blockHash: blockHash(block),
      blockType: block.type,
      blockContent: block.content,
    };
  }

  // All user notes queue silently — no per-block AI call. The batched
  // "Ask Claude with all notes" button below ships them together.
  async function handleAddNote(block: Block, text: string) {
    await appendMessage(runId, blockInfo(block), { author: "you", text });
    await maybeSyncToNotes(block);
  }

  // A pending block is one whose thread has at least one trailing user
  // note without a subsequent Claude reply. These are the blocks the
  // batched ask will address.
  const pendingBlocks = useMemo(() => {
    const out: Array<{ block: Block; unanswered: string[] }> = [];
    for (const block of blocks) {
      const a = annotations.get(blockHash(block));
      if (!a || a.thread.length === 0) continue;
      // Walk backwards collecting user notes until we hit a claude reply
      // (those earlier notes have already been addressed).
      const unanswered: string[] = [];
      for (let i = a.thread.length - 1; i >= 0; i--) {
        const m = a.thread[i];
        if (m.author === "claude") break;
        if (m.author === "you") unanswered.unshift(m.text);
      }
      if (unanswered.length > 0) out.push({ block, unanswered });
    }
    return out;
  }, [blocks, annotations]);

  const [batchAsking, setBatchAsking] = useState(false);

  async function handleAskAll() {
    if (pendingBlocks.length === 0 || batchAsking) return;
    if (!sessionId) {
      await alertDialog(
        "Can't ask Claude: this output was produced before session tracking was enabled. Run the skill again to use Ask Claude.",
      );
      return;
    }
    setBatchAsking(true);
    try {
      const prompt = composeBatchPrompt(pendingBlocks);
      const reply = await runOneShotClaude(
        `annot-${runId}-batch-${Date.now()}`,
        prompt,
        sessionId,
      );
      if (reply) {
        // Append the same unified reply to every pending block's thread
        // so each card the user annotated shows Claude's response.
        for (const { block } of pendingBlocks) {
          await appendMessage(runId, blockInfo(block), {
            author: "claude",
            text: reply,
          });
          await maybeSyncToNotes(block);
        }
      }
    } catch (e) {
      await alertDialog(`Ask Claude failed: ${e}`);
    } finally {
      setBatchAsking(false);
    }
  }

  async function runOneShotClaude(
    subId: string,
    prompt: string,
    resumeId: string,
  ): Promise<string> {
    let buf = "";
    const unlistenStream = await listenEvent<string>(
      `node:${subId}:stream`,
      (raw) => {
        const evs = tryParseStreamLine(raw);
        for (const ev of evs) {
          if (ev.kind === "text") buf += ev.text;
        }
      },
    );
    const doneRef: { fn: (() => void) | null } = { fn: null };
    const done = new Promise<void>((resolve) => {
      listenEvent<{ ok: boolean; error?: string }>(
        `node:${subId}:done`,
        () => resolve(),
      ).then((fn) => {
        doneRef.fn = fn;
      });
    });
    try {
      await invokeCmd("run_agent_node", {
        id: subId,
        prompt,
        resumeId,
        addDirs: [],
        allowedTools: null,
        // Reuse the source run's workdir so `--resume` can find the
        // session. claude derives its project folder from cwd; spawning
        // in a fresh node dir makes it look in the wrong place.
        workdirKey: runId,
      });
      await done;
    } finally {
      unlistenStream();
      doneRef.fn?.();
    }
    return buf.trim();
  }

  async function handleToggleNotesSync(block: Block, next: boolean) {
    const existing = annotations.get(blockHash(block));
    const now = new Date().toISOString();
    const a: Annotation = existing
      ? { ...existing, savedToNotes: next, updatedAt: now }
      : {
          ...blockInfo(block),
          thread: [],
          savedToNotes: next,
          createdAt: now,
          updatedAt: now,
        };
    await upsert(runId, a);
    if (next) await syncToNotes(block, a);
  }

  async function maybeSyncToNotes(block: Block) {
    const a = useAnnotations
      .getState()
      .byOutput.get(runId)
      ?.get(blockHash(block));
    if (a?.savedToNotes) await syncToNotes(block, a);
  }

  async function syncToNotes(block: Block, a: Annotation) {
    const body = composeNotesBody(block, a, sourceTitle ?? runId);
    try {
      const html = await invokeCmd<string>("markdown_to_html", { markdown: body });
      await invokeCmd<string>("append_to_apple_note", {
        title: noteTitle,
        htmlBody: html,
      });
    } catch (e) {
      console.warn("[annotator] Apple Notes sync failed:", e);
    }
  }

  async function handleDelete(block: Block) {
    await remove(runId, blockHash(block));
  }

  const pendingCount = pendingBlocks.reduce(
    (n, p) => n + p.unanswered.length,
    0,
  );

  return (
    <div className="output-annotator">
      {blocks.map((block) => (
        <BlockCard
          key={`${runId}-${block.idx}`}
          block={block}
          active={activeBlockIdx === block.idx}
          annotation={annotations.get(blockHash(block))}
          onToggle={toggle}
          onAddNote={handleAddNote}
          onToggleNotesSync={handleToggleNotesSync}
          onDelete={handleDelete}
        />
      ))}
      {pendingCount > 0 && (
        <div className="output-annotator__batch-bar">
          <span className="output-annotator__batch-count">
            📝 {pendingCount} note{pendingCount === 1 ? "" : "s"} across{" "}
            {pendingBlocks.length} block
            {pendingBlocks.length === 1 ? "" : "s"}
          </span>
          <span className="output-annotator__batch-hint">
            Review all your notes, then send them to Claude in one go.
          </span>
          <button
            type="button"
            className="output-annotator__batch-btn"
            disabled={batchAsking}
            onClick={() => void handleAskAll()}
          >
            {batchAsking ? "⏳ Asking…" : "Ask Claude with all notes"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Compose a single prompt that lists every pending note grouped by the
 *  block it's attached to. Quoted block content tells Claude what you
 *  were looking at; numbering lets Claude address each item distinctly. */
function composeBatchPrompt(
  pending: Array<{ block: Block; unanswered: string[] }>,
): string {
  const sections = pending.map(({ block, unanswered }, i) => {
    const quoted = block.content
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const notes = unanswered.map((n) => `- ${n}`).join("\n");
    return `### ${i + 1}. About this block:\n\n${quoted}\n\nMy notes:\n${notes}`;
  });
  const intro =
    pending.length === 1
      ? "I reviewed your previous output and have a note. Please address it:"
      : `I reviewed your previous output and have notes on ${pending.length} different parts. Please address each:`;
  return `${intro}\n\n${sections.join("\n\n")}`;
}

function composeNotesBody(block: Block, a: Annotation, source: string): string {
  const quoted = block.content
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const thread = a.thread
    .map((m) => {
      const who = m.author === "you" ? "**You:**" : "**Claude:**";
      return `${who} ${m.text}`;
    })
    .join("\n\n");
  const footer = `\n\n---\n*Orka · ${source} · ${new Date().toLocaleString()}*`;
  return `${quoted}${thread ? `\n\n${thread}` : ""}${footer}`;
}

/** Minimal inline stream-json parsing for the follow-up call. We only
 *  care about the assistant text events; everything else is ignored. */
function tryParseStreamLine(raw: string): Array<{ kind: "text"; text: string }> {
  try {
    const ev = JSON.parse(raw);
    const out: Array<{ kind: "text"; text: string }> = [];
    if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          out.push({ kind: "text", text: block.text });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
