import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectAvailableTerminals,
  getTerminalConfig,
  openSessionInTerminal,
  TERMINAL_LABEL,
  type TerminalPreference,
} from "../lib/terminal-config";
import { alertDialog } from "../lib/dialogs";

type Props = {
  runId: string;
  sessionId: string;
  workdir?: string | null;
  /** Called with error text if the launch fails. Defaults to showing
   *  an alert dialog — the only reason to override is to render a
   *  more contextual message in the parent's UI. */
  onError?: (err: string) => void;
  /** Opens the main Settings modal at the Terminal section. The
   *  dropdown's "Settings…" item calls this; undefined → hide it. */
  onOpenSettings?: () => void;
};

/** Resolve "auto" to a concrete preset for display purposes. Mirrors
 *  the backend's resolve_preference so the button shows the terminal
 *  that will actually launch. */
function resolveDefault(
  preference: TerminalPreference,
  available: string[],
): TerminalPreference {
  if (preference !== "auto") return preference;
  for (const c of ["warp", "iterm", "terminal-app"] as const) {
    if (available.includes(c)) return c;
  }
  return "terminal-app";
}

/** Short label for the button body. TERMINAL_LABEL has the user-facing
 *  descriptions ("Terminal.app", "iTerm2", "Warp", "VS Code (+ clipboard)")
 *  but inside a compact button we want the bare name. */
const SHORT_LABEL: Record<TerminalPreference, string> = {
  auto: "Auto",
  "terminal-app": "Terminal",
  iterm: "iTerm",
  warp: "Warp",
  vscode: "VS Code",
  custom: "Custom",
};

/**
 * Split button for launching a session in a terminal.
 *
 * Main body  → launches in the resolved default (respects saved
 *              preference; if "auto", picks the first detected terminal).
 * ▾ chevron → opens a menu listing all detected terminals + a
 *              "Settings…" escape hatch. Clicking a menu item launches
 *              in that terminal for *this* click only — it does not
 *              change the saved default.
 */
export function TerminalLaunchButton({
  runId,
  sessionId,
  workdir,
  onError,
  onOpenSettings,
}: Props) {
  const [available, setAvailable] = useState<string[]>([]);
  const [preference, setPreference] = useState<TerminalPreference>("auto");
  const [open, setOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  // Brief "Opened in <term>" notice that auto-clears. Lets the user
  // verify what actually launched when the window chrome alone doesn't
  // make it obvious (Terminal.app and iTerm look similar out of the box).
  const [lastLaunched, setLastLaunched] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Load config + detection once on mount. Both are cheap file-system
  // checks — no network. We don't re-poll because the user's
  // terminal roster doesn't change during an app session in practice.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cfg, avail] = await Promise.all([
          getTerminalConfig(),
          detectAvailableTerminals(),
        ]);
        if (!cancelled) {
          setPreference(cfg.preference);
          setAvailable(avail);
        }
      } catch {
        // Keep the defaults — button still works via the backend's
        // own fallback resolution.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the menu on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const launch = useCallback(
    async (override: TerminalPreference | null) => {
      if (launching) return;
      setLaunching(true);
      setOpen(false);
      try {
        const result = await openSessionInTerminal(
          runId,
          sessionId,
          workdir ?? null,
          override,
        );
        if (result.clipboard_payload) {
          try {
            await navigator.clipboard.writeText(result.clipboard_payload);
          } catch {
            /* clipboard unavailable — user can still paste manually */
          }
        }
        setLastLaunched(result.resolved);
        // Auto-clear the notice after a beat so it doesn't linger.
        // 2s is long enough to read "Opened in iTerm" and short enough
        // not to clutter if the user launches multiple in a row.
        window.setTimeout(() => setLastLaunched(null), 2000);
      } catch (e) {
        const msg = `Open terminal failed: ${e}`;
        if (onError) onError(msg);
        else await alertDialog(msg);
      } finally {
        setLaunching(false);
      }
    },
    [launching, runId, sessionId, workdir, onError],
  );

  const defaultTerm = resolveDefault(preference, available);
  const defaultLabel = SHORT_LABEL[defaultTerm] ?? "Terminal";

  // Menu options: all detected terminals, plus "Custom" if the user
  // has it configured (the saved config may reference a template
  // we can't auto-detect). We don't show "auto" — the default button
  // body already does that.
  const menuOptions: TerminalPreference[] = [
    ...(available as TerminalPreference[]),
    ...(preference === "custom" && !available.includes("custom")
      ? (["custom"] as TerminalPreference[])
      : []),
  ];

  return (
    <div className="term-launch" ref={menuRef}>
      <button
        type="button"
        className="term-launch__main"
        onClick={() => void launch(null)}
        disabled={launching}
        title={`Open session in ${TERMINAL_LABEL[defaultTerm]}`}
      >
        ⌨ {launching ? "…" : defaultLabel}
      </button>
      <button
        type="button"
        className="term-launch__chevron"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Pick terminal"
        title="Pick a different terminal for this click"
      >
        ▾
      </button>
      {lastLaunched && !open && (
        <span
          className="term-launch__notice"
          title="Backend-reported terminal — lets you confirm the right app opened"
        >
          → {SHORT_LABEL[(lastLaunched as TerminalPreference)] ?? lastLaunched}
        </span>
      )}
      {open && (
        <div className="term-launch__menu" role="menu">
          {menuOptions.length === 0 && (
            <div className="term-launch__menu-empty">
              No terminals detected
            </div>
          )}
          {menuOptions.map((opt) => {
            const isDefault = opt === defaultTerm;
            return (
              <button
                key={opt}
                type="button"
                className={
                  "term-launch__menu-item" +
                  (isDefault ? " term-launch__menu-item--default" : "")
                }
                role="menuitem"
                onClick={() => void launch(opt)}
              >
                <span className="term-launch__menu-label">
                  {TERMINAL_LABEL[opt]}
                </span>
                {isDefault && (
                  <span className="term-launch__menu-badge">default</span>
                )}
              </button>
            );
          })}
          {onOpenSettings && (
            <>
              <div className="term-launch__menu-sep" />
              <button
                type="button"
                className="term-launch__menu-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                <span className="term-launch__menu-label">Settings…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
