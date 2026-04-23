import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  composeChatPrompt,
  loadRunChat,
  saveRunChatExchange,
  streamChatRequest,
  type RunChat,
  type RunChatMessage,
} from "../lib/run-chat";
import { alertDialog } from "../lib/dialogs";
import { useAnnotations, useOutputAnnotations } from "../lib/annotations";
import { OutputAnnotator } from "./OutputAnnotator";

type Props = {
  runId: string;
  /** Session id from the parent run. Required for claude --resume —
   *  when absent the panel renders disabled with a tooltip. */
  sessionId?: string;
  /** Original run's workdir. Needed so the follow-up `claude --resume`
   *  spawns in the same cwd where the session file lives — otherwise
   *  claude reports "No conversation found". */
  workdir?: string | null;
  /** Skill name from the parent run — used as the Apple Notes title
   *  when a user syncs an annotation from a chat reply block. */
  sourceTitle?: string;
};

/** Example questions shown in the empty state so users don't face a
 *  blank composer. Clicking one fills the input instead of sending,
 *  so they can tweak before committing. */
const EXAMPLE_PROMPTS = [
  "Summarize this in 3 bullets",
  "What would you change?",
  "Redo for a different input",
];

/**
 * Free-form chat thread about a run's output. Lives at the bottom
 * of RunDetailDrawer alongside the existing block-annotator.
 *
 * This is the Annotator's complement: block annotations for
 * targeted markup, this panel for unscoped follow-ups, iterative
 * refinement, and generic questions. They co-exist via the
 * "Include my annotations" toggle on the composer — when on, each
 * message we send prepends a summary of your current block notes
 * so claude has that context.
 */
