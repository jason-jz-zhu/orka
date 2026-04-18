# Orka · Competitive Landscape

**Version 0.3 · 2026-04-18**

> Compiled from research across 15 LLM tools and 12 adjacent productivity
> tools. Coverage rated against Orka's 6 core pain points (see PAINS.md).
> Refresh this doc when shipping a major feature or when a major competitor
> ships a similar feature.

---

## Coverage matrix (tools × 6 pains)

Legend: ✅ full · 🟡 partial · ❌ none

| Tool | 1 Walk-in | 2 Skill Discovery | 3 Self-Evolution | 4 Session Brief | 5 Cross-Synth | 6 Annotator |
|---|---|---|---|---|---|---|
| Claude.ai (Cowork) | 🟡 | 🟡 | ❌ | 🟡 | 🟡 | ❌ |
| Claude Desktop | 🟡 | 🟡 | ❌ | 🟡 | 🟡 | ❌ |
| Claude Code CLI | ✅ `/schedule` + `/loop` | 🟡 slash menu | ❌ | ❌ | ❌ | ❌ |
| ChatGPT | ✅ Tasks | 🟡 GPT store | ❌ | 🟡 project memory | 🟡 cross-chat memory | 🟡 Canvas highlight→edit |
| Cursor | ❌ | 🟡 `.cursor/rules` glob auto-attach | ✅ **Bugbot learned rules (PR-only)** | ❌ | ❌ | ❌ |
| Zed | ❌ | 🟡 | ❌ | ❌ | ❌ | ❌ |
| GitHub Copilot | ❌ | 🟡 `/prompt-name` | ❌ | ❌ | ❌ | ❌ |
| Cody (Sourcegraph) | ❌ | 🟡 Prompt Library | ❌ | ❌ | ❌ | ❌ |
| Continue.dev | ❌ | 🟡 hub blocks | ❌ | ❌ | ❌ | ❌ |
| Cline (VS Code) | ❌ | ✅ **relevance-gated skills** | ❌ | 🟡 Memory Bank | 🟡 via Memory Bank | ❌ |
| Raycast AI | 🟡 | ✅ **@-mention routing over extensions** | ❌ | ❌ | ❌ | ❌ |
| Dia browser | ❌ | ✅ **NL skills tied to tabs** | 🟡 Memory | 🟡 tab memory | ❌ | ❌ |
| Perplexity | ❌ | 🟡 Spaces | ❌ | 🟡 profile memory | ✅ **cross-thread recall (Mar 2026)** | ❌ |
| Gemini | ✅ Scheduled Actions | 🟡 Gems | ❌ | 🟡 Productivity Gem | 🟡 Workspace | ❌ |
| OpenClaw | 🟡 (ad-hoc spawn) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cloud Routines (Anthropic) | 🟡 (runs, no walk-in) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Rewind / Mem0 | ❌ | ❌ | 🟡 Mem0 learns interactions | ✅ **"what was I doing"** | ✅ screen-based | ❌ |

---

## White-space analysis

### 🟢 Pain 6 · Output Annotator — **HIGHEST white space**

**Zero LLM tools do block-selection + annotation + multi-destination dispatch.**

Closest comparisons:
- ChatGPT Canvas: allows highlight → edit-in-place, no multi-block,
  no annotation, no dispatch
- Readwise Ghostreader: select → action tags pattern (the clone target)
  but for article reading, not LLM output

This is Orka's single most defensible feature. Protect the hero slot.

### 🟢 Pain 3 · Skill Self-Evolution — near-empty

**Only Cursor Bugbot** exists and is locked to PR review feedback.
Nothing turns "user ran skill N times and always follows up with Y"
into a skill-update proposal.

Orka's advantage is breadth: every skill-run is an evolution signal,
not just code review.

### 🟢 Pain 4 · Session Brief — weakly served

- **Rewind** (discontinued Dec 2025) nailed "what was I doing" but with
  overkill full-screen capture
- **Cline Memory Bank** approximates it but locked to VS Code coding

White space: AI-chat sessions specifically (as opposed to screen or
code). Linear Inbox pattern transfers directly.

### 🟢 Pain 5 · Cross-Session Synthesis — mostly empty

- **Perplexity** shipped cross-thread recall in March 2026 — but
  one-product silo, you can't synthesize across Claude sessions
- **NotebookLM** has the 3-pane source-checkbox UX (clone this) but for
  static documents, not live LLM sessions

White space: select N past/live LLM sessions → ask across them.

### 🟡 Pain 1 · Walk into Session — partial matches

- **Scheduling is mature**: ChatGPT Tasks, Gemini Scheduled Actions,
  Claude `/schedule`
- **Re-entering same context after a scheduled run is NOT.** All
  schedulers above drop into fresh threads.

Orka's play: schedule + walk-into-same-context. GitHub Actions run
summary layout is the clone target.

### ⚪ Pain 2 · Skill Discovery — must match parity

Strong competitors exist:
- **Raycast** @-mention extension routing
- **Cline** relevance-gated skills (best-in-class token efficiency)
- **Dia** NL-driven skills tied to browser tabs

Orka does not innovate here; it matches the bar with Raycast frecency +
curated "Trusted Taps" approach (Homebrew-style).

---

## Top 3 steal-worthy features (from any competitor)

1. **Cursor Bugbot learned rules** — observed feedback → auto-propose rules.
   Apply to Orka: annotation + follow-up data → skill-update proposal.

