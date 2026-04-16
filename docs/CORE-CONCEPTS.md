# Orka — Core Concepts

> A macOS app that lets you browse, visualize, edit, schedule, and run
> Claude Code skills, with full run history.
>
> Skills are created in Claude Code via conversational meta-skills.
> Orka is the management + execution + observability layer, not a creation tool.

---

## 1. The One Insight

**A pipeline is a composite skill.**

There is no separate "pipeline format." A single-step automation is an
atomic skill. A multi-step automation is a composite skill that references
other skills. Orka's canvas is a visual editor for composite skills — not
a pipeline builder.

```
Atomic skill       = one prompt, one SKILL.md, no graph block
Composite skill    = N prompts wired as a DAG, one SKILL.md, with graph block
Pipeline           = a composite skill you scheduled
```

One format. One file. Three names for the same thing at different zoom levels.

---

## 2. SKILL.md: One File, Three Runtimes

Every skill is a directory containing a `SKILL.md` file:

```
morning-briefing/
└── SKILL.md
```

That single file is executable by three runtimes simultaneously:

| Runtime | What it reads | How it runs |
|---------|--------------|-------------|
| **Claude Code** | The prose body ("## Steps") | LLM follows the numbered instructions |
| **Orka canvas** | The `<!-- orka:graph v1 -->` comment block | Visual DAG with per-node streaming |
| **`orka-cli run`** | The comment block (headless) | CLI delegates to `claude -p "/skill-name"` |

The prose and the graph encode the **same DAG**. Claude reads the words;
Orka reads the structure. Both execute the same workflow.

```markdown
---
name: morning-briefing
description: Daily briefing from calendar and inbox.
orka:
  schema: 1
  inputs:
    - { name: focus, default: "deep work" }
---

# Morning Briefing

## Steps

1. **Calendar** — call the `calendar-today` skill
2. **Inbox** — call the `inbox-triage` skill
3. **Compose** — combine into a briefing
4. **Save** — append to Apple Notes

<!-- orka:graph v1
{ "nodes": [...], "edges": [...], "stepMap": {...}, "proseHash": "" }
-->
```

The graph block is an HTML comment — invisible when rendered in GitHub,
Obsidian, or Apple Notes. Claude sees it as metadata and skips it.
Orka parses it to reconstruct the canvas.

For the full format specification, see [SKILL-FORMAT.md](./SKILL-FORMAT.md).

---

## 3. Skill Hierarchy

Skills compose recursively:

```
Layer 0 — Atomic skills
  summarize-folder      (one prompt)
  github-new-issues     (one prompt)
  fetch-rss             (one prompt)

Layer 1 — Composite skills
  daily-digest          (chains: scan → summarize → save)
  competitor-brief      (chains: github + producthunt → compose → webhook)

Layer 2 — Meta-composites
  weekly-report         (chains: daily-digest x 5 + code-review → compile)
```

Each layer is a standard SKILL.md. A composite references its children
via `skill_ref` nodes. Resolution order:

1. Sibling directory (self-contained bundle)
2. Workspace-local (`<project>/.claude/skills/`)
3. User-global (`~/.claude/skills/`)

---

## 4. The Flywheel

```
 User chats with AI (Claude Code, anywhere)
            |
            v
 Meta-skill decomposes the conversation
  |-- checks existing skill library for reuse
  |-- generates missing atomic skills
  '-- assembles a composite SKILL.md
            |
            v
 Saved to ~/.claude/skills/<name>/
            |
            v
 Orka Scanner auto-discovers it
            |
            v
 User drags to canvas -> edits -> sets Schedule
            |
            v
 Runs on schedule (or via `orka-cli run`)
            |
            v
 Run history + observability in Runs tab
            |
            v
 User refines skill -> saves back -> cycle repeats
```

The skill library grows with every conversation. The more skills you have,
the faster new composites are created — the meta-skill reuses existing
atoms instead of generating from scratch.

### A real example

Monday morning. You open Claude Code and say:

> "Every day, summarize the markdown files in ~/Documents/notes that changed
> in the last 24 hours, then append the summary to Apple Notes."

Claude finds the `orka-skill-builder` meta-skill. It asks:
"Should the Notes title be configurable?" You say yes.

The meta-skill generates:

```
~/.claude/skills/daily-digest/
├── SKILL.md        (composite: scan → summarize → save, with orka:graph)
```

You open Orka. `daily-digest` is already in the Skills palette — the
scanner found it. You drag it to the canvas. Three nodes appear, already
wired. You click Schedule, set "daily at 7:00 AM", and close the app.

