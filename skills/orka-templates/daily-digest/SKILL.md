---
name: daily-digest
description: >
  Summarize a folder of notes into a daily digest and save to Apple Notes.
  Use when the user says "daily digest", "summarize my notes", or "morning summary".
allowed-tools: Read, Write, Bash
orka:
  schema: 1
  inputs:
    - { name: folder, default: "~/Documents/notes", description: "Folder to scan" }
    - { name: notes_title, default: "Daily Digest", description: "Apple Notes title" }
---

# Daily Digest

## Steps

1. **Scan** — read all markdown files in `{{folder}}` from the last 24 hours
2. **Summarize** — produce a 10-bullet summary covering main themes and action items
3. **Save** — append the summary to Apple Notes under "{{notes_title}}"

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"agent","pos":[60,80],"data":{"prompt":"Read all markdown files under {{folder}} modified in the last 24 hours. List their titles and key content."}},
    {"id":"n2","type":"agent","pos":[360,80],"data":{"prompt":"From the files listed below, produce exactly 10 bullet points: main themes, decisions, and action items.\n\n{{n1}}"}},
    {"id":"n3","type":"output","pos":[660,80],"data":{"destination":"notes","notesTitle":"{{notes_title}}"}}
  ],
  "edges": [["n1","n2"],["n2","n3"]],
  "stepMap": {"n1":1,"n2":2,"n3":3},
  "proseHash": ""
}
-->
