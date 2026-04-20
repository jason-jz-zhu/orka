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
  /** `orka` = canonical Orka-managed skill at `~/.orka/skills/`.
   *  `global` = lives directly in `~/.claude/skills/` (user-authored
   *  or tap-installed). `workspace` = project-scoped. */
  source: "orka" | "global" | "workspace" | "sibling";
  has_graph: boolean;
  inputs: SkillInputMeta[];
  /** Natural-language example prompts from SKILL.md frontmatter
   *  `examples:`. Surfaced as clickable chips in SkillRunner so users
   *  see what to type without reading the skill's body. */
  examples: string[];
  /** True when the skill is visible to a bare `claude` CLI invocation.
   *  Orka-canonical skills are exposed only via a symlink the user
   *  opts into. Global/workspace skills are always exposed. */
  exposed: boolean;
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
