---
name: demo-daily-digest
description: >
  Summarize recent files in a folder and save the digest to Apple Notes.
  Use for "daily digest", "morning summary", or "summarize my notes".
allowed-tools: Read, Write, Bash
orka:
  schema: 1
  inputs:
    - { name: folder, default: "~/Documents", description: "Folder to scan" }
    - { name: notes_title, default: "Orka Daily Digest", description: "Apple Notes title" }
---

# Daily Digest

## Steps

1. **Scan** — list files in `{{folder}}` modified in the last 48 hours, read their contents
2. **Summarize** — produce a brief digest with 5 bullet points covering key themes
3. **Save** — append the digest to Apple Notes under "{{notes_title}}"

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"agent","pos":[60,100],"data":{"prompt":"List all files under {{folder}} modified in the last 48 hours. Read the most important 5 files and return their key content in a structured summary. If fewer than 5 files changed, read all of them."}},
    {"id":"n2","type":"agent","pos":[420,100],"data":{"prompt":"From the file contents below, produce a daily digest:\n\n- 5 bullet points covering the main themes\n- 1 sentence summary at the top\n- Keep it under 150 words\n\nFile contents:\n{{n1}}"}},
    {"id":"n3","type":"output","pos":[780,100],"data":{"destination":"notes","notesTitle":"{{notes_title}}"}}
  ],
  "edges": [["n1","n2"],["n2","n3"]],
  "stepMap": {"n1":1,"n2":2,"n3":3},
  "proseHash": ""
}
-->
