# Orka · Project Plan

**Version 0.3 · 2026-04-18**

> Single source of truth. Any significant product change updates this file first.

---

## Vision

**Orka is a native Mac home for Claude skills — where you run them, annotate
the results, and let them evolve.**

One Mac, a library of local skills, a few scheduled runs, and every output
can be annotated and kept. That's the whole product.

---

## Why now

| Factor | State |
|---|---|
| Claude Code ecosystem | Exploding (SKILL.md is the de-facto standard) |
| Skill count | 100+ from gstack, Anthropic, community, growing weekly |
| Competitor white space | 4 of 6 core pains unclaimed (Annotator, Brief, Evolution, Synthesis) |
| Founder motivation | Dogfood user (weekly engineering routines) |
| Business path | Consulting lead magnet, 6–12 months. $0 SaaS year-1 revenue acceptable |

**Window:** 9–12 months before Anthropic Cloud Routines matures or Raycast
ships scheduled AI extensions.

---

## Target user

Two layers:

- **Evidence user** (proves product-market fit via usage): founder + 20 senior
  devs like them, running weekly engineering routines
- **Marketing user** (not excluded on landing): any Claude Max user on a Mac
  with recurring work — researchers, consultants, PMs, content creators

---

## 5 Strategic pillars

1. **Skill-first simplicity** — Two nouns only: **Skill** and **Run**.
   `pipeline`, `manifest`, `template`, `bundle` are dead words.
2. **Local-first** — 100% local execution, local files, Apple-native sinks.
   Cloud is Routines' territory.
3. **Reader, not registry** — Orka reads `~/.claude/skills/`. It does not run a
   store, ratings, or moderation. That's Anthropic's job.
4. **Framework > library** — The value isn't "100 pre-packaged skills"; it's
   "your skills improve the more you use them."
5. **Hero slot belongs to differentiation** — Terminal, canvas, cloud
   routines are never the hero. Annotator is.

---

## Product structure (locked)

### 3 Tabs · 2 Nouns

```
Skills            Sessions              Runs
 ├─ AI Picker      ├─ Session Brief      ├─ History
 ├─ Trusted Taps   ├─ Cross-Synthesis    ├─ Walk in + chat
 └─ Evolution      └─ Resume             └─ Open in Terminal
```

### 6 Pains → 6 Features

| # | Feature | Clone target | White space |
|---|---|---|---|
| 1 | Walk into Session (transcript + chat) | GH Actions run summary + Jupyter cell re-run | Medium |
| 2 | Trusted Taps + AI Picker | Raycast frecency + curated trusted tap list | High |
| 3 | Skill Evolution Pill | Grammarly silent pill + Cursor Bugbot | High |
| 4 | Session Brief | Linear "since you last opened" + actor filter | High |
| 5 | Cross-Session Synthesis | NotebookLM 3-pane + source chips | High |
| 6 | Output Annotator ★ | Word/Docs comments + Readwise action tags | Highest (zero LLM competitors) |

### Terminal strategy

- **In-app chat** on every run (required for Annotator to live)
- **"Open in Terminal" button** — spawns iTerm / Terminal.app with
  `claude --resume <sid>` (0.5 day)
- **Never** embed xterm.js + portable-pty (not a moat, high maintenance)

### Canvas strategy

- **Not the hero.** Appears only when opening a composite skill (has
  `<!-- orka:graph -->` block). 90% of users never see it.

---

## Differentiation

| Competitor | Their thing | Orka's thing |
|---|---|---|
| Anthropic Cloud Routines | Cloud 24/7, public info | Local private data, Apple sinks |
| OpenClaw | Telegram chat → remote spawn | Native Mac GUI for recurring work |
| Raycast AI Extensions | Ad-hoc AI commands | Long-term memory, annotation, evolution |
| Cline (VS Code) | Locked in editor | Standalone app, non-devs usable |
| Cursor Bugbot | PR feedback → rules | All skill usage → skill evolution |
| NotebookLM | Research tool, no schedule | Skills + schedule + annotation |
| ChatGPT Canvas | Highlight → edit-in-place | Highlight → annotate → dispatch |

**Orka's 4 structural moats:**

1. Full local Mac filesystem access (`~/Code`, `~/Documents`, `~/Obsidian`)
2. Apple-native sinks (Notes, iCloud, Reminders, Shortcuts bridge)
3. Every output is annotatable — annotations feed skill evolution signal
4. Per-skill evolution from cumulative usage data

---

## Shipping plan (3 weeks)

### Week 1 · Daily-use killer features

**Goal: you use Orka every day this week.**

1. **Output Annotator** (Pain 6) — 3 days
   - Block-level parsing, annotation sidebar, 3 dispatch actions
     (Apple Notes / Ask Claude / New skill)
   - In-app chat panel (walk into a run)
   - "Open in Terminal" button (0.5 day)