export function RunChatPanel({
  runId,
  sessionId,
  workdir,
  sourceTitle,
}: Props) {
  const [chat, setChat] = useState<RunChat | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Per-block annotations for this run — used when the "Include
  // my annotations" toggle is on. Reading the same store the
  // OutputAnnotator writes to; no extra round-trip.
  const annotations = useOutputAnnotations(runId);
  const loadAnnotations = useAnnotations((s) => s.load);

  useEffect(() => {
    void loadAnnotations(runId);
  }, [runId, loadAnnotations]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const c = await loadRunChat(runId);
        if (!cancelled) setChat(c);
      } catch (e) {
        if (!cancelled) {
          console.warn("[run-chat] load failed", e);
          setChat({ version: 1, messages: [] });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Auto-scroll to the newest message (or streaming tokens) without
  // fighting the user if they've scrolled up to read history.
  useEffect(() => {
    // Use a ref + "only scroll when already near bottom" check to
    // avoid yanking the view mid-scroll. `scrollIntoView` with end
    // is fine here because the inner container is the scroll root.
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat?.messages.length, streamingText]);

  const annotationSummaries = useMemo(() => {
    const out: string[] = [];
    for (const a of annotations.values()) {
      // Build a short summary of each annotation: block preview +
      // last user note. Claude doesn't need the whole thread.
      const lastUserNote = [...a.thread]
        .reverse()
        .find((m) => m.author === "you");
      if (!lastUserNote) continue;
      const blockSnippet = a.blockContent.slice(0, 100).replace(/\n/g, " ");
      out.push(`[block "${blockSnippet}…"] ${lastUserNote.text}`);
    }
    return out;
  }, [annotations]);

  const canSend = !!sessionId && input.trim().length > 0 && !sending;

  const sendRequest = useCallback(
    async (rawText: string) => {
      if (!sessionId) return;
      const userText = rawText.trim();
      if (!userText) return;
      setSending(true);
      setStreamingText("");

      const thisRunId = `chat-${runId.slice(0, 12)}-${Date.now().toString(36)}`;
      const prompt = composeChatPrompt(
        userText,
        annotationSummaries,
        includeAnnotations,
      );
      const referencedHashes = includeAnnotations
        ? Array.from(annotations.keys())
        : undefined;

      // Optimistic add of the user message so the composer clears
      // immediately; the assistant message will streaming-populate
      // into a separate state slot below the thread.
      setChat((cur) => ({
        version: cur?.version ?? 1,
        messages: [
          ...(cur?.messages ?? []),
          {
            author: "you",
            text: userText,
            created_at: new Date().toISOString(),
            referenced_block_hashes: referencedHashes ?? [],
          },
        ],
      }));
      setInput("");

      try {
        const reply = await streamChatRequest({
          runId: thisRunId,
          sessionId,
          prompt,
          workdir,
          onChunk: (delta) => setStreamingText((t) => t + delta),
        });
        // Persist both turns atomically once the stream closes.
        const persisted = await saveRunChatExchange(
          runId,
          userText,
          reply,
          referencedHashes,
        );
        setChat(persisted);
        setStreamingText("");
      } catch (e) {
        await alertDialog(`Chat request failed: ${e}`);
        // Roll back the optimistic user message on failure.
        setChat((cur) =>
          cur
            ? {
                ...cur,
                messages: cur.messages.slice(0, -1),
              }
            : cur,
        );
        setStreamingText("");
      } finally {
        setSending(false);
        taRef.current?.focus();
      }
    },
    [annotationSummaries, annotations, includeAnnotations, runId, sessionId, workdir],
  );

  if (loading) {
    return (
      <div className="run-chat run-chat--loading">
        <div className="run-chat__status">Loading chat…</div>
      </div>
    );
  }

  const messages = chat?.messages ?? [];

  return (
    <div className="run-chat">
      <div className="run-chat__header">
        <span className="run-chat__title">💬 Chat with this run</span>
        {!sessionId && (
          <span
            className="run-chat__disabled-hint"
            title="Re-run the skill to create a resumable session"
          >
            No session — chat disabled
          </span>
        )}
      </div>

      <div className="run-chat__thread">
        {messages.length === 0 && streamingText === "" && (
          <div className="run-chat__empty">
            <p>
              Ask anything about this run. Your block notes go with each
              question unless you uncheck the toggle below.
            </p>
            <div className="run-chat__examples">
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="run-chat__example-chip"
                  onClick={() => {
                    setInput(p);
                    taRef.current?.focus();
                  }}
                  disabled={!sessionId}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatBubble
            key={i}
            msg={m}
            runId={runId}
            workdir={workdir}
            sessionId={sessionId}
            sourceTitle={sourceTitle}
          />
        ))}
        {streamingText && (
          <ChatBubble
            msg={{
              author: "claude",
              text: streamingText,
              created_at: new Date().toISOString(),
            }}
            streaming
            runId={runId}
            workdir={workdir}
            sessionId={sessionId}
            sourceTitle={sourceTitle}
          />
        )}
        <div ref={endRef} />
      </div>

      <div className="run-chat__composer">
        <textarea
          ref={taRef}
          className="run-chat__input"
          rows={2}
          placeholder={
            sessionId
              ? "Ask about this run… (⌘+Enter to send)"
              : "Chat requires a captured session id"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSend) void sendRequest(input);
            }
          }}
          disabled={!sessionId || sending}
        />
        <div className="run-chat__composer-row">
          <label
            className="run-chat__toggle"
            title={
              annotationSummaries.length > 0
                ? `${annotationSummaries.length} note(s) will go with your question`
                : "No annotations yet — toggle will kick in once you add some"
            }
          >
            <input
              type="checkbox"
              checked={includeAnnotations}
              onChange={(e) => setIncludeAnnotations(e.target.checked)}
            />
            Include my notes
            {annotationSummaries.length > 0 && (
              <span className="run-chat__toggle-count">
                {annotationSummaries.length}
              </span>
            )}
          </label>
          <span className="run-chat__spacer" />
          <button
            type="button"
            className="run-chat__send"
            onClick={() => void sendRequest(input)}
            disabled={!canSend}
          >
            {sending ? "Thinking…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  msg,
  streaming = false,
  runId,
  workdir,
  sessionId,
  sourceTitle,
}: {
  msg: RunChatMessage;
  streaming?: boolean;
  runId: string;
  workdir?: string | null;
  sessionId?: string;
  sourceTitle?: string;
}) {
  const isYou = msg.author === "you";
  return (
    <div
      className={
        "run-chat__bubble" +
        (isYou ? " run-chat__bubble--you" : " run-chat__bubble--claude") +
        (streaming ? " run-chat__bubble--streaming" : "")
      }
    >
      <div className="run-chat__bubble-head">
        <span className="run-chat__bubble-author">
          {isYou ? "👤 you" : "🤖 claude"}
        </span>
        {msg.referenced_block_hashes &&
          msg.referenced_block_hashes.length > 0 && (
            <span
              className="run-chat__bubble-ref"
              title={`Included ${msg.referenced_block_hashes.length} block note(s)`}
            >
              · with {msg.referenced_block_hashes.length} note
              {msg.referenced_block_hashes.length === 1 ? "" : "s"}
            </span>
          )}
      </div>
      {/* You messages stay plain text — there's nothing to annotate
          about your own question. Claude replies get the full block
          annotator so you can hover a paragraph/bullet and drop a
          note the same way you would on the main output. During
          streaming the text isn't parseable into stable blocks yet,
          so render plain until the reply completes. */}
      {isYou || streaming ? (
        <div className="run-chat__bubble-body">{msg.text}</div>
      ) : (
        <div className="run-chat__bubble-body run-chat__bubble-body--annotated">
          <OutputAnnotator
            markdown={msg.text}
            runId={runId}
            sourceTitle={sourceTitle}
            sessionId={sessionId}
            workdir={workdir}
            hideBatchBar
          />
        </div>
      )}
    </div>
  );
}
