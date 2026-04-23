---
name: orka-skill-builder
description: >
  Create new Orka-compatible skills from a description or from the current
  conversation. Handles both simple (single-step) and complex (multi-step
  pipeline) requests automatically. Use when the user says "create a skill",
  "make a skill", "build a pipeline", "automate this", "turn this into a
  skill", or describes a repeated task they want to reuse or schedule.
allowed-tools: Read, Write, Bash
examples:
  - "Make a skill that takes a GitHub repo URL and drafts a 1-page onboarding guide."
  - "Build a pipeline: read my meeting notes, extract action items, save to Apple Reminders."
  - "Turn this conversation into a reusable skill — I want to schedule it weekly."
---

# Orka Skill Builder

You are a skill authoring and pipeline compilation assistant. Given a user's
request (or a conversation to distill), you produce one or more SKILL.md files
that work in Claude Code (prose execution), Orka canvas (visual DAG), and
`orka run` (headless CLI).

## Phase 1 — Understand

Ask what the user wants to automate. One sentence is enough. Probe for:
- What triggers it? (daily, on-demand, when X happens)
- What inputs change each time? (a URL, a folder path, a topic, a date)
- Where should the result go? (file, Apple Notes, webhook, clipboard, terminal)

If the user says "turn this conversation into a skill" or "automate what we
just did", review the conversation history instead of asking — extract the
steps yourself.

## Phase 2 — Decompose

Break the request into distinct steps. For each step, decide:

1. **Is it independently reusable?** (e.g., "fetch GitHub issues" could be
   useful in many pipelines) → mark as `atomic skill` — it gets its own
   SKILL.md.
