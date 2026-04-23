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
  /**
   * Original run's workdir. `claude --resume` looks up the session
   * file via a hash of cwd, so the batched follow-up spawn must run
   * in the same dir where the original session was created — not the
   * generic `<workspace>/nodes/<runId>` fallback. When the original
   * run used a user-configured output folder, those two paths differ.
   */
  workdir?: string | null;
  /**
   * When true, suppress the bottom "Ask Claude with all notes" batch
   * bar. Used when the annotator is embedded inside a chat reply —
   * the chat panel already has its own composer, so adding another
   * "ask" control would be redundant and confusing.
   */
  hideBatchBar?: boolean;
};

export function OutputAnnotator({
  markdown,
  runId,
  sourceTitle,
  sessionId,
  workdir,
  hideBatchBar = false,
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
      // Resolve the session's actual cwd by walking ~/.claude/projects.
      // Spawning claude anywhere else yields "No conversation found"
      // because `--resume` hashes cwd → project-folder lookup. The
      // stored `run.workdir` can drift from reality (scheduled runs,
      // moved folders), so the session file's own location is the
      // authoritative answer.
      const resolved = await resolveSessionCwdOrWarn(sessionId, workdir);
      if (resolved.missing) {
        await alertDialog(
          `Session ${sessionId.slice(0, 8)}… is no longer available — claude may have cleaned it up, or the project folder was moved. Re-run the skill to start a new session.`,
        );
        return;
      }
      const prompt = composeBatchPrompt(pendingBlocks);
      const reply = await runOneShotClaude(
        `annot-${runId}-batch-${Date.now()}`,
        prompt,
        sessionId,
        resolved.cwd,
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
    cwd: string | null,
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
        // Spawn in the session's authoritative cwd (resolved by
        // walking ~/.claude/projects/ to find the session file).
        // This beats the stored run.workdir, which can drift from
        // reality — scheduled runs' timestamped folders can be
        // deleted or moved while the session transcript survives.
        explicitWorkdir: cwd,
        // Append to the original session so the "Terminal" button
        // on this run shows the batched follow-up. Without this flag
        // claude forks a new session and the original transcript
        // stops at step 4 forever.
        forkOnResume: false,
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
      {pendingCount > 0 && !hideBatchBar && (
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

/** Walk ~/.claude/projects/ to find the session file's actual cwd. That
 *  cwd is what `claude --resume` will hash to locate the session, so
 *  spawning there guarantees resume succeeds. Returns `{ cwd, missing }`
 *  so the caller can distinguish "session is genuinely gone" from "IPC
 *  failed, trying fallback". */
async function resolveSessionCwdOrWarn(
  sessionId: string,
  fallback: string | null | undefined,
): Promise<{ cwd: string | null; missing: boolean }> {
  try {
    const info = await invokeCmd<{ project_cwd?: string } | null>(
      "find_session_by_id",
      { sessionId },
    );
    if (info?.project_cwd) return { cwd: info.project_cwd, missing: false };
    // Lookup succeeded but returned null → session file isn't under any
    // project → really gone. Fallback won't help here either.
    return { cwd: null, missing: true };
  } catch {
    // IPC itself failed (rare). Use the caller's stored workdir so we
    // can at least attempt the spawn. Session may or may not still exist.
    return { cwd: fallback ?? null, missing: false };
  }
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
