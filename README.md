# Orka

A macOS desktop app that wraps the local [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) CLI.

**Monitor** every Claude session running on your machine at a glance — which ones are generating, which ones are waiting for your input, which ones are done. **Build pipelines** on a node canvas by chaining chat / agent / knowledge-base nodes.

> Built on [Tauri 2](https://tauri.app/), React 19, and Rust. No servers, no data leaves your machine — Orka only reads `~/.claude/projects/` and shells out to the `claude` binary you already have.

---

## Two Views

### Monitor — one card per active Claude session

Watch every interactive `claude` session across all your projects. Cards flip from red "generating" to green "for review" the moment Claude finishes a turn, so you know when to come back. Click **Review** to jump to the terminal tab (Terminal.app / iTerm2 / VSCode / Cursor) running that session.

### Pipeline — compose Claude runs on a canvas

Drop Chat, Agent, and Knowledge-Base nodes, wire upstream outputs into downstream prompts, press **Run All**. Save any graph as a named pipeline you can reload later. All persisted under `~/OrkaCanvas/<project>/`.

---

## Prerequisites

Orka doesn't replace `claude` — it orchestrates the one you've already installed. Before opening the app:

1. **Install Claude Code**
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
   Full install guide: <https://docs.claude.com/en/docs/claude-code/quickstart>

2. **Log in once** in any terminal
   ```bash
   claude
   ```
   This creates `~/.claude/.credentials.json`, which Orka detects to confirm you're set up.

The built-in **onboarding check** on first launch verifies both of the above plus workspace directory access.

---

## Install

Download the latest `.dmg` from [Releases](../../releases), drag `Orka.app` to `/Applications`.

**First launch** — because the build is currently unsigned, macOS Gatekeeper will refuse to open it. Workarounds:

- **Right-click** the app → **Open** → **Open** again in the dialog. (You only need to do this once.)
- Or, if that fails:
  ```bash
  xattr -cr /Applications/Orka.app
  ```

The build is currently **Apple Silicon only**. Intel Mac support coming later.

---

## Develop

```bash
git clone https://github.com/jason-jz-zhu/orka.git
cd orka
npm install
npm run tauri dev
```

Requirements: Node 18+, Rust (stable), Xcode command-line tools.

### Build a local release

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/dmg/Orka_<version>_<arch>.dmg`.

---

## Architecture at a glance

```
~/.claude/projects/       ← Claude Code writes session transcripts here
~/.claude/sessions/       ← PID → sessionId map (read-only)
      │
      ▼
┌─────────────────────────────────────────────────┐
│  Rust (Tauri backend)                           │
│  • sessions.rs   — fs watcher + status detect   │
│  • node_runner.rs — spawns `claude -p` subproc  │
│  • workspace.rs  — per-project filesystem       │
└─────────────────────────────────────────────────┘
      │  Tauri IPC  +  events (session:changed …)
      ▼
┌─────────────────────────────────────────────────┐
│  React (frontend)                               │
│  • SessionDashboard  — Monitor tab grid         │
│  • ReactFlow canvas  — Pipeline tab             │
│  • zustand graph store + per-file mtime cache   │
└─────────────────────────────────────────────────┘
      │
      ▼
~/OrkaCanvas/<project>/
      ├── graph.json            ← current canvas
      ├── nodes/<id>/           ← node working dirs
      └── templates/<name>.json ← saved pipelines
```

Key ideas:
- **Session state is authoritative from `~/.claude/sessions/<PID>.json`**. Orka matches these to `.jsonl` transcripts to know which sessions are truly live, without mtime guessing.
- **A session is "FOR REVIEW"** when the last JSONL line is an `assistant` message whose last block is `text` — i.e. Claude finished its turn and is waiting for you.
- **Templates are per-project** (stored under each project's `templates/` dir). Switching project isolates pipelines and KB.

---

## Status

This is early beta. Expect rough edges:

- macOS only (for now)
- Unsigned build (Gatekeeper workaround required)
- `Review → jump to terminal` precision: tab-exact for Terminal.app / iTerm2, window-exact for VSCode / Cursor, app-level for others
- No auto-updater yet

See the [Releases](../../releases) page for the latest binary.

---

## License

MIT — see [LICENSE](LICENSE).
