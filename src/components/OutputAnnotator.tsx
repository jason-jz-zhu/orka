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

  async function handleAddNote(block: Block, text: string) {
    await appendMessage(runId, blockInfo(block), { author: "you", text });
    await maybeSyncToNotes(block);
  }

  async function handleAskClaude(block: Block, text: string) {
    // Record the user's question immediately.
    await appendMessage(runId, blockInfo(block), { author: "you", text });
    await maybeSyncToNotes(block);

    // Run a one-shot `claude -p` with the same session id so Claude
    // sees the full run transcript as context, plus our new question.
    await askClaudeAboutBlock(block, text);
  }

  async function askClaudeAboutBlock(block: Block, userText: string) {
    if (!sessionId) {
      await alertDialog(
        "Can't ask Claude: this output was produced before session tracking was enabled. Run the skill again to use Ask Claude.",
      );
      return;
    }

    // Isolated subprocess id so we don't collide with the source node's
    // event stream. The annotator subscribes to this id's events only.
    const subId = `annot-${runId}-${block.idx}-${Date.now()}`;
    const prompt = composeFollowUpPrompt(block, userText);

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
        resumeId: sessionId,
        addDirs: [],
        allowedTools: null,
      });
      await done;
    } catch (e) {
      await alertDialog(`Ask Claude failed: ${e}`);
      return;
    } finally {
      unlistenStream();
      doneRef.fn?.();
    }

    const reply = buf.trim();
    if (reply) {
      await appendMessage(runId, blockInfo(block), {
        author: "claude",
        text: reply,
      });
      await maybeSyncToNotes(block);
    }
  }

  async function handleToggleNotesSync(block: Block, next: boolean) {
    const existing = annotations.get(block.idx);
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
    const a = useAnnotations.getState().byOutput.get(runId)?.get(block.idx);
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
    await remove(runId, block.idx);
  }

  return (
    <div className="output-annotator">
      {blocks.map((block) => (
        <BlockCard
          key={`${runId}-${block.idx}`}
          block={block}
          active={activeBlockIdx === block.idx}
          annotation={annotations.get(block.idx)}
          onToggle={toggle}
          onAddNote={handleAddNote}
          onAskClaude={handleAskClaude}
          onToggleNotesSync={handleToggleNotesSync}
          onDelete={handleDelete}
        />
      ))}
    </div>
  );
}

function composeFollowUpPrompt(block: Block, question: string): string {
  const quoted = block.content
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `About this from your previous output:\n\n${quoted}\n\n${question}`;
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
