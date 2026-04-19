import { useEffect, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import { alertDialog, confirmDialog } from "../lib/dialogs";

interface EvolutionSuggestion {
  slug: string;
  summary: string;
  suggestedMarkdown: string;
  rationale: string;
  annotationCount: number;
  runCount: number;
  generatedAt: string;
}

type Props = {
  slug: string;
  onClose: () => void;
  onApplied?: () => void;
};

type State =
  | { kind: "loading" }
  | { kind: "ready"; suggestion: EvolutionSuggestion }
  | { kind: "applying" }
  | { kind: "error"; message: string };

/**
 * Per-skill evolution modal. Reads all annotations the user has left on
 * this skill's runs and asks Haiku to propose a patched SKILL.md that
 * bakes in the patterns the user has been pushing back on. Shows the
 * summary, rationale, and full suggested markdown; user approves with
 * one click and we atomically swap SKILL.md (keeping a timestamped
 * backup for safety).
 */
export function SkillEvolutionModal({ slug, onClose, onApplied }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await invokeCmd<EvolutionSuggestion>("suggest_skill_evolution", {
          slug,
        });
        if (!cancelled) setState({ kind: "ready", suggestion: s });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function apply() {
    if (state.kind !== "ready") return;
    const ok = await confirmDialog(
      `Overwrite ~/.claude/skills/${slug}/SKILL.md with this evolved version? A timestamped backup will be saved next to it.`,
      { title: "Apply skill evolution?", okLabel: "Apply", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    setState({ kind: "applying" });
    try {
      const backupPath = await invokeCmd<string>("apply_skill_evolution", {
        slug,
        newMarkdown: state.suggestion.suggestedMarkdown,
      });
      await alertDialog(
        `SKILL.md updated. Backup at:\n${backupPath}`,
        "Evolution applied",
      );
      onApplied?.();
      onClose();
    } catch (e) {
      await alertDialog(`Apply failed: ${e}`);
      // Go back to ready state so user can retry or close
      if (state.kind === "ready") setState({ kind: "ready", suggestion: state.suggestion });
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box evolution-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">💡 Evolve /{slug}</div>
            <div className="modal-subtitle">
              Based on how you've actually been using it
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {state.kind === "loading" && (
          <div className="evolution-modal__loading">
            <div className="evolution-modal__pulse">⏳</div>
            <div>Reading your annotations and asking Haiku for a proposed update…</div>
            <div className="evolution-modal__hint">
              (Takes a few seconds. Uses Haiku, so it's cheap.)
            </div>
          </div>
        )}

        {state.kind === "error" && (
          <div className="evolution-modal__error">
            <div className="evolution-modal__error-title">Couldn't generate a suggestion</div>
            <div className="evolution-modal__error-body">{state.message}</div>
            <div className="evolution-modal__actions">
              <button className="modal-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {state.kind === "ready" && (
          <>
            <div className="evolution-modal__meta">
              Based on {state.suggestion.runCount} run
              {state.suggestion.runCount === 1 ? "" : "s"} and{" "}
              {state.suggestion.annotationCount} message
              {state.suggestion.annotationCount === 1 ? "" : "s"} you've written.
            </div>

            <div className="evolution-modal__section">
              <div className="evolution-modal__section-label">Summary</div>
              <div className="evolution-modal__summary">
                {state.suggestion.summary}
              </div>
            </div>

            <div className="evolution-modal__section">
              <div className="evolution-modal__section-label">Why</div>
              <div className="evolution-modal__rationale">
                {state.suggestion.rationale}
              </div>
            </div>

            <div className="evolution-modal__section">
              <div className="evolution-modal__section-label">Proposed SKILL.md</div>
              <pre className="evolution-modal__markdown nowheel">
                {state.suggestion.suggestedMarkdown}
              </pre>
            </div>

            <div className="evolution-modal__actions">
              <button className="modal-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="modal-btn modal-btn--primary"
                onClick={() => void apply()}
              >
                Apply evolution
              </button>
            </div>
          </>
        )}

        {state.kind === "applying" && (
          <div className="evolution-modal__loading">
            <div className="evolution-modal__pulse">⏳</div>
            <div>Writing new SKILL.md…</div>
          </div>
        )}
      </div>
    </div>
  );
}
