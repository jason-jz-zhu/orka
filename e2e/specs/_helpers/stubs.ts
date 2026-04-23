import type { Page } from "@playwright/test";

/**
 * Navigate to the Workforce tab (Claude Code sessions). The Skills tab
 * is the default landing view, so every session-dashboard spec needs
 * this flip first.
 *
 * Label is "Workforce" per the operator-layer positioning; the
 * underlying tab key stays `"monitor"` so persisted UI state and
 * analytics keep working across the rename.
 */
export async function openSessionsTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Workforce" }).click();
}

export type ProjectInfo = {
  key: string;
  cwd: string;
  name: string;
  session_count: number;
  last_modified_ms: number;
  status_counts: { live: number; done: number; errored: number; idle: number };
  is_orka: boolean;
};

export type SessionInfo = {
  id: string;
  path: string;
  project_key: string;
  project_cwd: string;
  modified_ms: number;
  size_bytes: number;
  first_user_preview: string | null;
  last_message_preview: string | null;
  last_user_preview: string | null;
  spawn_label: string | null;
  status: "live" | "done" | "errored" | "idle";
  turn_count: number;
  awaiting_user: boolean;
};

const now = Date.now();

export const happyProject: ProjectInfo = {
  key: "-tmp-orka-e2e",
  cwd: "/tmp/orka-e2e",
  name: "orka-e2e",
  session_count: 3,
  last_modified_ms: now,
  status_counts: { live: 0, done: 2, errored: 0, idle: 1 },
  is_orka: false,
};

export const happySession: SessionInfo = {
  id: "happy-001",
  path: "/tmp/orka-e2e/happy-001.jsonl",
  project_key: happyProject.key,
  project_cwd: happyProject.cwd,
  modified_ms: now - 120_000,
  size_bytes: 500,
  first_user_preview: "fix the typo in README",
  last_message_preview: "Done.",
  last_user_preview: "fix the typo in README",
  spawn_label: null,
  status: "live",
  turn_count: 1,
  awaiting_user: true,
};

export const compactedSession: SessionInfo = {
  id: "compacted-001",
  path: "/tmp/orka-e2e/compacted-001.jsonl",
  project_key: happyProject.key,
  project_cwd: happyProject.cwd,
  modified_ms: now - 60_000,
  size_bytes: 800,
  first_user_preview: "add a test for the parser",
  last_message_preview: "[compacted]",
  last_user_preview: "add a test for the parser",
  spawn_label: null,
  status: "live",
  turn_count: 1,
  // The bug we just fixed: after /compact, the Rust side now correctly
  // reports awaiting_user=true. We mirror that here; a regression on
  // the Rust side would also update this fixture and fail the spec.
  awaiting_user: true,
};

export const recapSession: SessionInfo = {
  id: "recap-001",
  path: "/tmp/orka-e2e/recap-001.jsonl",
  project_key: happyProject.key,
  project_cwd: happyProject.cwd,
  modified_ms: now - 30_000,
  size_bytes: 1200,
  first_user_preview: "build the pipeline",
  last_message_preview: "※ recap: …",
  last_user_preview: null,
  spawn_label: null,
  status: "live",
  turn_count: 1,
  awaiting_user: true,
};

/**
 * addInitScript serializes its args via JSON, so we can't pass closures.
 * Instead tests provide a plain record mapping command → literal payload
 * (or `"__throw__"` sentinel for commands that should reject).
 */
export type ExtraStubs = Record<string, unknown>;

type Options = {
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  extra?: ExtraStubs;
};

/** Sentinel a spec stores under a command name to make it reject. */
export const THROW_SENTINEL = "__orka_e2e_throw__";

/**
 * Install synchronous command stubs on the page before any app code runs.
 * Relies on the E2E hook added in src/lib/tauri.ts:browserFallback —
 * `window.__ORKA_E2E__` is consulted first when `inTauri` is false.
 */
export async function installSessionStubs(page: Page, opts: Options) {
  await page.addInitScript(
    ({ projects, sessions, extra, throwSentinel }) => {
      type Args = Record<string, unknown> | undefined;
      const base: Record<string, (args?: Args) => unknown> = {
        list_projects: () => projects,
        list_sessions: (args) => {
          const key = (args as { projectKey?: string; project_key?: string } | undefined)
            ?.projectKey ??
            (args as { project_key?: string } | undefined)?.project_key;
          return key ? sessions.filter((s) => s.project_key === key) : sessions;
        },
        active_workspace: () => "e2e-workspace",
        list_workspaces: () => [
          { name: "e2e-workspace", active: true, modified_ms: 0 },
        ],
        get_session_brief: () => null,
        generate_session_brief: () => null,
        clear_session_brief: () => null,
        // Resolve a session id to its SessionInfo from the fixture list.
        // This powers the Logbook meeting flow, which looks a run's
        // session_id up via this Tauri command.
        find_session_by_id: (args) => {
          const sid = (args as { sessionId?: string; session_id?: string } | undefined)
            ?.sessionId ??
            (args as { session_id?: string } | undefined)?.session_id;
          if (!sid) return null;
          return sessions.find((s) => s.id === sid) ?? null;
        },
        list_schedules: () => [],
        onboarding_status: () => ({
          claude_installed: true,
          claude_version: "e2e",
          claude_logged_in: true,
          projects_dir_exists: true,
          workspace_initialized: true,
          platform: "browser",
        }),
        start_projects_watcher: () => null,
        debug_session: () => ({}),
      };
      // Override with the spec's literal payloads; `throwSentinel`
      // values are rewritten into functions that reject so the app's
      // catch branches fire as they would in the real backend.
      const stubs: Record<string, (args?: Args) => unknown> = { ...base };
      for (const [cmd, value] of Object.entries(extra)) {
        if (value === throwSentinel) {
          stubs[cmd] = () => {
            throw new Error(`[e2e stub] ${cmd} forced to reject`);
          };
        } else {
          stubs[cmd] = () => value;
        }
      }
      (window as unknown as { __ORKA_E2E__: typeof stubs }).__ORKA_E2E__ = stubs;
      // Onboarding modal overlays the app and intercepts pointer events —
      // every spec should land in the main UI, not the welcome flow.
      try {
        localStorage.setItem("orka:onboardingCompleted", "1");
      } catch {}
    },
    {
      projects: opts.projects,
      sessions: opts.sessions,
      extra: opts.extra ?? {},
      throwSentinel: THROW_SENTINEL,
    },
  );
}
