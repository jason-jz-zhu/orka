# Orka · Pain Points → Feature Spec

**Version 0.3 · 2026-04-18**

> Derived from founder's actual daily pain using Claude Code, validated
> against 15 LLM tools + 12 adjacent productivity tools (see COMPETITION.md).
> Each pain has a proven UX clone target — no invention required.

---

## Pain 1 · Walk into Session

### What hurts
A scheduled skill finishes. I get an output notification. I want to open
the result AND keep talking to Claude in the same context — not a fresh
chat that doesn't know what happened.

### Clone target
- **GitHub Actions run summary** — collapsible per-step logs with artifacts
  pinned at bottom, single primary "Re-run" button
- **Jupyter notebook cell** — cell with stored output + "re-run with
  modifications" pattern

### UX

```
Runs dashboard → click a row
    ↓
┌─ Run: weekly-audit · Fri 8:00 AM · done · 42s ────┐
│                                                    │
│ 🤖 system: Starting weekly audit...               │
│ 🤖 claude: Found 2 CVEs in dependencies...        │
│ 🤖 claude: [tool: git log --since=7d]             │
│ 🤖 claude: Summary: this week you shipped…        │
│ ─────────────────────────────────────────         │
│                                                    │
│ 👤 you: 第 2 个 CVE 为什么标 high?                │ ← type here
│ 🤖 claude: (streaming...)                          │
│                                                    │
│ [ Continue the conversation... ]  [Send]  [⤴ Term]│
└───────────────────────────────────────────────────┘
```

### Implementation

- Reuse `sessions::read_session()` in `src-tauri/src/sessions.rs` to load
  transcript
- New component `src/components/RunWalkIn.tsx`
- `run_agent_node` invoked with `resumeId=<run.finalSessionId>` on each send
- "⤴ Open in Terminal" button → spawns `claude --resume <sid>` in
  Terminal.app / iTerm via `osascript`

### Files

- `src/components/RunWalkIn.tsx` (new)
- `src-tauri/src/run_log.rs` — add `final_session_id: Option<String>` to RunRecord
- `src/lib/runs.ts` — extend RunRecord type

### Estimated cost: 2 days

---

## Pain 2 · Finding Authoritative Skills

### What hurts
I have 50–200 skills from mixed sources (mine, gstack, GitHub randoms). I
don't know which are trustworthy. When I want a skill for task X, I either
can't find one or don't know which is authoritative.

### Clone target
- **Raycast extension store** (curated monorepo)
- **Homebrew taps** (trusted-core vs user taps, tap-of-origin labeling)
- **Raycast frecency + VS Code palette shortcut hints** for search UX

### UX

```
Skills tab
├─ 🔍 [Search or describe what you want...]
├─ ─ Your skills ──────────────── (12)
│    ⭐ /my-weekly-audit      ⌘⇧A
│    /blog-summarize
├─ ─ Trusted Sources ──────────── (browse + install)
│    📍 Anthropic Official          (12 skills)
│       skill-creator · readwise-sync · meeting-notes
│    📍 gstack                       (40+ skills)
│       /ship · /review · /cso · /office-hours
│    📍 awesome-claude-code          (25 · opt-in)
└─ ➕ Add custom tap...
```

### AI Picker fallback

If fuzzy search returns 0 matches, offer semantic pick:

```
🔍 "check my repos for problems"

  No direct matches. Claude suggests:
  ▶ /weekly-repo-audit (90% match)
    "Scans git log + deps + CVEs across repos"
  ▶ /security-audit (70% match)
    "OWASP + CVE + secrets scan"
```

### Implementation

- Bundled `~/.orka/trusted-taps.json` with 3 default taps
- Git clone / sparse checkout to `~/.claude/skills/<tap-name>/`
- Frecency via `useFrecencySorting`-style hook in zustand store
- Semantic fallback: compose skill `description` fields → `claude -p` →
  structured JSON rank

### Files

- `src/components/SkillPalette.tsx` (existing, extend)
- `src-tauri/src/tap_manager.rs` (new)
- `src/lib/skills.ts` — frecency tracking

### Estimated cost: 2 days

---

## Pain 3 · Skill Self-Evolution

### What hurts
I edit the output of the same skill the same way every time. I ask the
same follow-up question after every run. The skill never learns. I
re-teach it manually forever.

