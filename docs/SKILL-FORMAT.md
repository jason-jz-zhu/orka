# Orka Skill Format (v1)

**Status**: v1 Final (2026-04-15). Changes require a schema version bump to v2.

## Philosophy

A Claude Code `SKILL.md` and an Orka pipeline are **the same artifact at different zoom levels**. An atomic skill is one prompt; a composite skill is a DAG of prompts. This spec defines a single file format that is:

- **Human-executable** by Claude Code / OpenAI Codex (reads the prose body, follows the steps)
- **Machine-editable** by Orka (reads the embedded graph, renders a canvas, executes the DAG headlessly)
- **Round-trip safe** — Orka → SKILL.md → Orka produces an identical canvas
- **Degrades gracefully** — if the embedded graph is missing or corrupted, the prose body still works
- **Standard-compliant** — conforms to the cross-vendor `SKILL.md` convention adopted by Anthropic, OpenAI, and Microsoft

One file. Three runtimes (Claude Code, Orka canvas, `orka run` headless CLI). No format divergence.

---

## File layout

A skill is a directory:

```
<name>/
├── SKILL.md              (required) — this spec
├── pipeline.json         (optional, legacy) — read for migration only, never written
├── references/           (optional) — supporting docs Claude can load on demand
├── scripts/              (optional) — executable helpers the skill calls
└── .orka/                (gitignored) — runtime state, never shared
    ├── state.json        (per-node output, running flags, last session ids)
    └── .gitignore        (contains `*` — ensures this dir is never committed)
```

Skills are discovered in this order (first hit wins):

1. `./<name>/SKILL.md` relative to a referring skill (sibling)
2. `<workspace>/.claude/skills/<name>/SKILL.md` (project-local)
3. `~/.claude/skills/<name>/SKILL.md` (user-global)
4. `<workspace>/templates/<name>.json` (legacy Orka JSON — triggers migration prompt)

---

## Frontmatter

Frontmatter is YAML between `---` fences. The standard Claude/Codex fields are canonical. Orka-specific fields nest under a single `orka:` key to avoid colliding with future vendor additions.

```yaml
---
name: morning-briefing                 # required, filesystem-safe slug
description: >                         # required, used by skill router
  Assemble a daily briefing from calendar and inbox, save to Apple Notes.
  Use when the user says "morning brief" or asks for today's agenda.
allowed-tools: Read, Write, Bash       # optional, Claude-standard
model: claude-sonnet-4-5               # optional, Claude-standard

orka:                                  # all Orka-specific metadata
  schema: 1                            # required, bump on breaking changes
  viewport: { x: 0, y: 0, zoom: 0.85 } # canvas position at last save
  inputs:                              # declared pipeline inputs
    - name: focus
      type: string
      default: "deep work"
      description: "Theme for today's brief"
  outputs:                             # named outputs other skills can bind to
    - name: briefing
      from: n3                         # node id whose output is this named output
---
```

### Field rules

- **`name`** — must match the enclosing directory name. Filesystem-safe: `[a-z0-9][a-z0-9-]*`. Non-ASCII names get slugified with a timestamped fallback during export.
- **`description`** — 1-2 sentences. This is what Claude's skill router matches against user intent. Generic descriptions ("Run a pipeline") are rejected at save time.
- **`allowed-tools`** — passed through to Claude unchanged. Orka does not enforce it during its own execution (uses the node type instead).
- **`orka.schema`** — current version is `1`. Parsers MUST refuse to read a higher schema.
- **`orka.inputs`** — `name` is required, everything else optional. Types: `string`, `number`. Future: `boolean`, `file`.
- **`orka.outputs`** — maps named outputs to a specific node's `output` text. Used by parent skills when this skill is called via `skill_ref`.

---

## The graph block

The DAG lives in an HTML comment block in the body, marked by the tag `orka:graph <version>`:

```markdown
<!-- orka:graph v1
{
  "nodes": [ ... ],
  "edges": [ ... ],
  "stepMap": { ... },
  "proseHash": "sha256:..."
}
-->
```

### Why HTML comment and not frontmatter or fenced code

- **Not visible when rendered** — GitHub, Obsidian, Apple Notes, README viewers all hide it
- **Visible when raw-read** — Claude Code sees it but strongly treats HTML comments as non-executable metadata, especially when prose immediately above says "Steps:"
- **Single-file round-trip** — no sibling `pipeline.json` to drift against
- **Does not pollute frontmatter** — future Claude/Codex fields can be added without conflict
- **Not inside a code fence** — parsers that treat \`\`\` as opaque will not touch this block

### Placement rule

- MUST appear exactly once per file
- MUST NOT be inside a fenced code block (```)
- SHOULD appear at the end of the body, after the prose steps
- Comment opener and tag line are split: the line starts with `<!-- orka:graph v1` and the JSON begins on the NEXT line. This makes it trivial to regex without touching JSON escaping.

