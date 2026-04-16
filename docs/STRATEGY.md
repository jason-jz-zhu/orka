# Orka — Strategy

Competitive positioning, business model, and go-to-market.
Internal document — not published in the repo README.

---

## Positioning

Orka is the **visual management layer for the Claude Code skill ecosystem**.

Users create skills by chatting with AI. Orka browses, edits, schedules,
runs, and observes those skills. The primary authoring surface is Claude
Code — Orka is the control plane, not the creation tool.

---

## Competitive Landscape

### Direct threat (watch closely)

| Competitor | Why it matters | Orka's advantage |
|-----------|---------------|-----------------|
| **Anthropic Routines** (launched 2026-04-14) | Cloud cron for Claude prompts. Pro 5/day, Max 15/day. | Orka adds: visual canvas, Mac-native output, cross-session observe, multi-step DAG |
| **Gumloop** | YC-backed AI workflow builder, credit-metered | Zero marginal cost (rides Max sub); local I/O surface |
| **Raycast AI** | Mac dev mindshare, command-bar + AI | Not a pipeline/scheduling surface; potential integration partner |
| **Apple Shortcuts + AI** | Free, ships with macOS, "Use Model" action | Weak model (not Claude); no skill authoring; limited branching |

### Indirect (different market segment)

| Competitor | Segment | Why not a threat |
|-----------|---------|-----------------|
| Zapier / Make | SaaS-to-SaaS integration | No LLM depth, no local I/O |
| n8n | Self-hosted DevOps workflows | Server-side, not desktop; node-coded not conversational |
| Lindy.ai | "AI employees" for non-technical users | Different persona; Orka's user has a terminal open |
| Relay.app | Team approval workflows | Team-centric; Orka is single-user first |
| Dify / Flowise / LangFlow | LLM app builders for developers | Building chatbot products, not automating daily tasks |
| Rivet | Desktop prompt-graph IDE | Dev tool for embedding; no scheduler, no Mac I/O |

---

## Structural Moat (ranked by durability)

### Durable (2+ years)

1. **Zero marginal cost** — Orka runs on the user's existing Claude Max
   subscription. Every SaaS competitor charges per-run or per-credit.
   Holds as long as Anthropic sells flat-rate plans.

2. **Mac-native I/O surface** — Apple Notes (JXA), iCloud Drive,
   Shortcuts, shell, webhooks. SaaS competitors physically cannot reach
   these without installing an agent on the user's Mac — and shipping
   an agent means becoming Orka.

3. **Cross-vendor skill format** — SKILL.md is an open standard adopted
   by Anthropic and OpenAI Codex. Orka is the only visual editor for
   this standard. Neither vendor will build a canvas (Anthropic ships
   CLIs; OpenAI ships chat UIs).

### Compounding

4. **Flywheel effect** — the user's skill library grows with every
   conversation. Each new skill makes the next composite faster to
   create (the meta-skill reuses existing atoms). Switching away means
   rebuilding from scratch.

### Eroding (6-12 months)

5. **Mac-only + single-user** — fine now (ICP is on Macs), but team
   use cases will eventually require shared pipelines and secrets.

6. **CLI surface instability** — Anthropic can change the `claude` CLI's
   JSONL output format. Mitigated by the `skill_md` parser module with
   fixture tests, but remains a quarter-to-quarter risk.

---

## Anthropic Platform Risk

Anthropic shipped Routines on 2026-04-14. If they add a visual canvas
to Claude Desktop, Orka's moat narrows to:

- Mac-native output destinations (they won't do JXA/Shortcuts)
- Cross-session observability dashboard (that's a product, not an SDK)
- Cross-vendor skill format (they won't support Codex)

**Defensive wedge**: position Orka as the layer ABOVE Routines, not
competing with it. If Anthropic ships a scheduler, Orka can use it
under the hood and add the management UI on top.

---

## Business Model

### Phase 1: Free (now through ~500 users)

Open-source core, signed DMG. Maximize distribution and feedback.

### Phase 2: $29 one-time "Orka Pro"

Unlocks:
- Run history beyond 7 days (Pro: 90 days)
- Encrypted destination secrets vault (macOS Keychain)
- Priority update channel
- Skill marketplace publishing rights (future)

Why one-time, not subscription: users just paid Anthropic $200/month.
A second monthly charge feels parasitic. One-time buy matches the
Mac indie-app mental model (Alfred, Sublime Text, 1Password v7).

License verification is offline (Ed25519 signed key, embedded public
key in binary). No phone-home. Fulfillment via Gumroad or Polar.sh.

### Phase 3: $12/user/month "Orka Teams" (only if asked 10+ times)

Shared pipeline library, centralized secrets, per-user run history,
SSO. Requires a server component — do not build until demand is proven.

---

## Target User

**A developer or power user who has a terminal open, pays for Claude
Max, and runs Claude Code daily.** They have 5-15 things they manually
ask Claude to do every day/week and wish those ran automatically.

They are NOT:
- Non-technical knowledge workers (Lindy's segment)
- DevOps engineers building CI/CD (n8n/Windmill segment)
- Developers building LLM products (Dify/Flowise segment)

---

## Go-to-Market (v0.2 Launch)

### Distribution channels

1. **Hacker News** — "Show HN: Orka — visual editor for Claude Code skills"
2. **Twitter/X** — 90s demo video (Morning Briefing)
3. **Reddit** — /r/ClaudeAI, /r/macapps
4. **Claude Code community** — Discord, GitHub discussions
5. **SKILL-FORMAT.md as standalone content** — "We made Claude skills
   executable by both LLMs and a visual canvas" (technical blog post)

### The 90-second demo

Morning Briefing pipeline. Before/after framing:

- 0-5s: Yesterday — manual Claude session, 14 minutes of copy-paste
- 5-20s: Orka Studio — drag 3 skill nodes, connect, schedule daily 7am
- 20-40s: Close app. Fast-forward: "Next morning, 7:01 AM"
- 40-70s: Apple Notes has the briefing. WeChat got it too. Runs tab: 43s, $0.00
- 70-90s: "Every day. Zero touches. Runs on your Claude subscription."

This demo is unfakeable by SaaS competitors — they can't write to Apple
Notes and they can't show "$0.00 cost."

---

## 60-Day Priority Stack (decided 2026-04-15)

| Week | Deliverable | Status |
|------|------------|--------|
| 1 | SKILL.md parser (parse + write + hash) | Done |
| 2 | Skill scanner + SkillRefNode + Palette | Done |
| 3 | Two-way SKILL.md sync (canvas ↔ file) | Done |
| 4 | `orka-cli run` + run history logging | Done |
| 5 | Runs dashboard + curated templates | Done |
| 6 | Signed DMG + Pro licensing + launch | Pending (external deps) |

### Killed (do not build in v0.2)

- Windows/Linux port
- Skill marketplace
- Browser extension trigger
- ChatGPT/Claude.ai ZIP importers
- AI distillation in-app (meta-skill handles this)
- Rust-native topo-sort executor (delegate to `claude -p`)
- Drift 3-way diff UI (simple banner is enough)
- "Polish prose" AI rewrite
