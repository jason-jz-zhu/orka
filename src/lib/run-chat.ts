import { invokeCmd, listenEvent } from "./tauri";
import { parseLineInto, type StreamEvent } from "./stream-parser";

export interface RunChatMessage {
  author: "you" | "claude";
  text: string;
  created_at: string;
  referenced_block_hashes?: string[];
}

export interface RunChat {
  version: number;
  messages: RunChatMessage[];
}

export async function loadRunChat(runId: string): Promise<RunChat> {
  return await invokeCmd<RunChat>("load_run_chat", { runId });
}

export async function saveRunChatExchange(
  runId: string,
  userText: string,
  assistantText: string,
  referencedBlockHashes?: string[] | null,
): Promise<RunChat> {
  return await invokeCmd<RunChat>("save_run_chat_exchange", {
    runId,
    userText,
    assistantText,
    referencedBlockHashes: referencedBlockHashes ?? null,
  });
}

export async function clearRunChatStorage(runId: string): Promise<void> {
  await invokeCmd<void>("clear_run_chat", { runId });
}

/**
 * Spawn a one-shot `claude --resume <sid>` call, stream the response
 * back through the frontend, resolve with the concatenated assistant
 * text when the `done` event fires. Called from RunChatPanel and
 * reused for the legacy "Ask Claude with all notes" path.
 *
 * The caller provides:
 *   - a unique `runId` (used for event routing only — not the same
 *     as the parent run's id)
 *   - the session id to resume
 *   - the composed prompt (user text + optional annotation context)
 *   - an `onChunk` callback fired on each streamed text delta so the
 *     UI can render tokens as they arrive
 *
 * Resolves with the final text OR rejects if the spawn errors.
 */
/** Resolve the cwd to spawn claude in for `--resume <sid>` to succeed.
 *  claude derives its project folder from cwd, so spawning anywhere else
 *  yields "No conversation found". `find_session_by_id` walks
 *  `~/.claude/projects/` and returns the session file's actual location —
 *  that project's cwd is authoritative. Fall back to the caller's
 *  stored `run.workdir` if the lookup errors (IPC down, etc), or null
 *  if the session is genuinely gone. */
async function resolveSessionCwd(
  sessionId: string,
  fallbackWorkdir?: string | null,
): Promise<{ cwd: string | null; sessionMissing: boolean }> {
  try {
    const info = await invokeCmd<
      { project_cwd?: string; path?: string } | null
    >("find_session_by_id", { sessionId });
    if (info?.project_cwd) {
      return { cwd: info.project_cwd, sessionMissing: false };
    }
    // Lookup returned null — session file doesn't exist under any
    // project. This is a real "session gone" case, not a transient
    // error. Let the caller surface a clear message.
    return { cwd: fallbackWorkdir ?? null, sessionMissing: true };
  } catch {
    // IPC itself failed — fall back to the caller's stored workdir.
    // Don't mark session missing; we just couldn't check.
    return { cwd: fallbackWorkdir ?? null, sessionMissing: false };
  }
}

export async function streamChatRequest(opts: {
  runId: string;
  sessionId: string;
  prompt: string;
  /** Original run's workdir. Used as a fallback when the session-file
   *  lookup is unavailable. The session lookup is authoritative when
   *  it succeeds. */
  workdir?: string | null;
  onChunk?: (delta: string) => void;
}): Promise<string> {
  const { runId, sessionId, prompt, workdir, onChunk } = opts;

  const resolved = await resolveSessionCwd(sessionId, workdir);
  if (resolved.sessionMissing) {
    throw new Error(
      `Session ${sessionId.slice(0, 8)}… is no longer available. The transcript may have been cleaned up by claude or the project folder was moved. Re-run the skill to start a new session.`,
    );
  }

  let collected = "";
  const scratch: StreamEvent[] = [];

  const unStream = await listenEvent<string>(`node:${runId}:stream`, (raw) => {
    scratch.length = 0;
    parseLineInto(raw, scratch);
    for (const ev of scratch) {
      if (ev.kind === "text") {
        collected += ev.text;
        onChunk?.(ev.text);
      }
    }
  });

  let rejectDone: ((e: Error) => void) | null = null;
  const done = new Promise<string>((resolve, reject) => {
    rejectDone = reject;
    let unDone: (() => void) | null = null;
    void listenEvent<{ ok: boolean; error?: string }>(
      `node:${runId}:done`,
      (payload) => {
        unDone?.();
        if (payload?.ok === false) {
          reject(new Error(payload.error ?? "claude run failed"));
        } else {
          resolve(collected);
        }
      },
    ).then((fn) => {
      unDone = fn;
    });
  });

  // Fire-and-forget the spawn. The subprocess's normal exit fires the
  // `done` event which the promise above consumes. BUT if the backend
  // errors before it gets to spawn (e.g. mkdir of the workdir fails),
  // it returns Err *without* emitting `done` — so we must also catch
  // the invoke rejection and forward it, otherwise the caller hangs
  // on "Thinking…" forever.
  void invokeCmd("run_agent_node", {
    id: runId,
    prompt,
    resumeId: sessionId,
    addDirs: [],
    allowedTools: null,
    explicitWorkdir: resolved.cwd,
    // Append to the original session instead of forking a new one.
    // Without this the follow-up lands in a fresh session jsonl and
    // the user's "Terminal" button opens a transcript that's missing
    // everything they asked in the chat panel.
    forkOnResume: false,
  }).catch((e) => {
    rejectDone?.(new Error(String(e)));
  });

  try {
    return await done;
  } finally {
    unStream();
  }
}

/**
 * Compose a chat prompt. When `includeAnnotations` is true and
 * there are block annotations, we prepend a "## Your existing notes"
 * section so claude has that context. Otherwise just the bare
 * user message — simplest possible prompt.
 */
export function composeChatPrompt(
  userText: string,
  annotationSummaries: string[],
  includeAnnotations: boolean,
): string {
  const body = userText.trim();
  if (!includeAnnotations || annotationSummaries.length === 0) return body;
  const notes = annotationSummaries
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n");
  return [
    "## Your existing notes on blocks in this run",
    notes,
    "",
    "## My question",
    body,
  ].join("\n");
}
