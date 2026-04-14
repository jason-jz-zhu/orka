import { useEffect, useRef } from "react";
import { invokeCmd } from "./tauri";
import { useGraph, type OrkaNode } from "./graph-store";
import type { Edge } from "@xyflow/react";

type Snapshot = { nodes: unknown; edges: unknown };

/** Hook: auto-load on mount, auto-save debounced on changes. */
export function usePersistence() {
  const loadedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { nodes, edges, setGraph } = useGraph();

  // Load once on mount.
  useEffect(() => {
    (async () => {
      try {
        const snap = await invokeCmd<Snapshot | null>("load_graph");
        if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.edges)) {
          setGraph(snap.nodes as OrkaNode[], snap.edges as Edge[]);
        }
      } catch (e) {
        console.warn("load_graph failed:", e);
      } finally {
        loadedRef.current = true;
      }
    })();
  }, [setGraph]);

  // Debounced save.
  useEffect(() => {
    if (!loadedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const snapshot: Snapshot = { nodes, edges };
      invokeCmd("save_graph", { snapshot }).catch((e) =>
        console.warn("save_graph failed:", e)
      );
    }, 400);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [nodes, edges]);
}