### JSON schema (schema v1)

```jsonc
{
  "nodes": [
    {
      "id": "n1",                    // unique within the file, stable across saves
      "type": "skill_ref",           // see node types below
      "pos": [60, 80],               // [x, y] canvas position (tuples, not objects — less diff noise)
      "data": { ... }                // node-type-specific payload
    }
  ],
  "edges": [
    ["n1", "n3"],                    // [source, target] — tuples, not objects
    ["n2", "n3"]
  ],
  "stepMap": {                       // node id → prose step number; used for drift detection
    "n1": 1, "n2": 2, "n3": 3
  },
  "proseHash": "sha256:abcd...",     // sha256 of the prose body at last Orka write (see below)
  "lastWrittenBy": "orka/0.2.0"      // informational, for debugging
}
```

### proseHash algorithm

```
prose = body
       .strip(<!-- orka:graph v1 ... --> block entirely)
       .strip_trailing_whitespace()
       .normalize_line_endings_to_lf()
proseHash = "sha256:" + hex(sha256(prose.as_bytes()))
```

Critical: the hash covers everything Claude would read (prose + frontmatter is NOT hashed because frontmatter is canonically Orka-owned when inside `orka:`). On load, Orka recomputes `proseHash(current_file)` and compares to the stored value:

- **Match** → trust the graph, render canvas from it
- **Mismatch** → user edited prose outside Orka; show a 3-way diff UI, user picks: keep graph / regenerate prose from graph / accept prose + re-derive graph (requires AI call)

---

## Node types

All node data fields are optional unless marked **required**.

### `skill_ref` — invoke another skill

```jsonc
{
  "id": "n1",
  "type": "skill_ref",
  "pos": [60, 80],
  "data": {
    "skill": "calendar-today",       // required, slug resolved via scanner
    "bind": {                         // input bindings; values can reference placeholders
      "focus": "{{focus}}",           // → this skill's own input
      "date":  "{{n5.briefing}}"     // → another node's named output
    }
  }
}
```

Runtime behavior: Orka composes `/<skill>\n\n<rendered-bindings>` and sends to the local `claude` CLI. Claude's own skill router handles the dispatch. Result stream is captured into this node's `output`.

### `chat` — inline prompt, no tool access

```jsonc
{
  "id": "n3",
  "type": "chat",
  "pos": [400, 200],
  "data": {
    "prompt": "Compose a briefing. Agenda:\n{{n1}}\n\nNeeds reply:\n{{n2}}"
  }
}
```

### `agent` — inline prompt with full tool access

Same data shape as `chat`. Runtime adds `--dangerously-skip-permissions` and `--add-dir` for upstream KB nodes.

### `kb` — knowledge base directory

```jsonc
{
  "id": "k1",
  "type": "kb",
  "pos": [60, 600],
  "data": {
    "dir": "/absolute/path/to/docs",
    "files": ["a.md", "b.md"]      // optional — if empty, all files in dir
  }
}
```

Runtime: the directory is added to downstream agent nodes via `--add-dir`; file list becomes part of the composed context.

### `output` — write to a destination

```jsonc
{
  "id": "n4",
  "type": "output",
  "pos": [740, 200],
  "data": {
    "destination": "notes",          // local | icloud | notes | webhook | shell | profile
    "format": "markdown",            // markdown | json | text
    "mergeMode": "concat",           // concat | list | json
    "template": "---\n{content}",    // optional wrapping template; {content} is required
    "overwrite": false,
    // destination-specific:
    "filename": "brief.md",          // local, icloud
    "dir": "",                        // local
    "notesTitle": "Daily Log",       // notes
    "webhookUrl": "https://...",     // webhook
    "webhookHeaders": "...",         // webhook
    "shellCommand": "...",           // shell; $CONTENT is replaced at runtime
    "profileId": "..."               // profile (resolves via ~/OrkaCanvas/.destinations.json)
  }
}
```

### `pipeline_ref` — deprecated alias for `skill_ref`

Accepted on read for backward compatibility. Writers MUST emit `skill_ref`.

---

## Placeholder syntax

Placeholders use `{{...}}` Mustache-style. They are resolved at runtime in this order:

