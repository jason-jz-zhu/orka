import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invokeCmd } from "../lib/tauri";
import type { SessionInfo } from "../lib/session-types";

interface SynthResult {
  answer: string;
  sourcesUsed: number;
}

type Props = {
  sources: SessionInfo[];
  onClose: () => void;
};

type State =
  | { kind: "ready" }
  | { kind: "asking" }
  | { kind: "answered"; result: SynthResult }
  | { kind: "error"; message: string };

/**
 * "Ask across these sessions" modal. User has multi-selected N sessions
 * in the SessionDashboard; this opens with those sessions listed as
 * sources and a single input for the question. Hitting Ask sends the
 * merged context to the backend synthesizer.
 *
 * This is NOT a magic "merge three session brains into one"; under the
 * hood it's a one-shot claude -p with N source-tagged transcripts
 * prepended. We say so honestly in the UX (the sources panel shows
 * what's being read), so the user knows it's prompt engineering not
 * persistent state mutation.
 */
export function SynthesisModal({ sources, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ kind: "ready" });

  async function ask() {
    if (!question.trim() || state.kind === "asking") return;
    setState({ kind: "asking" });
    try {
      const payload = sources.map((s) => ({
        sessionId: s.id,
        sessionPath: s.path,
        label: projectLabel(s),
      }));
      const result = await invokeCmd<SynthResult>("synthesize_sessions", {
        question,
        sources: payload,
      });
      setState({ kind: "answered", result });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box synth-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">📚 Ask across sessions</div>
            <div className="modal-subtitle">
              {sources.length} source{sources.length === 1 ? "" : "s"} selected
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="synth-modal__sources">
          {sources.map((s) => (
            <div key={s.id} className="synth-modal__source">
              <span className="synth-modal__source-id">
                {s.id.slice(0, 8)}
              </span>
              <span className="synth-modal__source-label">{projectLabel(s)}</span>
              <span className="synth-modal__source-turns">
                {s.turn_count} turns
              </span>
            </div>
          ))}
        </div>

        <div className="synth-modal__input-row">
          <textarea
            className="synth-modal__input"
            placeholder="What do you want to know across these sessions?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void ask();
              }
            }}
            rows={3}
            disabled={state.kind === "asking"}
          />
          <button
            className="modal-btn modal-btn--primary synth-modal__ask-btn"
            onClick={() => void ask()}
            disabled={!question.trim() || state.kind === "asking"}
          >
            {state.kind === "asking" ? "⏳ Thinking…" : "Ask"}
          </button>
        </div>

        {state.kind === "error" && (
          <div className="synth-modal__error">✗ {state.message}</div>
        )}

        {state.kind === "answered" && (
          <div className="synth-modal__answer">
            <div className="synth-modal__answer-meta">
              Based on {state.result.sourcesUsed} source
              {state.result.sourcesUsed === 1 ? "" : "s"}
            </div>
            <div className="synth-modal__answer-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {state.result.answer}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function projectLabel(s: SessionInfo): string {
  const parts = s.project_cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? s.project_cwd;
}
