import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invokeCmd, listenEvent } from "../lib/tauri";

type Props = {
  /** Working directory the child spawns in. Falls back to the user's
   *  shell default when omitted. */
  cwd?: string | null;
  /** Command + args to spawn. Default: an interactive bash login
   *  shell — most users will pass `claude --resume <sid>` though. */
  command?: string;
  args?: string[];
  /** Extra env vars merged onto the spawn. Useful for `TERM=xterm-256color`
   *  on platforms where the inherited env strips it. */
  env?: Array<[string, string]>;
  /** Fired once the child exits. The terminal stays mounted with its
   *  buffer visible; parent can choose to unmount or keep it as a
   *  log surface. */
  onExit?: (code: number | null) => void;
  /** Theme ramp — defaults match Orka's design tokens. Consumers can
   *  override individual colors but rarely need to. */
  className?: string;
};

/**
 * Embedded xterm.js panel attached to a Rust-side PTY. Every spawn
 * gets its own pty_id; this component owns one PTY for its lifetime.
 *
 * The Rust side batches stdout at ~30ms / 2KB so even `cat` of a big
 * file doesn't drown the IPC channel; we still set xterm's
 * `convertEol: true` so unix-only `\n` writes render as a real line.
 */
export function EmbeddedTerminal({
  cwd,
  command = defaultShell(),
  args,
  env,
  onExit,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  // Surfaces fatal spawn errors. Once we have a PTY id, errors flow
  // through xterm.write instead of state.
  const [error, setError] = useState<string | null>(null);

  // Initialise xterm + spawn PTY ONCE. We deliberately run this in
  // useLayoutEffect so the container has its measured size when
  // FitAddon computes the initial rows/cols — useEffect would race
  // with the first paint and ship a 1×1 PTY.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      theme: {
        background: "#0a0d12",
        foreground: "#e6e6e6",
        cursor: "#a855f7",
        selectionBackground: "rgba(168, 85, 247, 0.3)",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;

    (async () => {
      try {
        const ptyId = await invokeCmd<string>("pty_spawn", {
          cwd: cwd ?? null,
          cmd: command,
          args: args ?? [],
          rows: term.rows,
          cols: term.cols,
          env: env ?? [],
        });
        if (cancelled) {
          // Component unmounted before spawn returned — clean up.
          await invokeCmd("pty_kill", { ptyId }).catch(() => undefined);
          return;
        }
        ptyIdRef.current = ptyId;

        const unOutput = await listenEvent<{ data: string }>(
          `pty:output:${ptyId}`,
          (p) => {
            term.write(p.data);
          },
        );
        const unExit = await listenEvent<{ code: number | null }>(
          `pty:exit:${ptyId}`,
          (p) => {
            term.write(`\r\n\x1b[2m[process exited ${p.code ?? "?"}]\x1b[0m\r\n`);
            onExit?.(p.code ?? null);
          },
        );
        // Forward keystrokes to the PTY. Don't await — fire-and-forget
        // keeps typing latency at xterm's natural cadence.
        const dataDisposer = term.onData((s) => {
          void invokeCmd("pty_write", { ptyId, data: s }).catch(() => undefined);
        });

        cleanupRef.current.push(unOutput);
        cleanupRef.current.push(unExit);
        cleanupRef.current.push(() => dataDisposer.dispose());
      } catch (e) {
        const msg = String(e);
        setError(msg);
        if (termRef.current) {
          termRef.current.write(`\r\n\x1b[31m✗ ${msg}\x1b[0m\r\n`);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanupRef.current.splice(0)) {
        try {
          fn();
        } catch {
          /* ignored */
        }
      }
      if (ptyIdRef.current) {
        const id = ptyIdRef.current;
        ptyIdRef.current = null;
        void invokeCmd("pty_kill", { ptyId: id }).catch(() => undefined);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Spawn args are read once on mount by design — restarting for
    // every prop change would surprise users mid-session. Parents
    // wanting a fresh PTY should remount via React `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize the PTY when the container changes size. ResizeObserver
  // gives us per-frame change events; we debounce with a single rAF
  // to coalesce rapid drags into one resize call.
  useEffect(() => {
    const container = containerRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!container || !term || !fit) return;
    let pending = false;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        try {
          fit.fit();
        } catch {
          /* container detached */
          return;
        }
        const id = ptyIdRef.current;
        if (id) {
          void invokeCmd("pty_resize", {
            ptyId: id,
            rows: term.rows,
            cols: term.cols,
          }).catch(() => undefined);
        }
      });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={"embedded-terminal" + (className ? ` ${className}` : "")}
      role="region"
      aria-label="Embedded terminal"
      data-error={error || undefined}
    />
  );
}

/** Best-effort default shell. The Rust side falls back further when
 *  this binary doesn't exist on the user's PATH. */
function defaultShell(): string {
  // SSR / vitest happy-dom fallback.
  if (typeof navigator === "undefined") return "/bin/bash";
  const ua = navigator.userAgent;
  if (ua.includes("Win")) return "powershell.exe";
  return "/bin/bash";
}
