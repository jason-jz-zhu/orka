---
name: repo-health-check
description: >
  Deep-scan a local repo and write an actionable health report. Runs
  a high-level TL;DR and a mechanical risk scan in parallel, then
  combines them into a prioritized list of "what to fix first." Use
  when you inherit an unfamiliar codebase, evaluate a third-party
  project before adopting it, or want a quarterly readout on your
  own repo's drift.
allowed-tools: Read, Bash, Grep
examples:
  - "Health check for ~/code/my-side-project"
  - "What's wrong with the repo at ./ ?"
  - "Scan ~/Downloads/homebrew-cask and tell me if it's safe to depend on"
orka:
  schema: 1
  inputs:
    - name: path
      default: "."
      description: "Directory or git repo to analyze"
---

# Repo Health Check

A three-pass audit that combines narrative and mechanical analysis:

1. **TL;DR** — what the repo is and who it's for (via the `repo-tldr` skill)
2. **Red-flag scan** — mechanical checks for staleness, missing CI,
   TODO/FIXME density, and dependency health
3. **Compose report** — merge both into a prioritized, honest health
   readout with ranked action items

The three nodes run as a DAG: step 1 and step 2 execute in parallel;
step 3 waits for both and writes the final report. Output goes to
stdout as markdown (and to `output.md` in the run's workdir).

## Step 2 — Red-flag scan (what to check)

Run these and record each finding:

- **Recency**
  - `git -C {{path}} log -1 --format=%ai` → last commit date
  - Flag 🔴 if older than 365 days, 🟡 if 90–365, 🟢 otherwise
  - `git -C {{path}} branch -a | wc -l` → branch count (just info, not a signal)

- **Documentation drift**
  - `stat -f '%Sm' {{path}}/README.md` (or `stat -c %y` on Linux) → README mtime
  - Flag 🟡 if README is older than newest source file by >180 days

- **CI presence**
  - `ls -la {{path}}/.github/workflows/ 2>/dev/null || true`
  - Flag 🔴 if missing on a repo with >50 source files; 🟢 if present

- **TODO density** (cheap proxy for known debt)
  - `grep -rE "TODO|FIXME|XXX|HACK" {{path}}/src {{path}}/lib 2>/dev/null | wc -l`
  - Report the raw count + a signal: 🟢 <10, 🟡 10–50, 🔴 >50

- **Dependency age** (ecosystem-specific, best-effort)
  - `cat {{path}}/package.json 2>/dev/null | grep -c '"' | head -1` + eyeball major-version pins
  - `cat {{path}}/Cargo.toml 2>/dev/null` → read top-level dep table
  - `cat {{path}}/pyproject.toml 2>/dev/null` / `requirements.txt`
  - Report dep count + flag if you see obvious wildcards (`"*"`, `"^0"`, etc.)

- **Test coverage proxy**
  - `find {{path}} -type f \( -name "*.test.*" -o -name "*_test.rs" -o -name "test_*.py" -o -name "*.spec.*" \) 2>/dev/null | wc -l`
  - Ratio to source files — <5% → 🔴, 5–20% → 🟡, >20% → 🟢

Every finding needs a 🟢/🟡/🔴 tag and a one-line justification. Don't
guess — if a check doesn't apply (e.g. not a JS project → no
package.json), say "N/A" and move on.

## Step 3 — Compose (final output shape)

Write the final report with exactly these sections, in this order:

```markdown
# Repo Health Check — <repo name>

## TL;DR
<repo-tldr output, paraphrased if too long — cap at 5 bullets>

## Signals
| Area | Status | Detail |
|------|--------|--------|
| Recency | 🟢/🟡/🔴 | last commit <date>, <N> days ago |
| Docs drift | … | README last updated <date> |
| CI | … | .github/workflows/ <N> files / missing |
| TODO density | … | <N> TODO/FIXME across src/ |
| Deps | … | <summary>, wildcards: <N> |
| Tests | … | <N> test files / <ratio>% of source |

## Top 3 things to fix (ranked)
1. **<headline>** — <one-sentence why, grounded in a signal above>
2. **<headline>** — <…>
3. **<headline>** — <…>

## Red flags (optional)
Anything that looked "off" but wasn't covered above — abandoned
vendor/, untracked .env in git, `node_modules` committed, etc.
```

## Style rules

- Be honest. If the repo looks healthy, say so — don't invent issues
  to look thorough. "Nothing concerning" is a valid top finding.
- No marketing adjectives ("robust", "state-of-the-art"). Describe
  the repo; don't sell it.
- Cite file paths when it helps (`src/main.rs:12`, `package.json`).
- Cap total output at ~250 words.
- When a check fails or returns nothing useful, write "N/A" — never
  "couldn't determine" (which reads as excuse-making).

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"skill_ref","pos":[60,80],"data":{"skill":"repo-tldr","bind":{"path":"{{path}}"}}},
    {"id":"n2","type":"agent","pos":[60,340],"data":{"prompt":"Scan the repo at {{path}} and report on 6 areas: recency (last git commit date), docs drift (README mtime vs newest source), CI presence (.github/workflows/), TODO density (grep TODO|FIXME|XXX|HACK under src/lib), dep age (package.json / Cargo.toml / pyproject.toml wildcards), and test coverage proxy (ratio of test files to source files). Every area gets a 🟢/🟡/🔴 tag and one-line justification. Skip checks that don't apply (write N/A). Cap at ~120 words."}},
    {"id":"n3","type":"agent","pos":[420,200],"data":{"prompt":"Combine the two inputs below into a health report.\n\nTL;DR:\n{{n1}}\n\nHealth signals:\n{{n2}}\n\nWrite the report using EXACTLY this structure:\n\n# Repo Health Check — <repo name>\n\n## TL;DR\n<5-bullet paraphrase>\n\n## Signals\n<markdown table: Area | Status | Detail>\n\n## Top 3 things to fix (ranked)\n1. **<headline>** — <one-line why, grounded in a signal>\n2. ...\n3. ...\n\n## Red flags (optional)\n<anything not covered above>\n\nRules:\n- Honest. Healthy repo → say so.\n- No marketing adjectives.\n- Total output ≤ 250 words.\n- Write the final markdown to stdout."}}
  ],
  "edges": [["n1","n3"],["n2","n3"]],
  "stepMap": {"n1":1,"n2":2,"n3":3},
  "proseHash": ""
}
-->
