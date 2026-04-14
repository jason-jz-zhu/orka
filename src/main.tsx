import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

async function logToRust(level: string, message: string) {
  try {
    const w = window as any;
    if (w.__TAURI_INTERNALS__) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("log_from_js", { level, message });
    }
  } catch {}
}

function showCrash(where: string, err: unknown) {
  const root = document.getElementById("root");
  const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ""}` : String(err);
  logToRust("crash", `[${where}] ${msg}`);
  if (root) {
    root.innerHTML = "";
    root.style.cssText =
      "color:#ffb4b4;background:#1a0b0b;padding:16px;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;height:100vh;overflow:auto";
    root.textContent = `[orka crash @ ${where}]\n\n${msg}`;
  }
}

window.addEventListener("error", (e) => showCrash("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showCrash("rejection", e.reason));

try {
  const el = document.getElementById("root");
  if (!el) throw new Error("#root not found");
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (e) {
  showCrash("bootstrap", e);
}