2. **Cline relevance-gated skills** — searchable but only loaded into
   context on match. Solves Orka's 100+ skills scaling without token
   bloat.

3. **Raycast `useFrecencySorting`** — frequency + recency scoring, plus
   fuzzy subsequence matching. Pattern directly maps to Orka's skill
   palette.

---

## Cross-category steal-worthy patterns (from adjacent tools)

| Pattern | From | Where it fits in Orka |
|---|---|---|
| Run summary: collapsible steps + artifacts + Resume button | GitHub Actions | Pain 1 (Walk-in Run view) |
| Cell-with-output + re-run-with-modifications | Jupyter | Pain 1 (parameterized re-run) |
| `useFrecencySorting` + fuzzy subsequence | Raycast API | Pain 2 (skill picker) |
| Inline keybinding hints next to command | VS Code Command Palette | Pain 2 (teaches muscle memory) |
| "Add to dictionary" silent pill | Grammarly | Pain 3 (silent skill update suggestion) |
| Next Edit Suggestion ghost diff | Copilot NES | Pain 3 (show proposed skill diff) |
| "Since you last opened" inbox section | Linear Inbox | Pain 4 (Session Brief layout) |
| 3-pane layout: checkbox sources → chat → studio | NotebookLM | Pain 5 (Synthesis UX) |
| Removable source chips in composer | Perplexity Spaces | Pain 5 (source display) |
| Text-select → floating toolbar with action tags | Readwise Ghostreader | Pain 6 (Annotator core) |
| Word-doc comment side panel | Google Docs / Word | Pain 6 (annotation sidebar) |

---

## Threat assessment

### Near threats (0–6 months)

**Anthropic — Cloud Routines + Claude Desktop combined**
- Cloud Routines (April 2026 preview) covers scheduled cloud execution
- Claude Desktop's Projects feature overlaps with skill management
- **Mitigation:** Orka is local-first; Anthropic is cloud-first by DNA.
  They will never prioritize Apple Notes integration over web/mobile
  parity. Stay in that gap.

### Medium threats (6–12 months)

**Raycast adding scheduled AI extensions**
- Raycast has distribution + polish; one PM quarter away from shipping
- **Mitigation:** They won't read `~/.claude/skills/` (different
  ecosystem) and won't annotate LLM output (not their product shape).
  Deepen Apple-native integration; co-opt by shipping a Raycast command
  that triggers Orka skills.

**Cline expanding outside VS Code**
- Closest philosophical competitor (skill-first, Memory Bank)
- **Mitigation:** Cline is a coding assistant; Orka is a workbench.
  Different beachhead; not mutually exclusive.

### Long threats (12+ months)

**Anthropic ships official skill registry**
- Likely eventually; would supersede community taps
- **Mitigation:** Orka is a reader, not a registry. When an official
  registry lands, Orka becomes the best *client* for it.

**Apple adds native Claude integration to Shortcuts / Intelligence**
- Low probability — Apple prefers in-house models + ChatGPT partnership
- **Mitigation:** None needed; if it happens, Orka integrates with
  Shortcuts rather than competing.

---

## Positioning statement (for landing page / HN)

> **Claude's answer, with your notes in the margins.**
>
> Orka is how you think alongside Claude.
>
> Schedule skills, resume conversations, annotate outputs, evolve your
> library — all on your Mac, all on your Max plan.

### Differentiation one-liners (pick per channel)

- vs Cloud Routines: *"Routines runs public workflows in the cloud. Orka
  runs your private routines on your Mac."*
- vs Raycast AI: *"Raycast is a launcher. Orka is a workbench."*
- vs Cline: *"Cline makes code. Orka remembers, annotates, and evolves."*
- vs ChatGPT Canvas: *"Canvas lets you edit Claude's answer. Orka lets
  you think about it."*

---

## Sources (key references)

### LLM tools
- Claude Code CLI: <https://code.claude.com/docs/en/cli-reference>
- Claude Cowork Projects: <https://ryanandmattdatascience.com/claude-cowork-projects/>
- Cline Skills: <https://medium.com/data-science-collective/using-skills-with-cline-3acf2e289a7c>
- Cursor Bugbot: <https://cursor.com/changelog>
- Raycast AI Extensions: <https://manual.raycast.com/ai-extensions>
- NotebookLM 2026 Updates: <https://www.jeffsu.org/notebooklm-changed-completely-heres-what-matters-in-2026/>
- Perplexity March 2026 updates: <https://theagencyjournal.com/perplexitys-march-2026-whirlwind-comet-lands-computers-think-deeper-and-memories-stick/>

### Adjacent tools
- GitHub Actions agentic workflow summary: <https://github.blog/changelog/2026-03-26-view-agentic-workflow-configs-in-the-actions-run-summary/>
- VS Code Command Palette UX: <https://code.visualstudio.com/api/ux-guidelines/command-palette>
- Raycast `useFrecencySorting`: <https://developers.raycast.com/utilities/react-hooks/usefrecencysorting>
- Linear Inbox: <https://linear.app/docs/inbox>
- Readwise Ghostreader: <https://docs.readwise.io/reader/guides/ghostreader/overview>
- Copilot Next Edit Suggestions: <https://code.visualstudio.com/blogs/2026/02/26/long-distance-nes>

---

## Review schedule

- Refresh this matrix when a major LLM tool ships a new feature touching
  any of the 6 pains
- Re-run competitive research before each Orka major version
- Update steal-worthy patterns as new adjacent tools emerge
