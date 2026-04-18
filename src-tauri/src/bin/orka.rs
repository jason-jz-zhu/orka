use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

#[derive(Parser)]
#[command(name = "orka", about = "Orka CLI — run skills from the command line")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run a skill by name. Delegates to `claude -p "/<skill>"`.
    Run {
        /// Skill slug (e.g. "morning-briefing")
        skill: String,
        /// Input bindings: --inputs key=value --inputs key2=value2
        #[arg(long = "inputs", value_name = "KEY=VALUE")]
        inputs: Vec<String>,
        /// Emit JSONL output for machine consumption
        #[arg(long)]
        json: bool,
        /// Suppress stdout (only exit code matters)
        #[arg(long)]
        quiet: bool,
        /// Accept a changed SKILL.md hash and update the trust record. Use
        /// after you've reviewed the edits and confirm they're intentional.
        #[arg(long)]
        trust: bool,
    },
    /// List all discovered skills
    List,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::Run { skill, inputs, json, quiet, trust } => {
            run_skill(&skill, &inputs, json, quiet, trust);
        }
        Commands::List => {
            list_skills();
        }
    }
}

// ============================================================================
// SKILL.md trust (TOFU hash pinning)
//
// Threat: a teammate's git-sync or a compromised editor rewrites
// ~/.claude/skills/<slug>/SKILL.md to exfiltrate files on the next cron-
// scheduled run. Orka wouldn't know until the damage is done.
//
// Mitigation: on first run of a skill, snapshot its SHA-256 and persist to
// ~/OrkaCanvas/.trusted-skills.json. On subsequent runs, re-hash and refuse
// execution if it doesn't match — unless the user passes --trust to
// explicitly accept the change.
// ============================================================================

fn trust_store_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("OrkaCanvas").join(".trusted-skills.json"))
}

fn load_trust_store() -> HashMap<String, String> {
    let Some(path) = trust_store_path() else { return HashMap::new() };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_trust_store(store: &HashMap<String, String>) {
    let Some(path) = trust_store_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn hash_skill_md(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

/// Resolve a skill slug to its SKILL.md path.
fn resolve_skill_md(slug: &str) -> Option<PathBuf> {
    orka_lib::skill_md::list_skill_dirs()
        .into_iter()
        .find(|(s, _)| s == slug)
        .map(|(_, path)| PathBuf::from(path).join("SKILL.md"))
}

/// Check SKILL.md against the trust store. Returns Ok(()) to proceed,
/// Err(msg) to abort. On first run (TOFU), silently records the hash.
/// With `accept_change`, updates the stored hash to the current one.
fn check_skill_trust(slug: &str, accept_change: bool, quiet: bool) -> Result<(), String> {
    let md_path = match resolve_skill_md(slug) {
        Some(p) => p,
        None => return Err(format!("skill '{slug}' not found in ~/.claude/skills/")),
    };
    let current_hash = hash_skill_md(&md_path)
        .ok_or_else(|| format!("could not read {}", md_path.display()))?;
    let mut store = load_trust_store();
    match store.get(slug) {
        Some(known) if *known == current_hash => Ok(()),
        Some(_) if accept_change => {
            store.insert(slug.to_string(), current_hash);
            save_trust_store(&store);
            if !quiet {
                eprintln!("[orka] accepted new hash for skill '{slug}' and updated trust record");
            }
            Ok(())
        }
        Some(_) => Err(format!(
            "SKILL.md for '{slug}' has changed since the last trusted run.\n\
             Review the changes, then re-run with --trust to approve:\n\
             \n    orka run {slug} --trust\n\
             \nSee {}",
            md_path.display()
        )),
        None => {
            // TOFU: first time running this skill. Record its hash.
            store.insert(slug.to_string(), current_hash);
            save_trust_store(&store);
            if !quiet {
                eprintln!("[orka] trusting skill '{slug}' on first use (TOFU)");
            }
            Ok(())
        }
    }
}

fn run_skill(slug: &str, inputs: &[String], json: bool, quiet: bool, trust: bool) {
    if let Err(e) = check_skill_trust(slug, trust, quiet) {
        eprintln!("[orka] {e}");
        std::process::exit(2);
    }

    let mut prompt = format!("/{slug}");
    if !inputs.is_empty() {
        prompt.push_str("\n\n");
        for kv in inputs {
            prompt.push_str(kv);
            prompt.push('\n');
        }
    }

    if !quiet {
        eprintln!("[orka] running skill: {slug}");
    }

    let mut cmd = Command::new("claude");
    cmd.arg("-p").arg(&prompt);
    if json {
        cmd.arg("--output-format").arg("json");
    }

    let status = cmd.status();
    match status {
        Ok(s) => {
            let code = s.code().unwrap_or(1);
            if !quiet && code != 0 {
                eprintln!("[orka] skill {slug} exited with code {code}");
            }

            log_run(slug, inputs, code == 0);

            std::process::exit(code);
        }
        Err(e) => {
            eprintln!("[orka] failed to spawn claude: {e}");
            eprintln!("[orka] make sure `claude` CLI is installed and in PATH");
            log_run(slug, inputs, false);
            std::process::exit(127);
        }
    }
}

fn list_skills() {
    let skills = orka_lib::skill_md::list_skill_dirs();
    if skills.is_empty() {
        println!("No skills found in ~/.claude/skills/");
        return;
    }
    for (slug, path) in &skills {
        println!("{slug:<30} {path}");
    }
}

fn log_run(slug: &str, inputs: &[String], ok: bool) {
    let log_dir = dirs::home_dir()
        .map(|h| h.join("OrkaCanvas").join("runs"));
    let Some(log_dir) = log_dir else { return };
    let _ = std::fs::create_dir_all(&log_dir);

    let now = chrono::Local::now();
    let filename = now.format("%Y-%m").to_string() + ".jsonl";
    let log_path = log_dir.join(filename);

    let record = serde_json::json!({
        "id": format!("run-{}", now.timestamp_millis()),
        "skill": slug,
        "inputs": inputs,
        "started_at": now.to_rfc3339(),
        "status": if ok { "ok" } else { "error" },
        "trigger": "cli",
    });

    if let Ok(line) = serde_json::to_string(&record) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(f, "{line}");
        }
    }
}
