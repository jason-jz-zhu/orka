//! First-run seeding of demo skills. Without this, brand new users
//! open the Skills tab and see an empty list with no onboarding path
//! — they have to write a SKILL.md from scratch or clone an external
//! tap before the app does anything. Seeding two minimal, safe demos
//! gives them something to click immediately:
//!
//!   - `repo-tldr`         → atomic skill, one prompt, one output
//!   - `repo-health-check` → composite pipeline, 3-node DAG, shows
//!                           skill composition (calls `repo-tldr`
//!                           as a sub-node) and parallel execution
//!
//! Two demos is deliberate — one showcases the simplest case, the
//! other showcases what Orka is actually for (pipelines).
//!
//! Runs at most once per seed version — gated by a marker file at
//! `~/.orka/.seeded-vN`. Version bumps force a re-seed for existing
//! users so they pick up newly-added demos without blowing away any
//! non-seeded content they authored themselves.

use std::path::PathBuf;

struct Demo {
    slug: &'static str,
    skill_md: &'static str,
}

const DEMOS: &[Demo] = &[
    Demo {
        slug: "repo-tldr",
        skill_md: include_str!("../../docs/examples/repo-tldr/SKILL.md"),
    },
    Demo {
        slug: "repo-health-check",
        skill_md: include_str!(
            "../../docs/examples/repo-health-check/SKILL.md"
        ),
    },
    // Foundational: without this skill, brand-new users have no path
    // to author their own skills — they'd have to hand-write SKILL.md.
    // The canonical copy lives in the repo at skills/orka-skill-builder/
    // but the repo tree isn't part of an installed .app bundle, so we
    // bake the bytes into the binary via include_str!.
    Demo {
        slug: "orka-skill-builder",
        skill_md: include_str!("../../skills/orka-skill-builder/SKILL.md"),
    },
];

/// Bump when DEMOS changes content or gains entries. Existing users
/// who saw the old marker file get re-seeded for any missing demos
/// (without touching demos they've already edited — see `seed_one`).
const SEED_VERSION: &str = "v3";

fn orka_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".orka"))
}

fn seed_marker() -> Option<PathBuf> {
    orka_dir().map(|d| d.join(format!(".seeded-{SEED_VERSION}")))
}

fn legacy_markers() -> Vec<PathBuf> {
    // Older versions used `.seeded-v1` (repo-tldr only) and `.seeded-v2`
    // (added repo-health-check). v3 adds orka-skill-builder. If we find
    // ANY prior marker, backfill missing demos; the per-slug existence
    // check in `seed_one` keeps us from stomping user edits.
    orka_dir()
        .map(|d| vec![d.join(".seeded-v1"), d.join(".seeded-v2")])
        .unwrap_or_default()
}

/// Seed a single demo. Returns true when a new file was written,
/// false when skipped (either the slug already has a directory, or
/// the write itself failed — logged but non-fatal since seeding is
/// best-effort).
fn seed_one(skills_root: &PathBuf, demo: &Demo) -> bool {
    let target_dir = skills_root.join(demo.slug);
    // Skip if the slug exists — user may have edited or replaced
    // the demo, and we don't want to stomp their changes.
    if target_dir.exists() {
        return false;
    }
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        eprintln!("[seed_skills] mkdir {}: {e}", target_dir.display());
        return false;
    }
    let skill_md = target_dir.join("SKILL.md");
    if let Err(e) = std::fs::write(&skill_md, demo.skill_md) {
        eprintln!("[seed_skills] write {}: {e}", skill_md.display());
        return false;
    }
    true
}

/// Install demo skills if the user has none, or fill in missing demos
/// after a SEED_VERSION bump. Idempotent — safe to call every startup.
///
/// Returns Ok(true) when at least one new demo was seeded, Ok(false)
/// when skipped (already seeded and no new demos to add).
pub fn maybe_seed_demo_skill() -> Result<bool, String> {
    let Some(marker) = seed_marker() else {
        return Ok(false);
    };
    let Some(skills_root) = orka_dir().map(|d| d.join("skills")) else {
        return Ok(false);
    };

    // If the CURRENT version's marker exists, nothing to do.
    if marker.exists() {
        return Ok(false);
    }

    let root_existed_before = skills_root.exists();
    // Ensure the parent so writes below succeed on brand-new installs.
    std::fs::create_dir_all(&skills_root)
        .map_err(|e| format!("mkdir {}: {e}", skills_root.display()))?;

    // If a legacy marker exists, we trust that the user has been
    // using the app — don't flood with every demo slug, just fill
    // in the ones that aren't present yet (handled by seed_one's
    // exists-check below). Same semantics apply for fresh installs
    // since their skills/ is empty.
    let _had_legacy = legacy_markers().iter().any(|p| p.exists());

    // Bail early if the user already has a populated skills/ but we
    // don't have ANY prior marker at all — means they set up skills
    // via a non-Orka path (clone, tap, manual). Don't presume to add
    // to their setup. Record the current marker so we stop checking.
    if root_existed_before && !_had_legacy {
        let has_entries = std::fs::read_dir(&skills_root)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false);
        if has_entries {
            std::fs::create_dir_all(marker.parent().unwrap_or(&PathBuf::new()))
                .ok();
            let _ = std::fs::write(&marker, "existing-skills");
            return Ok(false);
        }
    }

    let mut any_seeded = false;
    for demo in DEMOS {
        if seed_one(&skills_root, demo) {
            any_seeded = true;
        }
    }

    // Always mark the current version even if 0 demos were added —
    // prevents re-checking on every launch.
    std::fs::create_dir_all(marker.parent().unwrap_or(&PathBuf::new()))
        .ok();
    let _ = std::fs::write(&marker, if any_seeded { "seeded" } else { "no-op" });

    Ok(any_seeded)
}