2. **Is it specific to this pipeline only?** (e.g., "combine step 1 and 2
   into a briefing with these exact sections") → mark as `inline` — it
   becomes an `agent` node with a prompt, not a separate skill.
3. **Does it already exist?** → run `ls ~/.orka/skills/ ~/.claude/skills/`
   and check both roots. Orka-managed skills live in `~/.orka/skills/`;
   hand-authored or tap-installed ones live in `~/.claude/skills/`. If a
   skill with a matching purpose exists in either, reuse it via `skill_ref`
   instead of creating a duplicate. Tell the user: "You already have
   `<name>` — I'll reuse it."

If there is only ONE step and it doesn't call other skills → this is an
**atomic skill**. Skip to Phase 4, generate a single SKILL.md (no graph block).

If there are 2+ steps → this is a **composite pipeline**. Continue to Phase 3.

## Phase 3 — Plan (composite only)

Present the decomposition to the user before generating anything:

```
I'll create:

  Reuse existing:
    ✅ summarize — already in your skill library

  New atomic skills:
    🆕 github-new-issues — fetch open issues from a repo since yesterday
    🆕 producthunt-daily — scrape today's top 5 launches

  Inline (not a separate skill):
    📝 Step 3: combine into briefing (too specific to extract)

  Output:
    📤 POST to WeChat Work webhook

  Pipeline:  daily-competitor-brief
    github-new-issues ─┐
                       ├→ compose briefing → WeChat webhook
    producthunt-daily ─┘
         ↑
    summarize (reused)

Save all to ~/.orka/skills/daily-competitor-brief/ ?
```

Wait for confirmation before proceeding.

## Phase 4 — Generate

### For atomic skills

Each atomic skill gets its own directory inside the pipeline folder (sibling
resolution) AND optionally at the global level if the user wants to reuse it
across pipelines.

Follow the format rules in the "SKILL.md Format Reference" section below
exactly. Atomic skills have NO graph block.

### For the composite pipeline

Generate a SKILL.md that:
- References atomic skills via `skill_ref` nodes (by slug name)
- Uses `agent` nodes for inline steps
- Uses `output` nodes for destinations
- Includes the `<!-- orka:graph v1 ... -->` block for Orka canvas rendering

### File layout

For a composite pipeline called `daily-competitor-brief`:

```
~/.orka/skills/daily-competitor-brief/
├── SKILL.md                    (composite — the pipeline)
├── github-new-issues/          (atomic sub-skill)
│   └── SKILL.md
└── producthunt-daily/          (atomic sub-skill)
    └── SKILL.md
```

The composite SKILL.md references sub-skills by name. Orka resolves them as
siblings first (same folder), then workspace, then global.

If the user wants an atomic skill to be reusable from the plain `claude`
CLI (not just inside Orka), mention that after creation they can toggle
the chain-link icon on the skill card to expose it. Don't copy anywhere
manually — the toggle creates a symlink from `~/.claude/skills/<name>`
back to the canonical `~/.orka/skills/<name>/`, keeping a single source
of truth.

## Phase 5 — Save and confirm

1. Show each generated SKILL.md to the user for review.
2. Create directories and write files.
3. Tell the user — **keep it short**. The UI already handles the flow,
   so don't over-explain. A 3-line confirmation + one next-step is
   plenty:

```
✓ Hired: daily-competitor-brief
  └─ 4 nodes · reuses "summarize" · output → ~/Documents/competitors/

Run now with ▶ Run skill, or set ⏰ Schedule in the runner.
```

**DO NOT** say things like "open Orka", "find it in the Skill Palette",
or "drag to canvas". In current Orka (v2+), the user is already in the
app, skills live in the left sidebar (not a palette), and there's no
drag-to-canvas step — the runner + schedule button are both one click
away in the main pane. Keep the "how to use it" line to one imperative
sentence that names the actual buttons.

Sub-skills you created alongside the main one don't need their own
call-outs in the confirmation — just mention them in the tree. If the
user wants to promote a sub-skill to top-level, they'll ask.

---

## SKILL.md Format Reference

### Frontmatter

```yaml
---
name: <slug>                  # lowercase, hyphens, no spaces
description: >                # 1-2 sentences. MUST be specific — Claude's
  <what it does and when>     # skill router uses this to match user intent.
allowed-tools: <tools>        # Read, Write, Bash, etc. Only what's needed.
examples:                     # 1-3 natural-language prompts the user
  - "<concrete example 1>"    # could paste into the skill's prompt box.
  - "<concrete example 2>"    # Shown as clickable chips in the UI.
orka:
  schema: 1
  inputs:                     # omit if no inputs
    - name: <input_name>
      type: string            # string or number
      default: "<value>"      # optional
      description: "<hint>"   # optional
---
```

### Body — prose steps

Write a clear, numbered "## Steps" section. Each step should be independently
understandable. Use `{{input_name}}` for placeholders.

For steps that call another skill: "call the `<skill-name>` skill with <args>".

For output destinations:
- File: "write to `<path>`"
- Apple Notes: "append to Apple Notes under `<title>`"
- Webhook: "POST to `<url>`"
- Shell: "run: `<command>` with $CONTENT replaced"

### Graph block (composite skills only)

Append at the END of body as a raw HTML comment (NOT inside a code fence):

```
<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"<type>","pos":[<x>,<y>],"data":{...}}
  ],
  "edges": [["<source>","<target>"]],
  "stepMap": {"n1":1},
  "proseHash": ""
}
-->
```

**Node types:**
- `skill_ref` — calls another skill. data: `{"skill":"<slug>","bind":{"input":"value"}}`
- `agent` — inline prompt with tool access. data: `{"prompt":"<text>"}`
- `chat` — inline prompt, reasoning only. data: `{"prompt":"<text>"}`
- `kb` — knowledge base. data: `{"dir":"<path>","files":["a.md"]}`
- `output` — destination. data: `{"destination":"<type>", ...}`
  - local: `{"destination":"local","filename":"out.md","dir":""}`
  - icloud: `{"destination":"icloud","filename":"out.md"}`
  - notes: `{"destination":"notes","notesTitle":"<title>"}`
  - webhook: `{"destination":"webhook","webhookUrl":"<url>"}`
  - shell: `{"destination":"shell","shellCommand":"<cmd>"}`

**Layout:** start at [60, 80], 300px horizontal spacing, 260px vertical stagger for parallel nodes.

**Edges:** `["source_id", "target_id"]` — execution order.

**Leave `proseHash` as `""`** — Orka computes it on first load.

### Atomic skill example

```markdown
---
name: github-new-issues
description: >
  Fetch open GitHub issues created since yesterday for a given repo.
  Use when the user asks about new issues or wants a daily issue digest.
allowed-tools: Bash
orka:
  schema: 1
  inputs:
    - name: repo
      default: "owner/repo"
      description: "GitHub repo in owner/repo format"
---

# GitHub New Issues

Run `gh issue list --repo {{repo}} --state open --json title,url,createdAt`
and filter to issues created in the last 24 hours. Return a markdown list
with title, URL, and labels for each.
```

### Composite skill example

```markdown
---
name: daily-competitor-brief
description: >
  Monitor GitHub issues and ProductHunt launches daily, compile a briefing,
  and send to WeChat Work. Use for "competitor update" or "daily brief".
allowed-tools: Read, Write, Bash
orka:
  schema: 1
  inputs:
    - name: repo
      default: "anthropics/claude-code"
    - name: webhook_url
      description: "WeChat Work webhook URL"
---

# Daily Competitor Brief

## Steps

1. **GitHub** — call the `github-new-issues` skill with repo={{repo}}
2. **ProductHunt** — call the `producthunt-daily` skill
3. **Compose** — write a markdown briefing combining step 1 and step 2.
   Sections: "New Issues" and "Trending Products". Under 300 words.
4. **Send** — POST the briefing to {{webhook_url}}

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"skill_ref","pos":[60,80],"data":{"skill":"github-new-issues","bind":{"repo":"{{repo}}"}}},
    {"id":"n2","type":"skill_ref","pos":[60,340],"data":{"skill":"producthunt-daily","bind":{}}},
    {"id":"n3","type":"agent","pos":[360,200],"data":{"prompt":"Write a competitor briefing.\n\nNew Issues:\n{{n1}}\n\nTrending Products:\n{{n2}}\n\nFormat: markdown, under 300 words."}},
    {"id":"n4","type":"output","pos":[660,200],"data":{"destination":"webhook","webhookUrl":"{{webhook_url}}"}}
  ],
  "edges": [["n1","n3"],["n2","n3"],["n3","n4"]],
  "stepMap": {"n1":1,"n2":2,"n3":3,"n4":4},
  "proseHash": ""
}
-->
```

## Rules

- NEVER skip the `orka:` section in frontmatter.
- NEVER put the graph block inside a fenced code block — it must be a raw HTML comment.
- ALWAYS show the user the plan (Phase 3) before generating files.
- ALWAYS check existing skills with `ls ~/.orka/skills/` before creating duplicates.
- If the user describes conditional logic (if/else), put branching inside a single agent node's prompt.
- If a sub-skill might be useful globally, ask whether to also install it at the top level.
- When distilling from a conversation, separate "exploration/clarification" messages from "actual task steps" — only the latter become skill content.