Tuesday 7:01 AM. Your Mac wakes briefly. Claude runs the skill. Apple
Notes has a new entry: "Daily Digest — April 16." The Runs tab in Orka
shows: 43s, 12k tokens, status: ok, trigger: scheduled.

You did nothing. The skill did its job.

Wednesday, you realize you also want the digest posted to your team's
WeChat group. You open the canvas, drag in a webhook output node, connect
it, save. The SKILL.md updates — both the graph block and the prose stay
in sync. Thursday morning, the digest lands in Apple Notes and WeChat.

Your skill library now has one more atom. Next time you build something
that needs "summarize recent files," it's already there.

---

## 5. The Meta-skill: orka-skill-builder

A standard SKILL.md installed at `~/.claude/skills/orka-skill-builder/`.
Orka installs it automatically on first launch.

When a user says "create a skill" or "automate this" in Claude Code,
Claude's skill router finds it by description match and invokes it.

The meta-skill handles both modes automatically:

- **Simple request** (one step) → generates one atomic SKILL.md
- **Complex request** (multi-step) → decomposes into atomic skills +
  wires them into a composite with `orka:graph` block

It also checks `ls ~/.claude/skills/` before creating anything —
if a matching skill already exists, it reuses it via `skill_ref`.

This is Orka's Day 1 onboarding: install the app → meta-skill appears →
user chats with Claude → skills materialize → Orka visualizes them.

---

## 6. What You See

Orka has three tabs:

**Live** — monitors all active Claude Code sessions on your Mac. Shows
which sessions are generating, which are waiting for your input. You can
reply, continue, or mark sessions as reviewed.

**Studio** — the visual canvas. The left sidebar has two panels stacked
vertically:
- **Pipelines** — your saved pipeline templates (legacy JSON, migrating to SKILL.md)
- **Skills** — every skill discovered in `~/.claude/skills/`, with a search
  filter. Click a skill to drop a purple `skill_ref` node onto the canvas.

The canvas itself is a DAG editor. Nodes (chat, agent, skill_ref, kb, output)
are connected with edges. Hit "Run All" to execute the graph top-to-bottom.
Each node streams its output in real time.

**Runs** — a table of every past execution (manual, scheduled, or CLI).
Shows skill name, timestamp, status, trigger source, and duration.

---

## 7. Division of Labor

Three actors, each doing what they're best at:

| Actor | Role | Does NOT do |
|-------|------|-------------|
| **Human** | Says what they want | Write SKILL.md format by hand |
| **AI (Claude)** | Decomposes, generates, executes skills | Schedule, observe, reach Mac apps |
| **Orka** | Schedules, visualizes, monitors, routes output | Generate skills (that's Claude's job) |

Orka is the control plane. Claude is the execution engine.
The human is the intent source.

---

## 8. What Orka Is

- **A skill management layer.** The canvas visualizes skills created in
  Claude Code conversations. It's an editor, not a blank sheet.

- **A local-first app.** Runs on your Mac. Data lives on your disk.
  No account beyond your existing Claude subscription.

- **A Mac-native output router.** Can reach Apple Notes, iCloud Drive,
  Shortcuts, shell commands, HTTP webhooks, and local files — destinations
  that cloud-based tools cannot touch.

- **A scheduler and observer.** Set a skill to run daily, weekly, or on
  an interval. Review every run in the Runs tab.

- **A CLI tool.** `orka-cli run <skill>` executes any skill headlessly,
  suitable for cron, launchd, git hooks, or Raycast triggers.

---

## 9. Glossary

| Term | Definition |
|------|-----------|
| **Atomic skill** | A single-step SKILL.md with no graph block |
| **Composite skill** | A multi-step SKILL.md with an `orka:graph` comment block |
| **Pipeline** | A composite skill, especially one that's scheduled |
| **Meta-skill** | A skill that creates other skills (e.g., `orka-skill-builder`) |
| **Graph block** | The `<!-- orka:graph v1 {...} -->` HTML comment in SKILL.md |
| **Prose body** | The human-readable steps section Claude executes |
| **Scanner** | Orka's FS watcher that discovers skills in `~/.claude/skills/` |
| **Skill Palette** | The sidebar in Orka's Studio tab listing discovered skills |
| **Run log** | Append-only JSONL recording each skill execution |
| **Drift** | When prose body and graph block are out of sync (edited externally) |
| **proseHash** | SHA-256 of the prose body, stored in the graph block for drift detection |
