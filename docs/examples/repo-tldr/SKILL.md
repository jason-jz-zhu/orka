---
name: repo-tldr
description: >
  Read a local directory or git repo and write a 5-bullet TL;DR covering
  what it is, who it's for, how to run it, the main tradeoffs, and one
  thing a new contributor should know. Use for "summarize this repo",
  "what does this project do", or when you open an unfamiliar codebase.
allowed-tools: Read, Bash, Grep
examples:
  - "Summarize ~/code/some-oss-project in plain English"
  - "TL;DR for the repo at ./"
  - "Read ~/Downloads/homebrew-cask and tell me what it is and whether it's active"
orka:
  schema: 1
  inputs:
    - name: path
      default: "."
      description: "Directory or git repo to summarize"
    - name: depth
      default: "2"
      description: "Max directory depth to scan when listing files"
---

# Repo TL;DR

You are summarizing an unfamiliar codebase for a brand-new contributor.
Read the indicated directory carefully and produce a tight, honest
overview. No hand-waving, no marketing copy.

## Steps

1. **Orient** — `ls -la {{path}}` and `find {{path}} -maxdepth {{depth}} -type f`.
   Read these first if present: `README.md`, `package.json`, `Cargo.toml`,
   `go.mod`, `pyproject.toml`, `setup.py`, `Makefile`, `justfile`.
   Prefer `git -C {{path}} log --oneline -10` for recency.

2. **Read the entry points** — pick the 2–3 files that look most central
   (`index.ts`, `main.rs`, `src/lib.rs`, `app.py`, `server.js`…) and skim
   them. Don't read everything; you're writing a TL;DR, not a review.

3. **Write exactly 5 bullet points, each ≤25 words**:
   - **What it is**: one sentence naming the thing
   - **Who it's for**: intended audience or use case
   - **How to run**: the single most common command
   - **Main tradeoffs**: one thing it's good at, one it isn't
   - **First contributor note**: one gotcha or where to start reading

4. **Be honest**. If the repo looks abandoned, say so (last commit date).
   If the README oversells, call it out. If you couldn't determine
   something, write "(unclear from repo contents)" instead of guessing.

## Style

- No marketing filler: ban "leverage", "robust", "seamless", "best-in-class".
- Cite file paths when it helps: *"entry point is `src/main.rs:12`"*.
- Present tense. Active voice. Short sentences.
- Total output target: ~150 words.
