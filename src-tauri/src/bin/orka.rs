use clap::{Parser, Subcommand};
use std::process::Command;

use orka_lib::skill_trust::{cli_check_and_record, CliTrustOutcome};

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

// SKILL.md trust (TOFU hash pinning) lives in orka_lib::skill_trust so
// the Tauri app and this CLI share one source of truth for the trust
// store shape + semantics. See that module's docs for the threat model.

fn run_skill(slug: &str, inputs: &[String], json: bool, quiet: bool, trust: bool) {
    match cli_check_and_record(slug, trust, quiet) {
        CliTrustOutcome::Proceed => {}
        CliTrustOutcome::Refuse(msg) => {
            eprintln!("[orka] {msg}");
            std::process::exit(2);
        }
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
