import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export const inTauri =
  typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

export async function invokeCmd<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (inTauri) return tauriInvoke<T>(cmd, args);
  return browserFallback<T>(cmd, args);
}

export async function listenEvent<T = unknown>(
  name: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  // Wrap the underlying unlisten so it is idempotent AND swallows both
  // sync throws and async rejections. Tauri v2's returned unlisten is
  // `async () => _unlisten(...)`, and `_unlisten` synchronously calls
  // `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(...)`
  // which crashes with `listeners[eventId].handlerId` when the same
  // listener gets disposed twice (e.g., StrictMode effect re-runs).
  // Since the throw happens inside an async fn it becomes a promise
  // rejection, so plain try/catch around the call does not catch it.
  let disposed = false;
  if (inTauri) {
    const raw = await tauriListen<T>(name, (e) => handler(e.payload as T));
    return () => {
      if (disposed) return;
      disposed = true;
      Promise.resolve()
        .then(() => raw())
        .catch((e) => {
          console.warn(`unlisten(${name}) failed (ignored):`, e);
        });
    };
  }
  const listener = (e: Event) => handler((e as CustomEvent).detail as T);
  window.addEventListener(name, listener);
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener(name, listener);
  };
}

// ---- browser fallback ----
// Emits the same stream / done events a real run would, so UI flows can be tested
// in a plain browser (no Tauri, no real claude).
function dispatch(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function browserFallback<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  // E2E hook: Playwright sets `window.__ORKA_E2E__` to a synchronous
  // command resolver so specs can inject fixture data without running
  // a real Tauri backend. Keys are command names; values are handlers
  // that receive the args and return the payload.
  type E2EStubs = Record<string, (args?: Record<string, unknown>) => unknown>;
  const e2e = (window as unknown as { __ORKA_E2E__?: E2EStubs }).__ORKA_E2E__;
  if (e2e && Object.prototype.hasOwnProperty.call(e2e, cmd)) {
    return e2e[cmd](args) as T;
  }
  if (cmd === "run_node" || cmd === "run_agent_node") {
    const id = (args?.id as string) ?? "?";
    const prompt = (args?.prompt as string) ?? "";
    // Simulate a stream-json flow.
    queueMicrotask(() => {
      dispatch(
        `node:${id}:stream`,
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "browser-fallback",
        })
      );
      const text = `ECHO [node ${id}]: ${prompt}`;
      dispatch(
        `node:${id}:stream`,
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        })
      );
      dispatch(
        `node:${id}:stream`,
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: text,
          total_cost_usd: 0,
        })
      );
      dispatch(`node:${id}:done`, { ok: true });
    });
    return undefined as unknown as T;
  }
  if (cmd === "save_graph") return undefined as unknown as T;
  if (cmd === "load_graph") return null as unknown as T;
  if (cmd === "kb_list") return [] as unknown as T;
  if (cmd === "kb_ingest") return "fake.txt" as unknown as T;
  if (cmd === "kb_ingest_dir") return [] as unknown as T;
  if (cmd === "list_projects") return [] as unknown as T;
  if (cmd === "list_sessions") return [] as unknown as T;
  if (cmd === "read_session") return [] as unknown as T;
  if (cmd === "watch_session") return undefined as unknown as T;
  if (cmd === "unwatch_session") return undefined as unknown as T;
  if (cmd === "start_projects_watcher") return undefined as unknown as T;
  if (cmd === "cancel_node") return false as unknown as T;
  if (cmd === "list_workspaces")
    return [
      { name: "default-workspace", active: true, modified_ms: 0 },
    ] as unknown as T;
  if (cmd === "active_workspace") return "default-workspace" as unknown as T;
  if (cmd === "create_workspace") return undefined as unknown as T;
  if (cmd === "switch_workspace") return undefined as unknown as T;
  if (cmd === "rename_workspace") return undefined as unknown as T;
  if (cmd === "duplicate_workspace") return undefined as unknown as T;
  if (cmd === "delete_workspace") return undefined as unknown as T;
  if (cmd === "list_templates") return [] as unknown as T;
  if (cmd === "save_template") return undefined as unknown as T;
  if (cmd === "load_template") return "{}" as unknown as T;
  if (cmd === "delete_template") return undefined as unknown as T;
  if (cmd === "write_output_file") return "/tmp/orka-fake.md" as unknown as T;
  if (cmd === "outputs_dir") return "/tmp/orka-outputs" as unknown as T;
  if (cmd === "icloud_orka_path") return "/tmp/orka-icloud" as unknown as T;
  if (cmd === "write_to_icloud") return "/tmp/orka-icloud/fake.md" as unknown as T;
  if (cmd === "append_to_apple_note") return "created:fake" as unknown as T;
  if (cmd === "markdown_to_html") {
    const md = String((args as { markdown?: string } | undefined)?.markdown ?? "");
    return `<pre>${md.replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c] ?? c))}</pre>` as unknown as T;
  }
  if (cmd === "post_to_webhook") return "HTTP 200 · POST (browser stub)" as unknown as T;
  if (cmd === "run_shell_destination") return "shell ok (browser stub)" as unknown as T;
  if (cmd === "list_destination_profiles") return [] as unknown as T;
  if (cmd === "save_destination_profile") return undefined as unknown as T;
  if (cmd === "delete_destination_profile") return undefined as unknown as T;
  if (cmd === "get_destination_profile") return null as unknown as T;
  if (cmd === "test_wework_webhook") return "HTTP 200 · sent (browser stub)" as unknown as T;
  if (cmd === "send_via_profile") return "ok (browser stub)" as unknown as T;
  if (cmd === "open_app_by_name") return undefined as unknown as T;
  if (cmd === "read_file_text") return "{}" as unknown as T;
  if (cmd === "fetch_text_url") return "{}" as unknown as T;
  if (cmd === "list_schedules") return [] as unknown as T;
  if (cmd === "get_schedule") return null as unknown as T;
  if (cmd === "save_schedule") return undefined as unknown as T;
  if (cmd === "delete_schedule") return undefined as unknown as T;
  if (cmd === "os_notify") return undefined as unknown as T;
  if (cmd === "generate_pipeline")
    return {
      pipeline: {
        nodes: [
          {
            id: "n1",
            type: "chat",
            position: { x: 60, y: 60 },
            data: { prompt: "Browser-fallback stub chat" },
          },
        ],
        edges: [],
      },
      raw: "(browser fallback)",
    } as unknown as T;
  if (cmd === "onboarding_status")
    return {
      claude_installed: true,
      claude_version: "browser-fallback",
      claude_logged_in: true,
      projects_dir_exists: true,
      workspace_initialized: true,
      platform: "browser",
    } as unknown as T;
  if (cmd === "debug_session") return {} as unknown as T;
  if (cmd === "focus_session_terminal") return "noop (browser)" as unknown as T;
  if (cmd === "kb_dir") return "/tmp/fake-kb" as unknown as T;
  throw new Error(`invoke(${cmd}) not available outside Tauri`);
}
