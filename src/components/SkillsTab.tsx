import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSkills, initSkillsWatcher, type SkillMeta } from "../lib/skills";
import { useRuns } from "../lib/runs";
import { SkillRunner } from "./SkillRunner";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { alertDialog, confirmDialog, promptDialog } from "../lib/dialogs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  lastDeliveredBySkill,
  fmtLastDelivered,
  runCountBySkill,
} from "../lib/skill-activity";
// Lazy: the marketplace modal pulls AddTapModal behind it. Only mounted
// when the user explicitly opens "Browse skill packs" from the add menu.
const SkillPacksModal = lazy(() => import("./SkillPacksModal"));
// Lazy: HireChatModal pulls react-markdown; we only pay for it when
// the user actually clicks "Hire by chat".
const HireChatModal = lazy(() =>
  import("./HireChatModal").then((m) => ({ default: m.HireChatModal })),
);

type PrewarmProgress = {
  current: number;
  total: number;
  slug: string;
  status: "start" | "ok" | "err" | "skipped";
  error: string | null;
};

type PrewarmSummary = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{
    slug: string;
    status: string;
    error: string | null;
    examples: string[] | null;
  }>;
};

/** Known tap-id prefixes — these come from the trusted_taps backend and
 *  indicate the skill was installed via a tap (gstack, etc). Slugs of
 *  installed-tap skills follow `<tap-id>-<skill-name>`; the prefix is
 *  stripped into a badge so the list stays readable. */
const KNOWN_TAP_PREFIXES = ["gstack"];

/** Slugs of Orka-shipped meta-skills — tools that build or manage
 *  other skills. They're pinned to the top of the sidebar, visually
 *  distinguished with a "built-in" badge, and can't be deleted from
 *  the UI (users who really want to remove them can rm the folder).
 *  Hard-coded for now; if the list grows, migrate to a SKILL.md
 *  frontmatter flag (`orka.system: true`). */
const META_SKILL_SLUGS = new Set(["orka-skill-builder"]);

function isMetaSkill(slug: string): boolean {
  return META_SKILL_SLUGS.has(slug);
}

function extractTapPrefix(slug: string): string | null {
  for (const p of KNOWN_TAP_PREFIXES) {
    if (slug.startsWith(`${p}-`)) return p;
  }
  return null;
}

/** First sentence of the description, capped at 70 chars. Skill authors
 *  tend to pack examples / trigger phrases into `description:` — shown
 *  in full this wraps to 3+ lines per card and drowns the list. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  // Prefer the first sentence-ending punctuation within the first 120
  // chars. Falls back to a hard clamp.
  const head = trimmed.slice(0, 140);
  const m = head.match(/^(.*?[.!?。！？])\s/);
  const candidate = m ? m[1] : head;
  return candidate.length > 70 ? candidate.slice(0, 68).trimEnd() + "…" : candidate;
}

type SkillsTabProps = {
  /** Supplied by App — opens a composite skill's DAG in the canvas. */
  onOpenInCanvas?: (slug: string, path: string) => Promise<void> | void;
};

/**
 * Skills tab — the new default entry point.
 *
 * Left: scrollable list of skills from ~/.claude/skills/, with search.
 * Right: SkillRunner for whichever skill is selected.
 *
 * Replaces the old "open Studio, find skill in palette, drag to canvas,
 * hook wires, hit Run All" flow for atomic skills. Canvas is no longer
 * required for the daily run-a-skill loop.
 */
