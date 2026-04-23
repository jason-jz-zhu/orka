import { invokeCmd } from "./tauri";

export type TerminalPreference =
  | "auto"
  | "terminal-app"
  | "iterm"
  | "warp"
  | "vscode"
  | "custom";

export type TerminalConfig = {
  preference: TerminalPreference;
  custom_template?: string | null;
};

export type LaunchResult = {
  resolved: string;
  command: string;
  clipboard_payload?: string | null;
};

export async function getTerminalConfig(): Promise<TerminalConfig> {
  return await invokeCmd<TerminalConfig>("get_terminal_config");
}

export async function setTerminalConfig(cfg: TerminalConfig): Promise<void> {
  await invokeCmd("set_terminal_config", { config: cfg });
}

export async function detectAvailableTerminals(): Promise<string[]> {
  return await invokeCmd<string[]>("detect_available_terminals");
}

export async function openSessionInTerminal(
  runId: string,
  sessionId: string,
  workdir: string | null = null,
  /** Optional per-click override. When provided, this terminal is
   *  launched this time regardless of the saved preference — useful
   *  for the split-button dropdown that lets users pick another
   *  terminal without changing their default. */
  terminalPreset: TerminalPreference | null = null,
): Promise<LaunchResult> {
  return await invokeCmd<LaunchResult>("open_session_in_terminal", {
    runId,
    sessionId,
    workdir,
    terminalPreset,
  });
}

export const TERMINAL_LABEL: Record<TerminalPreference, string> = {
  auto: "Auto-detect",
  "terminal-app": "Terminal.app",
  iterm: "iTerm2",
  warp: "Warp",
  vscode: "VS Code (+ clipboard)",
  custom: "Custom command",
};
