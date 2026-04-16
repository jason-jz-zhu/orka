---
name: meeting-prep
description: >
  Prepare a briefing document before a meeting by gathering context from
  notes and calendar. Use for "meeting prep", "prepare for my meeting", or
  "briefing before standup".
allowed-tools: Read, Write, Bash
orka:
  schema: 1
  inputs:
    - { name: topic, description: "Meeting topic or attendee names" }
    - { name: notes_folder, default: "~/Documents/notes", description: "Folder with relevant notes" }
---

# Meeting Prep

## Steps

1. **Gather context** — search `{{notes_folder}}` for files mentioning "{{topic}}"
2. **Summarize** — distill relevant context into 5 talking points and 3 open questions
3. **Output** — write the briefing to a local file

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"agent","pos":[60,80],"data":{"prompt":"Search all files under {{notes_folder}} for content related to: {{topic}}. Return relevant excerpts with file names."}},
    {"id":"n2","type":"agent","pos":[360,80],"data":{"prompt":"From these excerpts, produce a meeting prep brief:\n- 5 talking points (what I should bring up)\n- 3 open questions (what I need to learn)\n- Key context the other attendees might not know\n\nExcerpts:\n{{n1}}"}},
    {"id":"n3","type":"output","pos":[660,80],"data":{"destination":"local","filename":"meeting-prep.md"}}
  ],
  "edges": [["n1","n2"],["n2","n3"]],
  "stepMap": {"n1":1,"n2":2,"n3":3},
  "proseHash": ""
}
-->
