import { ask, message } from "@tauri-apps/plugin-dialog";
import { inTauri } from "./tauri";

/**
 * Cross-environment dialogs. Tauri's WKWebView on macOS does not implement
 * `window.prompt` / `window.confirm` / `window.alert` — calling them returns
 * null/false/undefined silently, which previously made the toolbar Save
 * button appear broken.
 *
 * In Tauri we route to `@tauri-apps/plugin-dialog`. In the browser fallback
 * (vite dev) we use the native window APIs.
 */

export async function alertDialog(msg: string, title = "Orka"): Promise<void> {
  if (inTauri) {
    await message(msg, { title, kind: "info" });
    return;
  }
  window.alert(msg);
}

export async function confirmDialog(
  msg: string,
  opts?: { title?: string; okLabel?: string; cancelLabel?: string }
): Promise<boolean> {
  if (inTauri) {
    return await ask(msg, {
      title: opts?.title ?? "Orka",
      okLabel: opts?.okLabel,
      cancelLabel: opts?.cancelLabel,
      kind: "info",
    });
  }
  return window.confirm(msg);
}

/**
 * Tauri's plugin-dialog has no built-in text-input prompt. We render an
 * in-page modal as the Tauri implementation, and use `window.prompt` in
 * the browser. The Tauri modal returns null on cancel, the trimmed string
 * otherwise.
 */
export async function promptDialog(
  msg: string,
  opts?: { default?: string; title?: string }
): Promise<string | null> {
  if (!inTauri) {
    const v = window.prompt(msg, opts?.default ?? "");
    return v === null ? null : v.trim();
  }
  return openInPagePrompt(msg, opts);
}

function openInPagePrompt(
  msg: string,
  opts?: { default?: string; title?: string }
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "orka-prompt__overlay";
    const box = document.createElement("div");
    box.className = "orka-prompt__box";

    if (opts?.title) {
      const title = document.createElement("div");
      title.className = "orka-prompt__title";
      title.textContent = opts.title;
      box.appendChild(title);
    }

    const label = document.createElement("div");
    label.className = "orka-prompt__msg";
    label.textContent = msg;
    box.appendChild(label);

    const input = document.createElement("input");
    input.className = "orka-prompt__input";
    input.type = "text";
    input.value = opts?.default ?? "";
    input.autocomplete = "off";
    box.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "orka-prompt__actions";
    const cancel = document.createElement("button");
    cancel.className = "orka-prompt__btn orka-prompt__btn--secondary";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "orka-prompt__btn orka-prompt__btn--primary";
    ok.textContent = "OK";
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function cleanup() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    }
    function done(v: string | null) {
      cleanup();
      resolve(v === null ? null : v.trim() || null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        done(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    }
    document.addEventListener("keydown", onKey);
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done(input.value));

    setTimeout(() => input.focus(), 0);
  });
}
