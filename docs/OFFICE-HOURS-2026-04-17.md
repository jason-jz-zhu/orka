# Orka Office-Hours — 2026-04-17

> YC Office Hours · Startup mode · 6 forcing questions
> Saved at Phase 4 (pre-alternatives). Revisit after 2 weeks of dogfood.

---

## Problem framing

The founder is building **Orka** — a macOS Tauri app that wraps the local `claude`
CLI and turns repeated Claude Code skills into scheduled, observable, persistent
pipelines with native Mac output (Apple Notes, iCloud, webhook, shell).

Founder is simultaneously aiming Orka as:
1. An indie Mac product ($49 one-time + open-source core)
2. A lead magnet for a forthcoming AI-consulting business (6–12 months out)

---

## Phase 2A diagnostic — six forcing questions

### Q1 · Demand Reality

**Ask:** Strongest evidence someone is genuinely upset if Orka disappears.

**Answer:** *"不好说"* — path: launch on HN + collect GitHub stars + hope for
DMs / influencer retweet.

**Critique:** Stars are vanity; waitlist-equivalent. No identified user is
currently running scheduled Claude work the way Orka solves. **Demand is
unproven.**

### Q2 · Status Quo

**Ask:** What are real users doing *right now* to solve this, even badly?

**Answer (after pushback):** Three identifiable Claude Code users — **all of
them run `claude` manually in a REPL.** None are scheduling, none are using
cron, none are fighting with AppleScript.

**Critique:** This is the red-flag answer in Q2 — *"no one is hacking a
solution"* often means the problem isn't painful enough. In plainer English:
**"automated Claude skills on Mac" isn't an unmet pain in the founder's
network.** It's an imagined pain.

### Q3 · Desperate Specificity

**Ask:** One named human whose life changes if Orka exists.

**Answer:** **The founder.** Specifically: every week they spend ~X hours on
engineering maintenance routines — QA / security / dependency audit / code
review — that are automatable.

**This is the strongest answer in the session.** The founder can email
themselves. They know the workflow. The pain is real and recurring.

### Q4 · Narrowest Wedge (revised)

**Ask (first):** What single skill would you pay $30 for?

**Answer:** *"None — $30 for a single skill is too much; I want several that
are **customized to me**."*

**Ask (revised):** What's the platform price?

**Answer:** **$49 one-time + open-source core + Pro features** (Keychain,
scheduler, failure notifications, export). Matches mature Mac indie economics
and lead-magnet strategy.

### Q5 · Observation & Surprise

Skipped — no live users to observe.

### Q6 · Future-Fit (3-year horizon)

**Ask:** If Raycast ships cron + Anthropic ships Routines + Apple Shortcuts
gets a native Claude action — why would anyone still install Orka?

**Answer:** *"说不好 — 要看接下来一年有人用没."*

**Critique:** Honest, but a moat gap. No durable 3-yr thesis. Mitigation:
decide in year 1 based on observed user behavior, not pre-commit.

---

## Phase 3 · Premise challenge

| Premise | Verdict | Impact |
|---|---|---|
| P1: Narrow target to "senior devs / tech leads with codebases" | ❌ **Rejected** | Keep marketing wide; any recurring Claude user |
| P2: Value unit = framework, not pre-packaged skill library | ✅ Agreed | Tagline: *"Turn repeated Claude workflows into a library"* |
| P3: Dogfood 2 weeks with ≥3 personal weekly routines before launch | ✅ Agreed | Without personal "I saved X hours" data, launch is empty |

### Unresolved tension

The founder wants to keep the target user **wide** but has only **one
specific user** (themselves, doing engineering routines).

**Resolution policy for v1.0:**

- **Product scope: wide.** Any Claude skill, any destination.
- **Marketing scope: wide.** *"Orka is the orchestration layer for AI skills
  on macOS."*
- **Case study / demo scope: narrow.** Every hero screenshot, video, and blog
  post leads with the founder's own weekly engineering routines (security
  audit, dep update, dead code scan, changelog). Proof-by-dogfood, not
  proof-by-persona.

---

## Current working story

> **Orka — macOS orchestration layer for AI skills.**
>
> Turn the Claude Code workflows you run every week into a personal library.
> Write a skill once, schedule it, pipe its output to Apple Notes, iCloud,
> webhooks, or any shell command. Runs on your local `claude` CLI and your
> Max subscription — zero marginal LLM cost.
>
> $49 one-time · open-source core · built on Tauri 2 + Rust

---

## Action items (2-week plan before launch)

### Week 1 — dogfood + evidence

- [ ] Ship 3 personal weekly skills inside Orka, running on the founder's own
      schedule (Fri 08:00 each):
  - [ ] `weekly-security-audit` — wraps existing CSO-style workflow
  - [ ] `weekly-dep-update` — scans `cargo` + `npm` for CVE / breaking changes
  - [ ] `weekly-code-review-digest` — summarizes the week's commits
- [ ] Record metrics: wall-clock time saved per week, failure rate, manual
      override count.
- [ ] Screenshot each output delivered to Apple Notes.

### Week 2 — proof artifacts + launch prep

- [ ] Write a "how I use Orka" blog post referencing the 2-week data.
- [ ] Refactor demo video v7 to use founder's real eng routines (not
      imagined Apple-Notes-first personas).
- [ ] Rewrite README hero copy:
      *"Orka — turn your repeated Claude workflows into a library. macOS
      native. Runs on your Max plan."*
- [ ] Finish `/cso` re-run to verify security hardening pre-launch.
- [ ] Apple Developer signing ($99) + notarization.

### Launch week

- [ ] HN post with the 2-week dogfood data as the hook.
- [ ] Twitter thread with GIFs of each of the 3 real skills running.
- [ ] Landing page at `jiazhenzhu.com/lab/orka` — "Book a setup call" as
      secondary CTA (consulting funnel).

---

## Success signals for 60 days post-launch

Pick one; don't dilute:

- **Primary (consulting thesis):** 3+ inbound DMs asking for paid setup help.
- **Secondary (SaaS viability check):** 20+ real installs + 2nd-week activity.
- **Tertiary (signal-of-reach):** 1 influencer retweet / linked from a
  high-signal dev newsletter.

If 0 of the above after 60 days: the "wide user base" premise is also wrong —
time to re-run office-hours and narrow to a single persona (most likely the
senior-dev persona that was rejected today).

---

## Open questions / gaps to revisit

1. **3-year moat:** Unresolved. Re-ask after observing which user-type
   actually installs.
2. **Pricing test:** $49 is a guess anchored to Mac indie norms. Verify with
   the first 20 paying users.
3. **Beachhead persona vs wide target:** If dogfood shows the skills that
   resonate are *all* eng-maintenance, the product will narrow itself to
   P1 (rejected today) organically.
4. **Canvas vs list UX:** Keep canvas but default landing = skill list
   (per prior agent-team recommendation). Re-evaluate after 2-week dogfood.

---

*Saved automatically by `/office-hours`. Next step: run `/plan-ceo-review` to
lock in scope, or `/plan-devex-review` to audit the developer experience
before the dogfood sprint begins.*
