import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL cleanup after each test so component DOM doesn't leak between cases.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Intentionally DO NOT set `window.__TAURI_INTERNALS__`. `inTauri` in
// src/lib/tauri.ts checks for it; leaving it undefined forces the
// existing browserFallback path, which stubs out every command we use
// in components. Tests override per-case via `vi.mock(...)` when they
// need specific payloads.

// jsdom doesn't implement ResizeObserver; some React components call it.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
  ResizeObserverMock;
