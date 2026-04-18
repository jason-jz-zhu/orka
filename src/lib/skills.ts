import { create } from "zustand";
import { invokeCmd, listenEvent } from "./tauri";

export type SkillInputMeta = {
  name: string;
  type: string;
  default?: string;
  description?: string;
};

export type SkillMeta = {
  slug: string;
  name: string;
  description: string;
  path: string;
  source: "global" | "workspace" | "sibling";
  has_graph: boolean;
  inputs: SkillInputMeta[];
};

type SkillsState = {
  skills: SkillMeta[];
  loading: boolean;
  refresh: () => Promise<void>;
};

export const useSkills = create<SkillsState>((set) => ({
  skills: [],
  loading: true,
  refresh: async () => {
    try {
      const list = await invokeCmd<SkillMeta[]>("list_available_skills");
      set({ skills: list, loading: false });
    } catch (e) {
      console.warn("list_available_skills failed:", e);
      set({ loading: false });
    }
  },
}));

export async function getSkillDetail(slug: string): Promise<SkillMeta> {
  return invokeCmd<SkillMeta>("get_skill_detail", { slug });
}

let _unlisten: (() => void) | null = null;
let _initing = false;

export function initSkillsWatcher() {
  // Guard against double-init (StrictMode, remount, etc). Without this each
  // call registered a new listener and leaked the previous one.
  if (_unlisten || _initing) {
    useSkills.getState().refresh();
    return;
  }
  _initing = true;
  useSkills.getState().refresh();
  listenEvent("skills:changed", () => {
    useSkills.getState().refresh();
  }).then((fn) => {
    _unlisten = fn;
    _initing = false;
  });
}

export function cleanupSkillsWatcher() {
  _unlisten?.();
  _unlisten = null;
}
