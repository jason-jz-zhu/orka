import { useEffect, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import {
  markOnboardingCompleted,
  resetOnboarding,
} from "../lib/onboarding";

type Status = {
  claude_installed: boolean;
  claude_version: string | null;
  claude_logged_in: boolean;
  projects_dir_exists: boolean;
  workspace_initialized: boolean;
  platform: string;
};

type Props = {
  onClose: () => void;
};

// Re-export so existing imports from `./components/OnboardingModal`
// continue to work. Keeps the modal lazy-chunked while the tiny
// localStorage helpers stay eager in the main bundle via ../lib/onboarding.
export { markOnboardingCompleted, resetOnboarding };

export default function OnboardingModal({ onClose }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(true);

  async function check() {
    setChecking(true);
    try {
      const s = await invokeCmd<Status>("onboarding_status");
      setStatus(s);
    } catch (e) {
      console.warn("onboarding_status failed:", e);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    check();
  }, []);

  const ready =
    status?.claude_installed &&
    status?.claude_logged_in &&
    status?.workspace_initialized;

  function finish() {
    markOnboardingCompleted();
    onClose();
  }

  return (
    <div className="onboarding__overlay">
      <div className="onboarding__card">
        <div className="onboarding__title">Welcome to Orka</div>
        <div className="onboarding__subtitle">
          Orka wraps your local <code>claude</code> CLI — let's check
          everything is ready.
        </div>

        <div className="onboarding__checklist">
          <CheckRow
            ok={!!status?.claude_installed}
            loading={checking}
            label="claude CLI installed"
            detail={
              status?.claude_version
                ? status.claude_version
                : !checking && !status?.claude_installed
                  ? "Not found on PATH"
                  : undefined
            }
            help={
              !checking && !status?.claude_installed ? (
                <FixHint
                  text="Install Claude Code"
                  href="https://docs.claude.com/en/docs/claude-code/quickstart"
                />
              ) : undefined
            }
          />
          <CheckRow
            ok={!!status?.claude_logged_in}
            loading={checking}
            label="claude logged in"
            detail={
              !checking && !status?.claude_logged_in
                ? "No credentials found in ~/.claude"
                : undefined
            }
            help={
              !checking && status?.claude_installed && !status?.claude_logged_in ? (
                <FixHint
                  text="Open a terminal, run `claude`, and sign in. Then click Re-check."
                />
              ) : undefined
            }
          />
          <CheckRow
            ok={!!status?.projects_dir_exists}
            loading={checking}
            label="Claude project transcripts"
            detail={
              !checking && !status?.projects_dir_exists
                ? "~/.claude/projects does not exist yet"
                : "~/.claude/projects"
            }
            help={
              !checking && !status?.projects_dir_exists ? (
                <FixHint text="Start a session with `claude` once — the directory is created automatically." />
              ) : undefined
            }
          />
          <CheckRow
            ok={!!status?.workspace_initialized}
            loading={checking}
            label="Orka workspace ready"
            detail={
              status?.workspace_initialized
                ? "~/OrkaCanvas"
                : !checking
                  ? "Could not create ~/OrkaCanvas"
                  : undefined
            }
          />
        </div>

        <div className="onboarding__actions">
          <button
            className="onboarding__btn onboarding__btn--secondary"
            onClick={check}
            disabled={checking}
          >
            {checking ? "Checking…" : "Re-check"}
          </button>
          <button
            className="onboarding__btn onboarding__btn--secondary"
            onClick={finish}
            title="Skip for now — you can re-run this check from settings"
          >
            Skip
          </button>
          <button
            className="onboarding__btn onboarding__btn--primary"
            onClick={finish}
            disabled={!ready}
          >
            {ready ? "Get started →" : "Finish setup above"}
          </button>
        </div>

        <div className="onboarding__footnote">
          Orka never reads your credentials. It only watches{" "}
          <code>~/.claude/projects</code> and calls the <code>claude</code>{" "}
          binary.
        </div>
      </div>
    </div>
  );
}

function CheckRow({
  ok,
  loading,
  label,
  detail,
  help,
}: {
  ok: boolean;
  loading: boolean;
  label: string;
  detail?: string;
  help?: React.ReactNode;
}) {
  const icon = loading ? "⋯" : ok ? "✓" : "✗";
  const cls = loading ? "onboarding__row--wait" : ok ? "onboarding__row--ok" : "onboarding__row--fail";
  return (
    <div className={`onboarding__row ${cls}`}>
      <span className="onboarding__icon">{icon}</span>
      <div className="onboarding__row-body">
        <div className="onboarding__row-label">{label}</div>
        {detail && <div className="onboarding__row-detail">{detail}</div>}
        {help}
      </div>
    </div>
  );
}

function FixHint({ text, href }: { text: string; href?: string }) {
  return (
    <div className="onboarding__hint">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {text} ↗
        </a>
      ) : (
        text
      )}
    </div>
  );
}