#[tauri::command]
pub fn seed_demo_skill_if_first_run() -> Result<bool, String> {
    maybe_seed_demo_skill()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_bundled_tldr_parses() {
        // If this fixture ever breaks parsing, seeding ships a broken
        // skill to every new user. Runs the real parser against the
        // exact bytes we'd write.
        let parsed = crate::skill_md::parse_skill_md_str(DEMOS[0].skill_md)
            .expect("bundled repo-tldr SKILL.md must parse");
        assert_eq!(parsed.name, "repo-tldr");
        assert!(
            parsed.raw_body.len() > 200,
            "bundled demo skill looks too short: {} bytes",
            parsed.raw_body.len()
        );
    }

    #[test]
    fn harness_bundled_health_check_parses() {
        let parsed = crate::skill_md::parse_skill_md_str(DEMOS[1].skill_md)
            .expect("bundled repo-health-check SKILL.md must parse");
        assert_eq!(parsed.name, "repo-health-check");
        assert!(
            parsed.raw_body.len() > 500,
            "composite demo body looks too short: {} bytes",
            parsed.raw_body.len()
        );
    }

    #[test]
    fn harness_bundled_skill_builder_parses() {
        // Regression: v3 shipped without orka-skill-builder bundled, so
        // fresh installs had no path to author new skills. This locks
        // the foundational skill into the seed list.
        let entry = DEMOS
            .iter()
            .find(|d| d.slug == "orka-skill-builder")
            .expect("DEMOS must include orka-skill-builder");
        let parsed = crate::skill_md::parse_skill_md_str(entry.skill_md)
            .expect("bundled orka-skill-builder SKILL.md must parse");
        assert_eq!(parsed.name, "orka-skill-builder");
        // The skill is long-form guidance (~250 lines of prose); a
        // truncated version would silently ship a broken onboarding.
        assert!(
            parsed.raw_body.len() > 2000,
            "bundled orka-skill-builder body looks too short: {} bytes",
            parsed.raw_body.len()
        );
    }

    #[test]
    fn harness_health_check_has_composite_graph() {
        // Critical contract: the demo pipeline must actually be a
        // DAG, not just prose. A broken graph block would fall back
        // to "atomic skill" and hide the composite-pipeline value
        // prop the demo exists to showcase.
        let parsed = crate::skill_md::parse_skill_md_str(DEMOS[1].skill_md)
            .expect("parse");
        let graph = parsed
            .graph
            .expect("repo-health-check must have an orka:graph block");
        assert_eq!(
            graph.nodes.len(),
            3,
            "expected 3 nodes in demo DAG, got {}",
            graph.nodes.len()
        );
        assert_eq!(
            graph.edges.len(),
            2,
            "expected 2 edges in demo DAG (n1→n3, n2→n3), got {}",
            graph.edges.len()
        );
        // One skill_ref (reuses repo-tldr), two agents.
        let skill_refs = graph
            .nodes
            .iter()
            .filter(|n| n.node_type == "skill_ref")
            .count();
        let agents = graph
            .nodes
            .iter()
            .filter(|n| n.node_type == "agent")
            .count();
        assert_eq!(skill_refs, 1, "demo should call repo-tldr via skill_ref");
        assert_eq!(agents, 2, "demo should have 2 agent nodes");
    }

    #[test]
    fn harness_expected_demos_registered() {
        // Guard against a refactor accidentally dropping or reordering
        // a demo. Adding a new demo requires updating this list AND
        // bumping SEED_VERSION so existing users get it backfilled.
        let slugs: Vec<&str> = DEMOS.iter().map(|d| d.slug).collect();
        assert_eq!(
            slugs,
            vec!["repo-tldr", "repo-health-check", "orka-skill-builder"],
        );
    }
}