### Clone target
- **Grammarly's silent "Add to dictionary" pill** — zero-friction
  acceptance, no modal
- **Cursor Bugbot learned rules** — observed feedback → auto-propose rule

### UX

After N runs with repeated pattern:

```
┌─ /weekly-audit ────────────────────┐
│ Ran 10 times this month.            │
│                                      │
│ 💡 Noticed: you always trim the     │
│    "Summary" section, and ask       │
│    about CVE severity 8/10 times.   │
│                                      │
│    Suggested skill update:          │
│    + Include CVE severity badges    │
│    − Remove default "Summary"       │
│                                      │
│    [ Update skill ]  [ Not now ]   │
└─────────────────────────────────────┘
```

### Implementation

- Per-run data: annotations (from Pain 6) + follow-up questions (from
  Pain 1 chat)
- Batch job when skill run count crosses threshold (5, 10, 25, 50)
- Invoke `claude -p` with "here's N runs of this skill + annotations +
  follow-ups. Suggest a skill update as a diff."
- Write back to SKILL.md on accept (atomic write to `.tmp` then rename)
- Log every accept/reject for future evaluation

### Files

- `src-tauri/src/skill_evolution.rs` (new)
- `src/components/SkillEvolutionPill.tsx` (new)
- `src/lib/skills.ts` — track run counts + last-evolution-check
- `src-tauri/src/skill_md/write.rs` — already has atomic write

### Estimated cost: 2–3 days

---

## Pain 4 · Session Brief ("what was I doing?")

### What hurts
I open 5 Claude Code sessions a week across projects. Re-entering one
costs 2–3 minutes of "what was I thinking?" I skip sessions I should
resume because the re-entry tax is too high.

### Clone target
- **Linear Inbox** "since you last opened" + actor filter

### UX

```
Sessions tab (renamed from Live)

┌─ Since you last opened Orka ───────────┐
│ 📘 orka/ · 3h ago                       │
│   You were: fixing SIGTERM cancel race  │
│   Progress: fixed, 2 tests added        │
│   Next: run full suite, push            │
│                         [↪ Resume]     │
├────────────────────────────────────────┤
│ 📗 gstack/ · 2d ago                    │
│   You were: writing /office-hours skill │
│   Progress: partial draft, unsaved      │
│                         [↪ Resume]     │
└────────────────────────────────────────┘

[All sessions (18) ▾]
```

### Implementation

- Tauri command `summarize_session(session_id: String)` reads
  `~/.claude/projects/*/<sid>.jsonl`, invokes `claude -p` with a
  structured-output prompt (you-were / progress / next-likely)
- Cache briefs at `~/.orka/session-briefs.json`, invalidate on JSONL mtime
  change
- Live tab rewrites to pinned "since you last opened" + grouped full list

### Files

- `src-tauri/src/session_brief.rs` (new)
- `src/components/SessionsTab.tsx` (rename + rework from Live)
- `src/lib/sessions.ts` — brief cache

### Estimated cost: 2 days

---

## Pain 5 · Cross-Session Synthesis

### What hurts
I asked about authentication in session A, migration in session B, and
performance in session C. I want to ask a question that spans all three
— without copy-pasting transcripts manually.

### Note on honesty
Claude CLI has no native "merge sessions" primitive. Orka does not fake
it. Under the hood: read each session's JSONL, summarize, compose a new
session with the summaries as context. The UX feels like merging; the
implementation is prompt engineering. This is fine — call it synthesis,
not merge.

### Clone target
- **NotebookLM 3-pane layout** — Sources (checkboxes) → Chat → Studio

### UX

```
┌─ Sources ──────────┐┌─ Chat ────────────────────────┐
│ ☑ session-a-auth   ││ Chatting with: [session-a]    │
│ ☑ session-b-migr   ││                [session-b] ×  │
│ ☐ session-c-perf   ││                                │
│ ☐ run-5-audit      ││ > Compare the auth decision   │
│                    ││   in A to the migration plan  │
│                    ││   in B. Any conflicts?        │
│                    ││                                │
└────────────────────┘└────────────────────────────────┘
```

### Implementation

- Sources panel: checkbox list of recent sessions + runs
- On send: for each checked source, read JSONL → summarize via
  `claude -p` (parallel) → compose single merged context
- Spawn new session with merged context as system message equivalent
- Source chips in composer are removable

### Files

