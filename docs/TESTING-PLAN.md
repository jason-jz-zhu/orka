# Orka Testing Plan

This document freezes scope for end-to-end functional + performance
testing. Every test we add should map to one of the three lists below.

## Critical user journeys (functional)

| # | Journey | Entry | Success signal |
|---|---------|-------|----------------|
| 1 | Dashboard renders session list | cold app start | N cards visible in <2s; state badges correct |
| 2 | Open live session → continue in terminal | click "Open" on a `live` card | real `claude --resume` terminal opens |
| 3 | Brief me → recap path | click card; JSONL has `※ recap:` | brief shows instantly (<200ms), no LLM call |
| 4 | Brief me → LLM fallback | click card; no recap | `⏳ Summarizing…` → final brief within 8s |
| 5 | Status: awaiting vs generating | session just ran `/compact` | card is 🟢 awaiting, not 🔴 generating |
| 6 | Spawn-label fallback | session has no real user asks | card headline shows `[tool: X]` or `/<cmd>` |
| 7 | Pin survives reload | pin a card → restart app | card still pinned |
| 8 | Skill run | invoke an Orka skill | pipeline completes; artifacts written |

## Hot paths (performance)

| Path | Budget (median / p95) | Probe |
|------|-----------------------|-------|
| cold `list_sessions` @ 100 sessions | 200ms / 500ms | `perf_smoke` + criterion |
| warm `list_sessions` | 30ms / 80ms | same |
| `list_projects` | 50ms / 150ms | `perf_smoke` |
| `get_session_brief` (recap hit) | 20ms / 60ms | synthetic fixture |
| `get_session_brief` (LLM call) | 5s / 10s | real `claude -p` |
| cold app start → first paint | 2s / 3.5s | Playwright timing |
| Monitor tail event lag | 100ms / 300ms | append-loop fixture |

## Known risk areas

Modules to scrutinise — state, caches, watchers, or external I/O.

- `sessions.rs` — `TAIL_CACHE`, `WATCHERS`, `CWD_CACHE`, mtime-based
  invalidation, poison recovery
- `session_brief.rs` — LLM call, mtime cache, recap parse (newly added)
- `terminal_launcher.rs` — external process, AppleScript
- `schedules.rs` — cron-style scheduling, tokio tasks
- `run_chat.rs` / `node_runner.rs` — subprocess lifecycle
- `destinations.rs` — file I/O under user HOME
- `skill_evolution.rs` — LLM call + file writes

## Phase execution

1. **Phase 1** — Vitest + RTL baseline; ≥10 unit tests on pure logic.
2. **Phase 2** — Playwright dev-mode E2E; 5 specs covering journeys 1–5.
3. **Phase 3** — `criterion` benches + baseline JSON + comparison script.
4. **Phase 4** — chaos: big JSONL, mutex poison, watcher leak, concurrent brief.
5. **Phase 5** — CI (GitHub Actions, 3 parallel jobs).

## Fix policy

When a test fails, **write the test first** (harness-driven): reproduce
the bug as a red test, then fix the source to turn it green. No speculative
fixes without a red test locking the regression.
