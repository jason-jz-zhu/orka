import { create } from "zustand";
import { invokeCmd } from "./tauri";

export type RunRecord = {
  id: string;
  skill: string;
  inputs: string[];
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  status: string;
  trigger: string;
  error_message?: string;
  /** Claude session id produced by this run. Runs Dashboard uses this
   *  to render each row as a link that jumps to the Sessions tab with
   *  that session pre-selected. Optional — historic rows lack it. */
  session_id?: string;
  /** Resolved working directory this run used. Drives the "📄 Open"
   *  button that reveals the folder in Finder. Optional for legacy
   *  rows written before this field existed. */
  workdir?: string;
};

type RunsState = {
  runs: RunRecord[];
  loading: boolean;
  refresh: () => Promise<void>;
};

export const useRuns = create<RunsState>((set) => ({
  runs: [],
  loading: true,
  refresh: async () => {
    try {
      const list = await invokeCmd<RunRecord[]>("list_runs", { limit: 200 });
      set({ runs: list, loading: false });
    } catch (e) {
      console.warn("list_runs failed:", e);
      set({ loading: false });
    }
  },
}));