2. **Session Brief** (Pain 4) — 2 days
   - Rename Live → Sessions
   - Scan `~/.claude/projects/*.jsonl`, summarize via `claude -p`
   - Linear "since you last opened" layout

### Week 2 · Differentiation depth

3. **Trusted Taps** (Pain 2) — 2 days
   - Bundled list: Anthropic official, gstack, 1–2 community packs
   - Browse + one-click `git clone` install
   - Authority badges
4. **Skill Evolution Pill** (Pain 3) — 2–3 days
   - Each skill card observes annotation + follow-up question data
   - On threshold, silent pill: "Noticed X — update skill?"
   - One-tap accept, writes to SKILL.md
5. **Cross-Session Synthesis** (Pain 5) — 2 days
   - NotebookLM 3-pane UI
   - Select N sessions → compose merged context → new session

### Week 3 · Dogfood + launch prep

6. Scheduled runs (launchd integration, already partially built)
7. **Dogfood 2 weeks** with your own data
8. README rewrite — hero: *"Claude's answer, with your notes in the margins."*
9. Demo video v7 using your real weekly-audit data
10. HN / Twitter prep · Apple Developer signing · `.orka` bundle export

---

## Success metrics (60 days post-launch)

Pick one lane and ride it. Don't dilute.

| Signal | Threshold | Validates |
|---|---|---|
| **Consulting inbound** | 3+ DMs asking for paid setup help | Lead magnet hypothesis (primary) |
| **Active installs** | 20+ real installs, week-2 retention | SaaS viability (secondary) |
| **KOL mention** | 1 AI/dev Twitter retweet or newsletter | Distribution (tertiary) |

**0-signal trigger:** After 60 days with none of the above, re-run
office-hours and narrow to a single persona (likely the senior-dev persona
rejected in the first office-hours).

---

## Business model

- **Primary:** Orka app — $49 one-time. Open-source core + Pro features
  (Keychain, scheduler, failure notifications, `.orka` export).
- **Secondary:** Consulting — Orka is the business card.
  - Setup call: $300/hr
  - Custom skill development: $500+
  - Team/enterprise deployment: $5k+
- **12-month realistic expectation:** Orka revenue $0–5k, consulting
  $50–200k.
- **36-month ceiling:** $3–10M ARR lifestyle business (unless skill
  marketplace flywheel catches — see Open Questions).

---

## Permanent NO list

Protect complexity budget. These stay un-built even when users ask:

- Skill store / marketplace / ratings (Anthropic's job)
- Embedded real terminal (xterm.js + portable-pty)
- Inter-session "real merge" (CLI doesn't support it; faking it is lying)
- Canvas as hero feature
- Matrix grid view (Run filter suffices)
- Run-diff UI (plugin later if ever)
- Checkpoint / fork DAG
- Compete with Cloud Routines (bridge, don't duplicate)
- Linux / Windows support (Mac-only, AppleScript-dependent)

---

## Open questions (answered by 2-week dogfood, not argument)

1. Is canvas actually useless, or does composite-skill usage revive it?
2. Do users prefer "walk into session" or external terminal?
3. Are Skill Evolution pill suggestions accurate enough to accept >50% of
   the time?
4. Are 3 default trusted taps enough? Do users add their own?
5. After 2 weeks: does *"Claude's answer, with your notes in the margins"*
   still describe the product?

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Anthropic ships skill registry in 2 months | Be a reader, not a registry — compatible by design |
| Raycast ships scheduled AI extensions | Double down on Apple-native depth (Notes, Reminders, Shortcuts) |
| Founder bubble (only proves themselves) | Get 3–5 other devs testing Evolution before launch |
| 0 signal at 60 days | Narrow persona, re-position, cut marketing width |
| Solo founder bandwidth | AI-paired coding (proven); strict non-expansion discipline |

---

## Landing page hero (v1)

> **Claude's answer, with your notes in the margins.**
> Orka is how you think alongside Claude.
>
> Schedule skills, resume conversations, annotate outputs, evolve your
> library — all on your Mac, all on your Max plan.

---

## One-line summary

**Orka = your Mac's second brain for Claude.**
**Runs your skills, remembers your sessions, annotates their output,
helps them evolve. Local, native, your subscription.**

---

## Related documents

- [PAINS.md](./PAINS.md) — Detailed spec per pain point with UX clone targets
- [COMPETITION.md](./COMPETITION.md) — Competitive coverage matrix
- [OFFICE-HOURS-2026-04-17.md](./OFFICE-HOURS-2026-04-17.md) — Initial YC-style
  product validation session
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Technical architecture
- [SKILL-FORMAT.md](./SKILL-FORMAT.md) — SKILL.md format specification (v1)
- [CORE-CONCEPTS.md](./CORE-CONCEPTS.md) — Product philosophy (partially deprecated; preserved for history)
- `_private/` — internal strategy notes, gitignored, not published
