import { useEffect, useState } from "react";
import { useSkills, initSkillsWatcher, type SkillMeta } from "../lib/skills";
import { SkillRunner } from "./SkillRunner";
import { TrustedTapsSection } from "./TrustedTapsSection";

/** Known tap-id prefixes — these come from the trusted_taps backend and
 *  indicate the skill was installed via a tap (gstack, etc). Slugs of
 *  installed-tap skills follow `<tap-id>-<skill-name>`; the prefix is
 *  stripped into a badge so the list stays readable. */
const KNOWN_TAP_PREFIXES = ["gstack"];

function extractTapPrefix(slug: string): string | null {
  for (const p of KNOWN_TAP_PREFIXES) {
    if (slug.startsWith(`${p}-`)) return p;
  }
  return null;
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
  const [filter, setFilter] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  useEffect(() => {
    initSkillsWatcher();
  }, []);

  const normFilter = filter.trim().toLowerCase();
  const filtered = normFilter
    ? skills.filter(
        (s) =>
          s.slug.toLowerCase().includes(normFilter) ||
          s.description.toLowerCase().includes(normFilter),
      )
    : skills;

  const selected: SkillMeta | null =
    skills.find((s) => s.slug === selectedSlug) ?? null;

  return (
    <div className="skills-tab">
      <aside className="skills-tab__sidebar">
        <div className="sidebar__header">
          <span className="sidebar__title">Skills</span>
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
        <div className="skills-tab__search">
          <input
            className="skills-tab__search-input"
            placeholder="Filter skills…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {loading && <div className="sidebar__status">loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="sidebar__status">
            {skills.length === 0
              ? "No skills found in ~/.claude/skills/"
              : "No matches"}
          </div>
        )}
        <div className="skills-tab__list">
          {filtered.map((s) => {
            const tapBadge = extractTapPrefix(s.slug);
            return (
              <div
                key={s.slug}
                className={
                  "skills-tab__item" +
                  (s.slug === selectedSlug ? " skills-tab__item--active" : "")
                }
                onClick={() => setSelectedSlug(s.slug)}
                title={s.description}
              >
                <span className="skills-tab__icon">
                  {s.has_graph ? "◆" : "◇"}
                </span>
                <div className="skills-tab__info">
                  <div className="skills-tab__slug">
                    {s.slug}
                    {tapBadge && (
                      <span className="skills-tab__tap-badge">{tapBadge}</span>
                    )}
                    {s.has_graph && (
                      <span className="skills-tab__composite-tag">pipeline</span>
                    )}
                  </div>
                  <div className="skills-tab__desc">
                    {s.description.slice(0, 80)}
                    {s.description.length > 80 ? "…" : ""}
                  </div>
                </div>
                <span className="skills-tab__source">{s.source}</span>
              </div>
            );
          })}
        </div>
        <TrustedTapsSection />
      </aside>

      <section className="skills-tab__runner">
        {selected ? (
          <SkillRunner
            key={selected.slug}
            skill={selected}
            onOpenInCanvas={onOpenInCanvas}
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
    </div>
  );
}
