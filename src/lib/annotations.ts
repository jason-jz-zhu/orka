import { create } from "zustand";
import { invokeCmd, inTauri } from "./tauri";

/**
 * Per-output annotations — thread-shaped.
 *
 * An annotation is a conversation thread attached to a block. The thread
 * holds both user notes and Claude replies (from `--resume`'d follow-ups),
 * which unifies the "comment on a block" and "continue chatting about a
 * block" interactions into one data type and one UI surface.
 */

export interface ThreadMessage {
  author: "you" | "claude";
  text: string;
  createdAt: string;
}

export interface Annotation {
  blockIdx: number;
  blockHash: string;
  blockType: string;
  blockContent: string;
  thread: ThreadMessage[];
  savedToNotes: boolean;
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
  loading: Set<string>;

  load: (outputId: string) => Promise<void>;

  /**
   * Append a single message to a block's thread. The primary write path
   * for both user messages and Claude replies — avoids round-tripping
   * the whole annotation object when all we have is one more turn.
   */
  appendMessage: (
    outputId: string,
    blockInfo: {
      blockIdx: number;
      blockHash: string;
      blockType: string;
      blockContent: string;
    },
    message: { author: "you" | "claude"; text: string }
  ) => Promise<void>;

  /**
   * Replace a block's annotation wholesale. Used for the rare cases
   * where we need to rewrite a thread (e.g., editing a past message or
   * toggling savedToNotes).
   */
  upsert: (outputId: string, annotation: Annotation) => Promise<void>;

  remove: (outputId: string, blockIdx: number) => Promise<void>;
}

const EMPTY_ANNOTATIONS: Map<number, Annotation> = new Map();

function cloneMap(src: Map<string, Map<number, Annotation>>): Map<string, Map<number, Annotation>> {
  const out = new Map<string, Map<number, Annotation>>();
  for (const [k, v] of src) out.set(k, new Map(v));
  return out;
}

function indexed(list: Annotation[]): Map<number, Annotation> {
  const m = new Map<number, Annotation>();
  for (const a of list) m.set(a.blockIdx, a);
  return m;
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
      next.set(outputId, indexed(list));
      const done = new Set(get().loading);
      done.delete(outputId);
      set({ byOutput: next, loading: done });
    } catch (e) {
      console.warn(`[annotations] load failed for ${outputId}:`, e);
      const done = new Set(get().loading);
      done.delete(outputId);
      const next = cloneMap(get().byOutput);
      if (!next.has(outputId)) next.set(outputId, new Map());
      set({ byOutput: next, loading: done });
    }
  },

  appendMessage: async (outputId, blockInfo, message) => {
    // Optimistic local append so the UI shows the message immediately
    // (especially important for Claude streaming, where we'll replace
    // this placeholder with the real response as chunks arrive).
    const now = new Date().toISOString();
    const next = cloneMap(get().byOutput);
    const inner = next.get(outputId) ?? new Map<number, Annotation>();
    const existing = inner.get(blockInfo.blockIdx);
    const threadTail: ThreadMessage = {
      author: message.author,
      text: message.text,
      createdAt: now,
    };
    if (existing) {
      inner.set(blockInfo.blockIdx, {
        ...existing,
        thread: [...existing.thread, threadTail],
        updatedAt: now,
      });
    } else {
      inner.set(blockInfo.blockIdx, {
        ...blockInfo,
        thread: [threadTail],
        savedToNotes: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    next.set(outputId, inner);
    set({ byOutput: next });

    if (!inTauri) return;

    try {
      const persisted = await invokeCmd<PersistedShape>("append_message", {
        outputId,
        blockIdx: blockInfo.blockIdx,
        blockHash: blockInfo.blockHash,
        blockType: blockInfo.blockType,
        blockContent: blockInfo.blockContent,
        author: message.author,
        text: message.text,
      });
      const after = cloneMap(get().byOutput);
      after.set(outputId, indexed(persisted.annotations));
      set({ byOutput: after });
    } catch (e) {
      console.warn(`[annotations] appendMessage failed for ${outputId}:`, e);
    }
  },

  upsert: async (outputId, annotation) => {
    // Local-first write.
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
      const after = cloneMap(get().byOutput);
      after.set(outputId, indexed(persisted.annotations));
      set({ byOutput: after });
    } catch (e) {
      console.warn(`[annotations] upsert failed for ${outputId}:`, e);
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
      after.set(outputId, indexed(persisted.annotations));
      set({ byOutput: after });
    } catch (e) {
      console.warn(`[annotations] remove failed for ${outputId}:`, e);
    }
  },
}));

export function useOutputAnnotations(outputId: string): Map<number, Annotation> {
  return useAnnotations((s) => s.byOutput.get(outputId) ?? EMPTY_ANNOTATIONS);
}