1. **`{{input_name}}`** — a declared pipeline input (from `orka.inputs`)
2. **`{{node_id}}`** — the full text output of another node
3. **`{{node_id.output_name}}`** — a named output from another node (if that node's skill declares `orka.outputs`)
4. **`{{today}}`, `{{now}}`, `{{run_id}}`** — runtime builtins

Unresolved placeholders at execution time produce a hard error with the full list of unknowns. They are not silently passed through.

---

## Round-trip semantics

### Read (SKILL.md → canvas)

```
1. Parse frontmatter.
2. If orka.schema > 1, error "unsupported schema version, upgrade Orka".
3. Scan body for exactly one `<!-- orka:graph vN ... -->` block.
4. If present and proseHash matches → rebuild canvas from graph block (authoritative).
5. If present but proseHash mismatches → render canvas from graph, show drift banner.
6. If absent → treat as a single-node `agent` pipeline (prompt = body text).
   Show banner: "This skill has no graph structure. Use orka-skill-builder to add one."
```

### Write (canvas → SKILL.md)

Two modes, triggered separately:

**Autosave (implicit, on every canvas edit)**:
- Re-emit the graph block in place (in-place edit of the comment region)
- Re-compute and store proseHash of the current body (with the block stripped)
- Prose body is NOT rewritten — if it was skeleton-generated, it stays skeleton; if user polished it, polish survives
- Only one change: the comment block

**Polish prose (explicit, user clicks "Polish prose")**:
- Call Claude with: "here is the DAG, rewrite the prose body so a human reading it knows what to do manually"
- Replace the body's `## Steps` section (and optionally the H1 + intro)
- Re-compute proseHash and store it in the block

### Drift detection (on every load)

```
stored_hash = block.proseHash
current_hash = sha256(body_with_block_stripped())
if stored_hash != current_hash:
  → show drift UI
  → options: keep graph / regen prose / re-derive graph from prose (AI-assisted)
```

### Sub-skill cycle detection

Before writing, walk the graph following `skill_ref.skill` values through the scanner. If a cycle is found (A → B → A), mark offending nodes with a `"cycle": true` flag and refuse to save until resolved. Runtime carries a call-stack and errors on cycle re-entry regardless.

---

## Example: atomic skill (no graph)

No `orka:graph` block. Pure prose. This is how users will hand-write simple skills. Orka reads it as a single-node pipeline.

```markdown
---
name: summarize-folder
description: Summarize the contents of a folder into 10 bullet points.
allowed-tools: Read
orka:
  schema: 1
  inputs:
    - name: folder
      default: "~/Documents/notes"
---

# Summarize folder

Read all markdown files under `{{folder}}` and produce a 10-bullet summary.
Focus on recurring themes. Return ONLY the bullet list.
```

On import: Orka treats this as a single-node `agent` pipeline with the body text as prompt. To add graph structure, use the `orka-skill-builder` meta-skill in Claude Code.

---

## Example: composite skill (DAG)

See `docs/examples/morning-briefing/SKILL.md` (to be added in W1).

---

## Versioning

- `orka.schema` is the spec version
- Current: **1**
- Breaking changes bump the number
- Orka parsers MUST refuse to read a higher schema than they understand
- The `orka:graph vN` tag in the comment block MUST match `orka.schema`

When we ship schema 2, every existing skill file remains readable by the schema-2 parser (it declares `orka.schema: 1`). The parser dispatches on that.

---

## What this format is NOT

- **Not a generic workflow DSL** — specifically tuned for DAGs of LLM skill invocations. Don't encode business rules, control flow, or conditional branching here; write them as prose the LLM executes.
- **Not a replacement for code** — if a step is "run a shell command", emit an `output` node with `destination: shell`, don't try to model arbitrary code.
- **Not multi-language** — prose is the primary execution surface, and prose is LLM-dependent. The LLM's language is the skill's language.

---

## Reserved fields (do not use)

The following frontmatter keys are reserved for future use and MUST NOT be used in user skills:

- `orka.permissions`
- `orka.cost_cap`
- `orka.retry`
- `orka.secrets`

---

## Open questions

Tracked for schema v2:

1. Should `kb` nodes be modeled as `skill_ref` to a synthetic "read-kb" skill? Would simplify.
2. Should `output` nodes move out of the graph into a top-level `outputs:` array, separating flow from side effects?
3. Should skill invocation support streaming partial outputs into placeholders?
4. Should we support branching (if/else) or keep it LLM-prose?