export function SkillsTab({ onOpenInCanvas }: SkillsTabProps = {}) {
  const skills = useSkills((s) => s.skills);
  const loading = useSkills((s) => s.loading);
  const refresh = useSkills((s) => s.refresh);
  // Pull run history so each skill card can show "last delivered Nh ago".
  // `useRuns` maintains a shared cached list; one fetch here is reused by
  // Logbook, the morning ribbon, and Today's bucket logic.
  const runs = useRuns((s) => s.runs);
  const refreshRuns = useRuns((s) => s.refresh);
  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);
  const lastDelivered = useMemo(() => lastDeliveredBySkill(runs), [runs]);
  const runCounts = useMemo(() => runCountBySkill(runs), [runs]);
  const [filter, setFilter] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  // "Hire by describe" seed — the one-sentence goal the user typed
  // when choosing "+ Hire → Create new skill". Consumed by SkillRunner
  // (passed as initialPrompt) on first mount of the orka-skill-builder
  // runner. Cleared after one consumption so later opens of the same
  // skill don't re-prefill.
  const [hireSeed, setHireSeed] = useState<string | null>(null);

  useEffect(() => {
    initSkillsWatcher();
  }, []);

  // Clear the hire seed as soon as the user navigates away from the
  // builder — revisiting orka-skill-builder later shouldn't re-prefill
  // with the old goal.
  useEffect(() => {
    if (hireSeed && selectedSlug && selectedSlug !== "orka-skill-builder") {
      setHireSeed(null);
    }
  }, [selectedSlug, hireSeed]);

  const deferredFilter = useDeferredValue(filter);
  const filtered = useMemo(() => {
    const normFilter = deferredFilter.trim().toLowerCase();
    const base = !normFilter
      ? skills
      : skills.filter(
          (s) =>
            s.slug.toLowerCase().includes(normFilter) ||
            s.description.toLowerCase().includes(normFilter),
        );
    // Pin meta-skills (built-in tools that produce other skills) to the
    // top. They're not user-authored content; mixing them with real
    // skills used to confuse new users who'd try to schedule / evolve
    // a tool rather than a task. Stable sort preserves the backend's
    // intra-group order for normal skills.
    return [...base].sort((a, b) => {
      const am = isMetaSkill(a.slug) ? 0 : 1;
      const bm = isMetaSkill(b.slug) ? 0 : 1;
      return am - bm;
    });
  }, [skills, deferredFilter]);

  const selected: SkillMeta | null =
    skills.find((s) => s.slug === selectedSlug) ?? null;

  // How many of the loaded skills ship without example prompts. Drives
  // the batch prewarm banner in the sidebar header.
  const missingExamplesCount = useMemo(
    () => skills.filter((s) => !s.examples || s.examples.length === 0).length,
    [skills],
  );
  const [prewarming, setPrewarming] = useState(false);
  const [prewarmStatus, setPrewarmStatus] = useState<string | null>(null);
  // "+" dropdown — unified entry point for every way a new skill
  // can arrive in the app (create, import, install from tap).
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  // Marketplace ("Browse skill packs") opens from the add menu now —
  // the old sidebar section was retired to reclaim the space.
  const [showSkillPacks, setShowSkillPacks] = useState(false);
  // Hire-by-chat modal state. `initialGoal` is the optional seed from
  // the prompt version; empty string lets the user start the chat with
  // their own opening line. `null` = modal closed.
  const [hireChatOpen, setHireChatOpen] = useState<string | null>(null);

  // Close the add-menu on outside click + Escape. Standard popover
  // pattern — subscribes only while the menu is open.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!addMenuRef.current) return;
      if (!addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [addMenuOpen]);

  function openSkillPacks() {
    setAddMenuOpen(false);
    setShowSkillPacks(true);
  }

  /** Chat-based hiring flow (v2). Opens HireChatModal; the modal runs
   *  the multi-turn conversation with orka-skill-builder, detects the
   *  drafted SKILL.md in the stream, and writes it via the Rust
   *  `save_drafted_skill` command when the user confirms.
   *
   *  Falling back to the v1 prompt-dialog flow is gone — the chat
   *  modal handles the single-sentence case too (the goal pre-fills
   *  the first turn and auto-sends). */
  function hireByDescribe() {
    // Empty string opens the modal without auto-sending, so the user
    // can type their own opener. A future "quick hire" button could
    // pass a prefilled seed instead.
    setHireChatOpen("");
  }

  /** Import a skill folder from anywhere on disk. Opens a native folder
   *  picker → backend copies into ~/.claude/skills/<slug>/ → watcher
   *  picks it up. Handles slug collisions by prompting for an alternate
   *  name rather than silently overwriting. */
  async function handleImport() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Pick a folder containing SKILL.md",
    });
    if (typeof picked !== "string") return;

    let desiredSlug: string | undefined = undefined;
    // Loop to handle the "slug already exists" path — backend returns
    // an error with "already exists" and we re-prompt with a suggestion.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await invokeCmd<{ slug: string; destPath: string }>(
          "import_skill_folder",
          { srcPath: picked, desiredSlug: desiredSlug ?? null },
        );
        await refresh();
        setSelectedSlug(result.slug);
        return;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("already exists")) {
          const suggested = desiredSlug
            ? `${desiredSlug}-v2`
            : picked.split("/").filter(Boolean).pop() + "-v2";
          const next = await promptDialog(
            `That slug is taken. Enter a different slug (lowercase, digits, hyphens only):`,
            { title: "Choose a different slug", default: suggested },
          );
          if (!next) return;
          desiredSlug = next.trim();
          continue;
        }
        await alertDialog(`Import failed: ${msg}`);
        return;
      }
    }
    await alertDialog("Gave up after 3 collision retries — try again with a unique slug.");
  }

  /** Toggle whether an Orka-canonical skill is exposed to the bare
   *  `claude` CLI. Creates or removes a symlink at
   *  `~/.claude/skills/<slug>` pointing into `~/.orka/skills/<slug>/`.
   *  No-op (UI-disabled) for global/workspace skills — they're always
   *  visible to Claude regardless. */
  async function toggleExposed(s: SkillMeta) {
    if (s.source !== "orka") return;
    try {
      if (s.exposed) {
        await invokeCmd("unexpose_skill", { slug: s.slug });
      } else {
        await invokeCmd("expose_skill", { slug: s.slug });
      }
      await refresh();
    } catch (e) {
      await alertDialog(`Couldn't ${s.exposed ? "unexpose" : "expose"} skill: ${e}`);
    }
  }

  async function handleDelete(s: SkillMeta) {
    const ok = await confirmDialog(
      `Delete skill "${s.slug}"?\n\nThis removes the folder from ${s.source === "workspace" ? "the workspace" : "~/.claude/skills/"} and cannot be undone.`,
      {
        title: "Delete skill",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    if (!ok) return;
    try {
      await invokeCmd("delete_skill", { slug: s.slug });
      if (selectedSlug === s.slug) setSelectedSlug(null);
      await refresh();
    } catch (e) {
      await alertDialog(`Delete failed: ${e}`);
    }
  }

  async function prewarmAll() {
    if (prewarming) return;
    if (missingExamplesCount === 0) return;
    const estSeconds = Math.ceil(missingExamplesCount * 5); // rough: ~5s/skill w/ Sonnet
    const ok = await confirmDialog(
      `Generate example prompts for ${missingExamplesCount} skill${
        missingExamplesCount === 1 ? "" : "s"
      } that don't have any?\n\n` +
        `This calls Claude (Sonnet) once per skill and writes the result back to each SKILL.md. ` +
        `Approximate time: ${estSeconds}s. Cost: ~$${(missingExamplesCount * 0.01).toFixed(2)}.`,
      {
        title: "Prewarm examples",
        okLabel: "Generate",
        cancelLabel: "Cancel",
      },
    );
    if (!ok) return;

    setPrewarming(true);
    setPrewarmStatus(`Starting… (0 of ${missingExamplesCount})`);
    const unlisten = await listenEvent<PrewarmProgress>(
      "skill-examples:prewarm:progress",
      (p) => {
        if (p.status === "start") {
          setPrewarmStatus(`Generating for ${p.slug} (${p.current} of ${p.total})`);
        } else if (p.status === "err") {
          setPrewarmStatus(
            `✗ ${p.slug} failed — continuing (${p.current} of ${p.total})`,
          );
        }
      },
    );
    try {
      const summary = await invokeCmd<PrewarmSummary>(
        "suggest_examples_for_all_skills",
      );
      await refresh();
      setPrewarmStatus(null);
      await alertDialog(
        `Done.\n\n` +
          `  ✓ ${summary.succeeded} skills got new examples\n` +
          `  ✗ ${summary.failed} failed${
            summary.failed > 0
              ? `\n\nFailed: ${summary.results
                  .filter((r) => r.status === "err")
                  .map((r) => `${r.slug} (${r.error ?? "unknown"})`)
                  .join(", ")}`
              : ""
          }`,
        "Prewarm complete",
      );
    } catch (e) {
      setPrewarmStatus(null);
      await alertDialog(`Prewarm failed: ${e}`);
    } finally {
      unlisten();
      setPrewarming(false);
    }
  }

  return (
    <div className="skills-tab">
      <aside className="skills-tab__sidebar">
        <div className="sidebar__header">
          <span className="sidebar__title">Skills</span>
          <div className="sidebar__header-actions">
            <div className="skills-tab__add-wrap" ref={addMenuRef}>
              <button
                className="sidebar__toggle skills-tab__hire-btn"
                onClick={() => setAddMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                title="Hire a new agent — create one, import a folder, or browse a skill pack"
              >
                + Hire ▾
              </button>
              {addMenuOpen && (
                <div className="skills-tab__add-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="skills-tab__add-menu-item"
                    onClick={() => {
                      setAddMenuOpen(false);
                      // Hire-by-describe: ask one sentence, hand it to
                      // the builder ready-to-Run. This is the main "+ Hire"
                      // flow now — most users never need the other two.
                      void hireByDescribe();
                    }}
                  >
                    <span className="skills-tab__add-menu-icon">✨</span>
                    <span className="skills-tab__add-menu-label">
                      Hire by describing
                      <span className="skills-tab__add-menu-hint">
                        one sentence → orka-skill-builder drafts the SKILL.md
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="skills-tab__add-menu-item"
                    onClick={() => {
                      setAddMenuOpen(false);
                      void handleImport();
                    }}
                  >
                    <span className="skills-tab__add-menu-icon">📁</span>
                    <span className="skills-tab__add-menu-label">
                      Import folder
                      <span className="skills-tab__add-menu-hint">
                        copy a skill dir into ~/.claude/skills/
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="skills-tab__add-menu-item"
                    onClick={openSkillPacks}
                  >
                    <span className="skills-tab__add-menu-icon">📦</span>
                    <span className="skills-tab__add-menu-label">
                      Browse skill packs
                      <span className="skills-tab__add-menu-hint">
                        hire from a community source (gstack, etc.)
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button
              className="sidebar__toggle"
              onClick={() => {
                void refresh();
              }}
              title="Rescan ~/.claude/skills/"
            >
              ↻
            </button>
          </div>
        </div>
        <div className="skills-tab__search">
          <input
            className="skills-tab__search-input"
            placeholder="Filter skills…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {!loading && missingExamplesCount > 0 && !prewarming && (
          <button
            type="button"
            className="skills-tab__prewarm"
            onClick={() => void prewarmAll()}
            title={`Generate example prompts for ${missingExamplesCount} skills that don't have any yet`}
          >
            ✨ Prewarm examples for {missingExamplesCount} skill
            {missingExamplesCount === 1 ? "" : "s"}
          </button>
        )}
        {prewarming && prewarmStatus && (
          <div className="skills-tab__prewarm-status" role="status">
            <span className="skills-tab__prewarm-dot" aria-hidden>•</span>
            {prewarmStatus}
          </div>
        )}
        {loading && <div className="sidebar__status">loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="sidebar__status">
            {skills.length === 0
              ? "No skills found in ~/.claude/skills/"
              : "No matches"}
          </div>
        )}
        <div className="skills-tab__list">
          {filtered.map((s, idx) => {
            const tapBadge = extractTapPrefix(s.slug);
            const meta = isMetaSkill(s.slug);
            // Draw a divider AFTER the last meta-skill so the visual
            // grouping is obvious: built-in tools up top, user skills
            // below. Detected by comparing this row's meta-ness to
            // the next row's.
            const nextIsUser =
              idx < filtered.length - 1 && !isMetaSkill(filtered[idx + 1].slug);
            const needsDivider = meta && nextIsUser;
            return (
              <div
                key={s.slug}
                className={
                  "skills-tab__item" +
                  (s.slug === selectedSlug ? " skills-tab__item--active" : "") +
                  (meta ? " skills-tab__item--meta" : "") +
                  (needsDivider ? " skills-tab__item--divider" : "")
                }
                onClick={() => setSelectedSlug(s.slug)}
                title={s.description}
              >
                <span className="skills-tab__icon">
                  {meta ? "✨" : s.has_graph ? "◆" : "◇"}
                </span>
                <div className="skills-tab__info">
                  <div className="skills-tab__slug">
                    <span className="skills-tab__slug-text">{s.slug}</span>
                    {meta && (
                      <span className="skills-tab__meta-badge">built-in</span>
                    )}
                    {tapBadge && (
                      <span className="skills-tab__tap-badge">{tapBadge}</span>
                    )}
                    {s.has_graph && (
                      <span className="skills-tab__composite-tag">pipeline</span>
                    )}
                    {/* Activity badges: "last delivered" + "N runs".
                        Puts an employee-review vibe on the sidebar.
                        Skills that never ran get no badges (don't
                        clutter the row). */}
                    {lastDelivered.has(s.slug) && (
                      <span
                        className="skills-tab__last-run"
                        title={new Date(
                          lastDelivered.get(s.slug)!,
                        ).toLocaleString()}
                      >
                        · {fmtLastDelivered(lastDelivered.get(s.slug)!)}
                      </span>
                    )}
                    {runCounts.has(s.slug) && (
                      <span
                        className="skills-tab__run-count"
                        title={`${runCounts.get(s.slug)} total run(s)`}
                      >
                        · {runCounts.get(s.slug)}× run
                      </span>
                    )}
                  </div>
                  <div className="skills-tab__desc">{firstSentence(s.description)}</div>
                </div>
                {s.source === "orka" && !meta && (
                  <button
                    type="button"
                    className={
                      "skills-tab__expose" +
                      (s.exposed ? " skills-tab__expose--on" : "")
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleExposed(s);
                    }}
                    title={
                      s.exposed
                        ? `Exposed to claude CLI — click to hide (removes symlink at ~/.claude/skills/${s.slug})`
                        : `Orka-only. Click to expose to the claude CLI (creates symlink at ~/.claude/skills/${s.slug})`
                    }
                    aria-label={s.exposed ? "Unexpose skill" : "Expose skill"}
                  >
                    🔗
                  </button>
                )}
                {!meta && (
                <button
                  type="button"
                  className="skills-tab__delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(s);
                  }}
                  title={`Delete ${s.slug}`}
                  aria-label={`Delete ${s.slug}`}
                >
                  ×
                </button>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <section className="skills-tab__runner">
        {selected ? (
          <SkillRunner
            // Changing the key unmounts + remounts the runner; that's
            // how the hireSeed actually seeds freeText (SkillRunner
            // reads initialPrompt only on the first render). We mix
            // the seed into the key so the same orka-skill-builder
            // runner gets a fresh mount each time a new goal arrives.
            key={
              selected.slug +
              (selected.slug === "orka-skill-builder" && hireSeed
                ? `::hire::${hireSeed.length}`
                : "")
            }
            skill={selected}
            onOpenInCanvas={onOpenInCanvas}
            initialPrompt={
              selected.slug === "orka-skill-builder" ? hireSeed ?? undefined : undefined
            }
          />
        ) : (
          <div className="skills-tab__empty">
            <div className="skills-tab__empty-title">Pick a skill on the left</div>
            <div className="skills-tab__empty-hint">
              {skills.length === 0
                ? "Install one first: drop a SKILL.md into ~/.claude/skills/<slug>/"
                : `${skills.length} skill${skills.length === 1 ? "" : "s"} available — click to run.`}
            </div>
          </div>
        )}
      </section>

      {hireChatOpen !== null && (
        <Suspense fallback={null}>
          <HireChatModal
            initialGoal={hireChatOpen}
            onClose={() => setHireChatOpen(null)}
            onSaved={async (slug) => {
              setHireChatOpen(null);
              // Force a skill list refresh so the new slug shows up in
              // the sidebar immediately — the filesystem watcher would
              // catch it eventually, but we want zero-latency here.
              await refresh();
              setSelectedSlug(slug);
            }}
          />
        </Suspense>
      )}
      {showSkillPacks && (
        <Suspense fallback={null}>
          <SkillPacksModal onClose={() => setShowSkillPacks(false)} />
        </Suspense>
      )}
    </div>
  );
}
