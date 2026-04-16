# Orka — Architecture

Technical decisions and their rationale. Audience: contributors and
developers working on the Orka codebase.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 (Rust + WKWebView) |
| Frontend | React 19 + xyflow (ReactFlow) + zustand |
| Backend | Rust (tokio, serde, notify, reqwest, comrak, sha2, clap) |
| LLM execution | `claude` CLI subprocess (inherits user's Max/Pro subscription) |
| Data format | SKILL.md (cross-vendor open standard) |
| Storage | Filesystem — no database, no cloud |

---

## Why CLI Subprocess, Not Agent SDK

Anthropic's Agent SDK requires a separate API key billed per-token.
Their policy explicitly prohibits third-party apps from using claude.ai
login credentials:

> "Unless previously approved, Anthropic does not allow third party
> developers to offer claude.ai login or rate limits for their products,
> including agents built on the Claude Agent SDK."

Orka's core value proposition is **zero marginal LLM cost** — the user
already pays $200/month for Claude Max. Spawning `claude` as a subprocess
is the only way to inherit that subscription.

**Trade-off**: The CLI's JSONL output format is not a stable API. Field
names can change between releases.

**Mitigation**: All Claude-format knowledge is isolated in `src/skill_md/`
with fixture-based regression tests. If Anthropic changes a field, exactly
one module needs updating and the tests catch it.

---

## Filesystem as Data Model

```
~/.claude/skills/               Cross-vendor skill directory (read + write)
  <name>/SKILL.md               Skill definition (Orka + Claude + Codex)

~/OrkaCanvas/                   Orka's own data directory
  <workspace>/
    templates/                  Legacy pipeline JSON (migrating to SKILL.md)
    graph.json                  Canvas state snapshot
    schedules/<name>.json       Per-pipeline schedule config
    runs/YYYY-MM.jsonl          Append-only run history
  .destinations.json            Destination profiles (0600 perms)
  .active                       Current workspace pointer

~/.claude/projects/             Claude Code session data (read-only)
  <project-key>/
    <session-id>.jsonl          Session transcript
```

No SQLite. No IndexedDB. No cloud sync. Every file is human-readable
and git-trackable. Sensitive files (`.destinations.json`) use 0600
permissions via `std::os::unix::fs::PermissionsExt`.

---

## Module Map (Rust Backend)

```
src-tauri/src/
  lib.rs              Tauri command registry (50+ commands)
  main.rs             Entry point, delegates to lib::run()
  
  skill_md/           SKILL.md parser + writer + hash
    mod.rs            Public types, list_skill_dirs()
    parse.rs          Frontmatter + graph block parser, proseHash
    write.rs          Write-back (replace graph block, preserve prose)
  
  skills.rs           Skill scanner + FS watcher for ~/.claude/skills/
  run_log.rs          Append-only JSONL run history
  
  node_runner.rs      Spawns `claude` CLI, streams JSONL events
  sessions.rs         Reads ~/.claude/projects/ session data
  graph.rs            Canvas state persistence
  workspace.rs        Workspace directory management
  schedules.rs        Per-pipeline scheduling (interval/daily/weekly/once)
  
  destinations.rs     Output routing (iCloud, Apple Notes, webhook, shell)
  dest_profiles.rs    Named destination profiles (WeChat Work, etc.)
  
  pipeline_gen.rs     Claude-powered pipeline generation from description
  kb.rs               Knowledge base ingestion
  onboarding.rs       First-run setup
  
  bin/
    orka.rs           CLI binary: `orka-cli run <skill>`, `orka-cli list`
```

---

## Module Map (Frontend)

```
src/
  App.tsx             Root: three tabs (Live, Studio, Runs)
  
  nodes/
    ChatNode.tsx      Inline prompt, chat mode
    AgentNode.tsx     Inline prompt, agent mode (tools enabled)
    SkillRefNode.tsx  References an external SKILL.md by slug
    PipelineRefNode.tsx  Legacy alias for SkillRefNode
    KnowledgeBaseNode.tsx  Directory/file context
    OutputNode.tsx    Destination routing (local/iCloud/Notes/webhook/shell)
    SessionNode.tsx   Import live session as context
  
  components/
    SkillPalette.tsx       Sidebar: discovered skills with search
    PipelineLibrary.tsx    Sidebar: saved pipeline templates
    RunsDashboard.tsx      Runs tab: execution history table
    SessionDashboard.tsx   Live tab: active Claude Code sessions
    SkillExportModal.tsx   3-scope export (global/project/bundle)
    ScheduleModal.tsx      Schedule configuration
    SettingsModal.tsx      Workspace + preferences
    GeneratePipelineModal.tsx  AI pipeline generation
    StatusBar.tsx          Bottom status bar
  
  lib/
    skills.ts         Zustand slice for discovered skills
    runs.ts           Zustand slice for run history
    graph-store.ts    Zustand store for canvas state (nodes, edges, meta)
    run-all.ts        Topological DAG execution engine
    context.ts        Upstream context builder for node prompts
    stream-parser.ts  Claude JSONL stream parser (display-only)
    tauri.ts          IPC wrapper (invokeCmd, listenEvent)
    schedules.ts      Schedule helpers + OS notifications
    destinations.ts   Destination profile IPC wrappers
    sound.ts          Web Audio ready-ping
    persistence.ts    Auto-save canvas to disk
    dialogs.ts        Alert/confirm/prompt dialog wrappers
```

---

## Mac-native I/O Surface

Destinations that SaaS competitors cannot reach:

| Destination | Implementation | File |
|------------|---------------|------|
| Apple Notes | `osascript -l JavaScript` (JXA) | `destinations.rs` |
| iCloud Drive | Direct write to `~/Library/Mobile Documents/com~apple~CloudDocs/Orka/` | `destinations.rs` |
| Shortcuts | `shortcuts run <name>` shell-out | Planned |
| Shell command | `$CONTENT` placeholder substitution | `destinations.rs` |
| HTTP webhook | `reqwest` POST with custom headers | `destinations.rs` |
| Local file | `tokio::fs::write` to any path | `destinations.rs` |
| Destination profile | Named config (WeChat Work, etc.) | `dest_profiles.rs` |

---

## Execution Model

### Canvas execution (Run All)

1. `run-all.ts` computes topological levels via Kahn's algorithm
2. Within each level, nodes execute in parallel (`Promise.all`)
3. Each node spawns a `claude` subprocess via Tauri command
4. JSONL stream events flow back via Tauri event channel
5. Output nodes run serially after their upstream completes
6. `skill_ref` nodes compose `/<skill-slug>\n\n<bindings>` and delegate to `claude`

### CLI execution (orka-cli run)

1. Resolves skill slug to `~/.claude/skills/<slug>/SKILL.md`
2. Delegates to `claude -p "/<slug>"` — Claude reads the prose and executes
3. Logs result to `~/OrkaCanvas/runs/YYYY-MM.jsonl`
4. Exits with claude's exit code

CLI execution intentionally delegates to Claude's own skill router.
Orka does not reimplement topo-sort in the CLI for v0.2 — Claude
interprets the prose steps naturally.

### Scheduled execution

1. Frontend polls schedules every 30 seconds
2. When `next_run_at` is past, triggers Run All for that pipeline
3. macOS notification on completion
4. Run logged to history

---

## Testing Strategy

### Rust

- **Fixture-based**: `skill_md/parse.rs` tests replay captured SKILL.md content
- **Unit tests**: `skills.rs` (scanner), `run_log.rs` (record roundtrip)
- **Integration**: `sessions.rs` tests read real `~/.claude/projects/` on dev machines
- **All tests run**: `cd src-tauri && cargo test` (currently 65 tests)

### Frontend

- **Type safety**: `npx tsc --noEmit` on every change (zero errors required)
- **No unit test framework** in v0.2 — type checking + manual testing
- **Future**: Playwright for UI smoke tests (v0.3)

### Harness rule

Every code change must pass both `cargo test` (all green) and
`npx tsc --noEmit` (exit 0) before moving to the next task.
