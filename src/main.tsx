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

/** Errors the browser surfaces but that are NOT fatal — they should not
 * replace the whole UI with a crash screen. The classic offender is
 * ResizeObserver's "loop completed with undelivered notifications" warning,
 * which fires whenever a layout thrash happens (very common with ReactFlow
 * during parallel node updates). */
function isBenignError(msg: string): boolean {
  return (
    msg.includes("ResizeObserver loop") ||
    msg.includes("ResizeObserver loop completed") ||
    msg.includes("Non-Error promise rejection captured")
  );
}

window.addEventListener("error", (e) => {
  const msg = String(e.message ?? e.error ?? "");
  if (isBenignError(msg)) {
    e.preventDefault();
    return;
  }
  showCrash("error", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = String(e.reason instanceof Error ? e.reason.message : e.reason);
  if (isBenignError(msg)) {
    e.preventDefault();
    return;
  }
  showCrash("rejection", e.reason);
});

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