- `src/components/SynthesisPane.tsx` (new)
- `src-tauri/src/synthesis.rs` (new) — handles parallel JSONL summarization
- Reuse existing `read_session`, `run_agent_node`

### Estimated cost: 2 days

---

## Pain 6 · Output Annotator ★

### What hurts
Claude writes 2,000 words. I care about 3 bullets. I want to mark the
ones that matter, add my own thoughts (like Word doc comments), and
dispatch the annotated selection — all without copy-pasting to three
different apps.

**This is Orka's hero feature.** Zero LLM tools do this today.

### Clone target
- **Word / Google Docs comments** — select text, side-panel comment,
  attached to span
- **Readwise Ghostreader** — select → floating toolbar → action tags
  (`.save-to-notes`, `.turn-into-skill`)

### UX

```
Claude's output rendered as blocks (paragraphs / bullets / code).
Each block has a 💬 icon on right.

┌─ Block ────────────────┐   ┌─ Your annotation ────────┐
│ Suggested: replace     │   │ 💬 you:                   │
│ moment with dayjs      │ ← │  But we already migrated │
│                        │   │  to luxon — is this      │
│                        │   │  suggestion stale?       │
│                        │   │                           │
│                        │   │ [❓ Ask Claude about this]│
│                        │   │ [📝 Save to Notes]       │
│                        │   │ [💾 Make skill from this]│
└────────────────────────┘   └──────────────────────────┘
```

### Three dispatch actions

| Action | What happens |
|---|---|
| ❓ Ask Claude | Continue conversation with: "About this block: <text>\nMy note: <annotation>\n<new question>" |
| 📝 Save to Notes | Apple Notes entry with block text + annotation as markdown |
| 💾 New skill | Seed a new skill: block as context, annotation as special instruction |

### Strategic significance

- **Unique in the LLM space** — no competitor does select + annotate + dispatch
- **Fuel for Skill Evolution (Pain 3)** — annotations are richer signal than
  raw output (tells the skill "this is where I push back")
- **Highest frequency feature** — triggers on every run, not monthly/weekly

### Implementation

**Data model:**
```json
// ~/.orka/runs/<run_id>/annotations.json
{
  "blocks": [
    { "idx": 2, "hash": "abc123", "content": "..." }
  ],
  "annotations": [
    { "blockIdx": 2, "text": "...", "created": "2026-04-18T..." }
  ]
}
```

**Steps:**
1. Parse Claude output markdown → `Block[]` (paragraphs, bullets, code)
2. Render each block with 💬 indicator
3. Clicking 💬 opens side panel editor
4. Zustand state `Map<runId, Map<blockIdx, Annotation>>`
5. Dispatch buttons reuse existing commands:
   - `write_to_notes` for Apple Notes
   - `run_agent_node` for Ask Claude (compose prompt)
   - `save_node_as_skill` for New skill

### Files

- `src/components/OutputAnnotator.tsx` (new, main component)
- `src/lib/markdown-blocks.ts` (new, markdown → Block[] parser)
- `src/lib/graph-store.ts` — add `annotations` state slice
- `src-tauri/src/annotations.rs` (new, persistence)
- `src/nodes/ChatNode.tsx` — use Annotator for output rendering

### Estimated cost: 3 days

---

## Summary table

| # | Pain | Cost | White space | Feeds into |
|---|---|---|---|---|
| 1 | Walk into Session | 2 days | Medium | Pain 6 (dispatch from walk-in chat) |
| 2 | Trusted Taps | 2 days | High | — |
| 3 | Skill Evolution | 2–3 days | High | Consumes Pain 6's annotation data |
| 4 | Session Brief | 2 days | High | Pain 5 (brief as source) |
| 5 | Cross-Synthesis | 2 days | High | — |
| 6 | Output Annotator ★ | 3 days | **Highest** | Feeds Pain 3 · referenced by Pain 1 |

**Total engineering: ~12–14 days for v0.3. 3-week calendar (buffer + polish + dogfood).**

---

## Implementation order (enforced by dependencies)

1. **Week 1:** Output Annotator (Pain 6) → Session Brief (Pain 4) →
   Walk into Session with dispatch via Annotator (Pain 1)
2. **Week 2:** Trusted Taps (Pain 2) → Skill Evolution using Annotator
   data (Pain 3) → Cross-Session Synthesis (Pain 5)
3. **Week 3:** Dogfood + polish + launch prep
