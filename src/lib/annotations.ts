import { create } from "zustand";
import { invokeCmd, inTauri } from "./tauri";

/**
 * Per-output annotations store — Day 2 of Output Annotator.
 *
 * Design:
 *   - One zustand store, indexed by `outputId`. An outputId is the
 *     stable id of whatever owns the Claude output: a ChatNode node id
 *     for on-canvas outputs, a run id for the Runs tab, etc.
 *   - Each output holds a Map<blockIdx, Annotation>. We use a Map (not
 *     an object) because block indices change rarely but are compared
 *     numerically and we want O(1) lookup/update.
 *   - Persistence via Tauri commands (save_annotation / delete_annotation
 *     / load_annotations). Frontend state is the cache; backend JSON file
 *     is the source of truth.
 *   - Browser fallback (vite dev without Tauri): in-memory only.
 */

export interface Annotation {
  blockIdx: number;
  blockHash: string;
  blockType: string;
  blockContent: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedShape {
  version: number;
  annotations: Annotation[];
}

interface State {
  /** outputId → (blockIdx → Annotation) */
  byOutput: Map<string, Map<number, Annotation>>;
  /** outputIds currently being loaded (to deduplicate concurrent loads). */
  loading: Set<string>;

  /** Load annotations for an output id from backend. No-op if already loaded. */
  load: (outputId: string) => Promise<void>;
  /** Return the Annotation map for an outputId (empty Map if none). */
  forOutput: (outputId: string) => Map<number, Annotation>;
  /** Upsert an annotation. Writes through to backend. */
  upsert: (outputId: string, partial: Omit<Annotation, "createdAt" | "updatedAt">) => Promise<void>;
  /** Remove. Writes through to backend. */
  remove: (outputId: string, blockIdx: number) => Promise<void>;
}

/** Deep-clone the byOutput map so set() triggers consumers that compare by identity. */
function cloneMap(src: Map<string, Map<number, Annotation>>): Map<string, Map<number, Annotation>> {
  const out = new Map<string, Map<number, Annotation>>();
  for (const [k, v] of src) out.set(k, new Map(v));
  return out;
}

export const useAnnotations = create<State>((set, get) => ({
  byOutput: new Map(),
  loading: new Set(),

  load: async (outputId: string) => {
    const { byOutput, loading } = get();
    if (byOutput.has(outputId) || loading.has(outputId)) return;

    const nextLoading = new Set(loading);
    nextLoading.add(outputId);
    set({ loading: nextLoading });

    try {
      let list: Annotation[] = [];
      if (inTauri) {
        const persisted = await invokeCmd<PersistedShape>("load_annotations", { outputId });
        list = persisted?.annotations ?? [];
      }
      const next = cloneMap(get().byOutput);
      const inner = new Map<number, Annotation>();
      for (const a of list) inner.set(a.blockIdx, a);
      next.set(outputId, inner);
      const done = new Set(get().loading);
      done.delete(outputId);
      set({ byOutput: next, loading: done });
    } catch (e) {
      // Loading failures are non-fatal — annotations are additive UX.
      console.warn(`[annotations] load failed for ${outputId}:`, e);
      const done = new Set(get().loading);
      done.delete(outputId);
      // Still seed an empty map so subsequent calls don't re-fetch forever.
      const next = cloneMap(get().byOutput);
      if (!next.has(outputId)) next.set(outputId, new Map());
      set({ byOutput: next, loading: done });
    }
  },

  forOutput: (outputId: string) => {
    return get().byOutput.get(outputId) ?? new Map();
  },

  upsert: async (outputId, partial) => {
    const now = new Date().toISOString();
    const existing = get().byOutput.get(outputId)?.get(partial.blockIdx);
    const annotation: Annotation = {
      ...partial,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Optimistic local update first so UI feels instant.
    const next = cloneMap(get().byOutput);
    const inner = next.get(outputId) ?? new Map<number, Annotation>();
    inner.set(annotation.blockIdx, annotation);
    next.set(outputId, inner);
    set({ byOutput: next });

    if (!inTauri) return;

    try {
      const persisted = await invokeCmd<PersistedShape>("save_annotation", {
        outputId,
        annotation,
      });
      // Replace with backend-authoritative list (timestamps may differ by ms).
      const after = cloneMap(get().byOutput);
      const fresh = new Map<number, Annotation>();
      for (const a of persisted.annotations) fresh.set(a.blockIdx, a);
      after.set(outputId, fresh);
      set({ byOutput: after });
    } catch (e) {
      console.warn(`[annotations] save failed for ${outputId}:`, e);
    }
  },

  remove: async (outputId, blockIdx) => {
    const next = cloneMap(get().byOutput);
    const inner = next.get(outputId);
    if (inner) inner.delete(blockIdx);
    set({ byOutput: next });

    if (!inTauri) return;

    try {
      const persisted = await invokeCmd<PersistedShape>("delete_annotation", {
        outputId,
        blockIdx,
      });
      const after = cloneMap(get().byOutput);
      const fresh = new Map<number, Annotation>();
      for (const a of persisted.annotations) fresh.set(a.blockIdx, a);
      after.set(outputId, fresh);
      set({ byOutput: after });
    } catch (e) {
      console.warn(`[annotations] delete failed for ${outputId}:`, e);
    }
  },
}));

/**
 * Stable empty fallback. Returning `new Map()` from a selector causes
 * zustand v5 to detect a "state change" every render (Object.is fails on
 * fresh instances) and recurse into infinite re-render, crashing the app.
 * Always return this singleton when the outputId has no annotations yet.
 */
const EMPTY_ANNOTATIONS: Map<number, Annotation> = new Map();

/** Hook helper: reactive Annotation map for a specific outputId. */
export function useOutputAnnotations(outputId: string): Map<number, Annotation> {
  return useAnnotations((s) => s.byOutput.get(outputId) ?? EMPTY_ANNOTATIONS);
}
