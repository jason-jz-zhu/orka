# Orka

**Browse, visualize, schedule, and run AI skills — from a Mac app.**

Author skills anywhere — Claude Code, ChatGPT, Cursor, or by hand. Orka is the management, execution, and observability layer that turns them into scheduled, monitored automations with native Mac output.

> Built on [Tauri 2](https://tauri.app/), React 19, and Rust. No servers, no cloud. SKILL.md is a cross-vendor open standard — works with Claude, OpenAI Codex, and any LLM that reads markdown.

---

## The Idea

A **pipeline is a composite skill**. An atomic skill is one prompt. A composite skill chains multiple skills into a DAG. Orka's canvas is a visual editor for these composites — not a pipeline builder.

```
Atomic skill     = one prompt, one SKILL.md
Composite skill  = multiple skills wired as a DAG, one SKILL.md with a graph block
Pipeline         = a composite skill on a schedule
```

One file format. Three runtimes:

| Runtime | Reads | Runs |
|---------|-------|------|
| Claude Code | Prose body | LLM follows the steps |
| Orka canvas | `<!-- orka:graph -->` block | Visual DAG with per-node streaming |
| `orka-cli run` | Graph block (headless) | Delegates to `claude -p` |

---

## Three Tabs

### Live — monitor active Claude sessions

See every `claude` session across all projects. Cards show generating / waiting-for-review status in real time. Click to jump to the terminal running that session.

### Studio — compose skills on a canvas

The left sidebar has two panels:
- **Pipelines** — saved pipeline templates
- **Skills** — every skill in `~/.claude/skills/`, searchable. Click to drop a skill node onto the canvas.

The canvas is a DAG editor with node types: **Agent** (prompt + tools), **Input** (folder / URL / clipboard / text), **Skill** (references an external SKILL.md), and **Output** (file / iCloud / Apple Notes / webhook / shell). Hit **Run All** to execute top-to-bottom.

### Runs — execution history

Every run (manual, scheduled, or CLI) is logged. Table shows skill name, timestamp, status, trigger source, and duration.

---

## The Flywheel

```
Chat with any AI (Claude Code, ChatGPT, Cursor, ...)
  → author a skill from the conversation
  → save as SKILL.md (or let orka-skill-builder generate it)
  → Orka scanner auto-discovers it
  → drag to canvas → set schedule → runs automatically
  → refine → save back → repeat
```

Orka ships with `orka-skill-builder` — a meta-skill that creates other skills. Say "automate this" in any AI conversation, save the result as a SKILL.md, and Orka picks it up. Your skill library grows with every conversation.

---

## Output Destinations

Orka routes output to places cloud tools cannot reach:

- **Apple Notes** — JXA append
- **iCloud Drive** — direct file write
- **Local files** — anywhere on disk
- **HTTP webhooks** — WeChat Work, Slack, Notion, any URL
- **Shell commands** — `$CONTENT` substitution
- **Destination profiles** — named configs with saved credentials

---

## CLI

```bash
orka-cli list                              # show all discovered skills
orka-cli run morning-briefing              # run a skill headlessly
orka-cli run my-skill --inputs key=value   # with input bindings
```

Suitable for cron, launchd, git hooks, or Raycast triggers.

---

## Prerequisites

Orka wraps the Claude CLI you already have:

1. **Install Claude Code**
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. **Log in once**
   ```bash
   claude
   ```

The built-in onboarding check on first launch verifies both.

---

## Install

Download the latest `.dmg` from [Releases](../../releases), drag to `/Applications`.

**First launch** (unsigned build):
- Right-click → Open → Open again. One-time only.
- Or: `xattr -cr /Applications/Orka.app`

Apple Silicon only for now.

---

## Develop

```bash
git clone https://github.com/jason-jz-zhu/orka.git
cd orka
npm install
npm run tauri dev
```

Requirements: Node 20+, Rust (stable), Xcode command-line tools.

```bash
npm run tauri build    # → src-tauri/target/release/bundle/dmg/
```

---

## Architecture

```
~/.claude/skills/         Skills directory (SKILL.md files)
~/.claude/projects/       Claude Code session transcripts (read-only)
        |
        v
  Rust (Tauri backend)
  - skill_md/        SKILL.md parser + writer + hash
  - skills.rs        Skill scanner + FS watcher
  - node_runner.rs   Spawns `claude -p` subprocess
  - sessions.rs      Session discovery + status detection
  - run_log.rs       Append-only JSONL run history
  - destinations.rs  Apple Notes / iCloud / webhook / shell
        |
        v
  React (frontend)
  - SkillPalette     Discovered skills sidebar
  - SkillRefNode     Canvas node referencing a SKILL.md
  - RunsDashboard    Execution history table
  - ReactFlow        DAG canvas editor
  - zustand          State management
        |
        v
~/OrkaCanvas/<workspace>/
  - graph.json         Current canvas state
  - runs/YYYY-MM.jsonl Run history
  - .destinations.json Credential profiles (0600)
```

Key decisions:
- **CLI subprocess, not Agent SDK** — SDK requires per-token API key billing. CLI inherits the user's Max/Pro subscription = zero marginal cost per run.
- **Filesystem as data model** — skills, runs, configs are all files. No database. Everything git-trackable.
- **Mac-only is a feature** — JXA, Apple Notes, iCloud, Shortcuts are structural advantages over cloud-based tools.

---

## Docs

- [Core Concepts](docs/CORE-CONCEPTS.md) — product philosophy and design principles
- [Skill Format](docs/SKILL-FORMAT.md) — SKILL.md specification (v1)
- [Architecture](docs/ARCHITECTURE.md) — technical decisions and module map
- [Strategy](docs/STRATEGY.md) — competitive positioning and business model

---

## Status

Early beta. Expect rough edges:

- macOS only
- Unsigned build (Gatekeeper workaround required)
- No auto-updater yet
- `orka-cli` ships as a separate binary alongside the app

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
