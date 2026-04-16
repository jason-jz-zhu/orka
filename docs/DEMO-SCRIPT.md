# Demo Recording Script — "Daily Digest" (90 seconds)

## Setup before recording

1. **Start Orka**: `npm run tauri dev`
2. **Ensure demo skill is installed**: `ls ~/.claude/skills/demo-daily-digest/`
3. **Have some files in ~/Documents** that were modified recently (any markdown/text files)
4. **Open Apple Notes** and delete any existing "Orka Daily Digest" note (so the demo creates a fresh one)
5. **Screen recording tool**: Cmd+Shift+5 (macOS built-in) or OBS. Record at 1920x1080 or 2560x1440.
6. **Clean the canvas**: In Orka, click + New to start with a blank canvas

## Recording

### Scene 1 — The Problem (0:00 - 0:08)

**Show**: A Claude Code terminal with a previous session visible.

**Action**: Scroll through a long manual session where you asked Claude to summarize files, then manually copy-pasted the result into Notes.

**Text overlay**: `Yesterday. 14 minutes of manual work.`

> Tip: If you don't have a real session, just open Claude and type
> "summarize ~/Documents" — let it run briefly, then stop. The scrollback
> is enough to show "this was manual and tedious."

---

### Scene 2 — Build it in Orka (0:08 - 0:30)

**Show**: Orka Studio tab, blank canvas.

**Action (step by step, do slowly so viewers can follow)**:

1. Click **+ Agent** in toolbar → node appears
   - Type in prompt box: `List files in ~/Documents modified recently, read the top 5`
   
2. Click **+ Agent** again → second node appears
   - Type: `Summarize into 5 bullet points, under 150 words`
   
3. Click **+ Output** → output node appears
   - Select destination: **Apple Notes**
   - Type note title: `Orka Daily Digest`

4. **Connect the nodes**: drag from Agent 1's right handle → Agent 2's left handle. Then Agent 2 → Output.

5. **Click ▶ Run All**

**Text overlay**: `Three nodes. One click.`

---

### Scene 3 — Watch it run (0:30 - 0:50)

**Show**: The canvas with nodes running.

**Action**: Just watch. The nodes will show:
- N1: `⋯ running` badge → text starts streaming in
- N2: waits for N1 → then `⋯ running` → streams output
- N3: `⋯ running` → shows "Appended to note 'Orka Daily Digest' in Notes.app"

**Text overlay**: `Runs in 30-60 seconds. Each node streams live.`

> Tip: If the output node says "done", immediately switch to Apple Notes
> to show the result (Scene 4). Don't wait.

---

### Scene 4 — The result (0:50 - 1:05)

**Show**: Split or quick-cut between:

1. **Apple Notes** — the "Orka Daily Digest" note with the formatted summary
2. **Orka Runs tab** — click Runs tab, show the run record:
   - skill: (unsaved) or demo-daily-digest
   - status: ok
   - trigger: manual
   - duration: ~45s

**Text overlay**: `Apple Notes updated. Run logged. Cost: $0.`

---

### Scene 5 — Schedule it (1:05 - 1:20)

**Show**: Back to Studio tab.

**Action**:
1. Click **+ Save** in the Pipelines panel → name it "Daily Digest"
2. Click the **clock icon** next to "Daily Digest" in the pipeline list
3. In the Schedule modal, select **Daily** → set time to **7:00 AM**
4. Click Save

**Text overlay**: `Schedule it. Every morning at 7am.`

---

### Scene 6 — The payoff (1:20 - 1:30)

**Show**: Close the app (Cmd+Q or click the red button).

**Text overlay** (big, centered, fade in):

```
Every day. Zero touches.
Runs on your Claude subscription.
```

**Second line** (smaller, fade in after):

```
orka.dev
```

---

## Post-production notes

- **No voiceover needed** — text overlays tell the story. Add subtle background music if you want (lo-fi, low volume).
- **Speed up** Scene 3 (the waiting part) to 2-4x so it doesn't drag.
- **Total runtime target**: 60-90 seconds. Cut aggressively.
- **Key frame to nail**: the moment Apple Notes shows the digest. That's the "aha" — this app just wrote to my Notes without me doing anything.

## The one thing competitors can't fake

This demo shows two things no SaaS competitor can reproduce:
1. **Apple Notes output** — cloud tools can't write to Notes.app
2. **$0 cost** — the run uses the user's existing Claude Max subscription. No per-run billing.

If you film exactly this, it's unfakeable social proof.
