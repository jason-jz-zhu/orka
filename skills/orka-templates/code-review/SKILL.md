---
name: code-review
description: >
  Review recent git changes in a repo for correctness, security, and style.
  Use when the user says "review my code", "check my PR", or "audit recent changes".
allowed-tools: Read, Bash
orka:
  schema: 1
  inputs:
    - { name: repo, default: ".", description: "Path to git repository" }
    - { name: branch, default: "HEAD~3..HEAD", description: "Git range to review" }
---

# Code Review

## Steps

1. **Diff** — run `git diff {{branch}}` in `{{repo}}` to get the changes
2. **Analyze** — review the diff for: correctness bugs, security issues (injection, XSS, secrets), style violations, missing tests
3. **Report** — produce a numbered list of findings with severity (critical/major/minor) and suggested fixes

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"agent","pos":[60,80],"data":{"prompt":"Run `cd {{repo}} && git diff {{branch}}` and return the full diff output."}},
    {"id":"n2","type":"agent","pos":[360,80],"data":{"prompt":"Review this git diff for: correctness bugs, security issues (injection, XSS, hardcoded secrets), style violations, missing tests. For each finding, give: severity (critical/major/minor), file:line, description, and suggested fix.\n\nDiff:\n{{n1}}"}},
    {"id":"n3","type":"output","pos":[660,80],"data":{"destination":"local","filename":"code-review.md"}}
  ],
  "edges": [["n1","n2"],["n2","n3"]],
  "stepMap": {"n1":1,"n2":2,"n3":3},
  "proseHash": ""
}
-->
