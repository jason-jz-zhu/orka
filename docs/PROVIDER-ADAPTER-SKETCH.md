# ProviderAdapter — design sketch (backlog)

Status: **not implemented, ship first**. Revisit after the current
Claude-only feature set is in users' hands.

## Why

Orka today hardcodes `claude` CLI subprocess calls in `node_runner.rs`.
Everything downstream — the skill-run event stream shape, `--resume`
session continuity, `/<slug>` invocation, the tool-use model — is
Claude-specific. A user who wants to run prose-only skills on GPT / a
local Ollama model / Codex can't.

Goal of this work: let the same SKILL.md execute against any provider
that can stream completions. Claude-specific tool use (bash/edit/mcp)
stays Claude-only on purpose — porting function-calling shapes across
four providers is a quagmire and strictly worse than Claude Code's
native tools.

## Scope (v1 of this feature)

In:
- Prose skill execution (no tool calls in body)
- Streaming text output
- Session continuation — real `--resume` on providers that support it,
  fall-back-to-sending-history-inline on providers that don't
- Per-feature provider selection, reusing the existing
  `model_config.rs` per-feature picker

Out:
- Porting tool use (bash, edit, mcp, etc.) to non-Claude providers
- A universal tool framework
- Automatic skill rewriting when switching providers

## Core types

```rust
// src-tauri/src/provider/mod.rs (proposed)

pub trait ProviderAdapter: Send + Sync {
    /// Stable id used in config + UI — "claude", "openai", "ollama", …
    fn id(&self) -> &str;

    /// Capability probe. UI uses this to label skills
    /// ("works everywhere" vs "Claude-only") and gray out pickers.
    fn supports(&self, cap: Capability) -> bool;

    /// Run a prompt. Streams tokens + events via `tx` as they arrive.
    /// Returns a handle the caller can feed back in `RunRequest.resume`
    /// for a follow-up turn. `None` = this provider is stateless.
    async fn run(
        &self,
        req: RunRequest,
        tx: UnboundedSender<StreamEvent>,
    ) -> Result<RunOutcome, RunError>;
}

pub enum Capability {
    ToolUse,        // bash, edit, mcp — Claude-only for v1
    SessionResume,  // real server-side resume
    StreamingJson,  // structured events, not just plain text
    MultiModal,     // images / files
}

pub struct RunRequest {
    pub prompt: String,
    pub model: String,                  // provider-specific model id
    pub resume: Option<String>,         // opaque session handle
    pub history: Option<Vec<Turn>>,     // fallback when resume unsupported
    pub workdir: PathBuf,               // cwd for tool calls / file ops
}

pub enum StreamEvent {
    Text(String),
    ToolCall  { name: String, args: serde_json::Value },
    ToolResult { output: String },
    Error(String),
}

pub struct RunOutcome {
    pub session_handle: Option<String>,
    pub cost_usd: Option<f64>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
}
```

## Adapters to ship

### ClaudeAdapter

Thin shim over the existing `node_runner::run_claude`. No new subprocess
logic; just translate `RunRequest` → current args and forward stream
events through the unified `StreamEvent` shape. This adapter keeps
`supports(ToolUse) = true`.

### OpenAICompatibleAdapter

Covers OpenAI, Codex, Ollama (via `/v1/chat/completions`), llama.cpp
server, vLLM, LM Studio — anything that speaks the OpenAI chat API.

- Endpoint + key per-adapter-instance (so "openai-gpt5" and
  "ollama-local" can coexist).
- POST `/v1/chat/completions` with `stream: true`, parse SSE lines,
  emit `StreamEvent::Text` per delta.
- No server-side resume. Set `supports(SessionResume) = false` and use
  `RunRequest.history` to replay prior turns inline each call.
- `supports(ToolUse) = false` for v1 — function-calling is on the
  roadmap but not scoped here.

## Integration into the existing code

1. Wire a registry: `Arc<dyn ProviderAdapter>` map keyed by `id()`,
   populated at startup from user-configured provider list.
2. Extend `model_config.rs` with a `provider` field per feature.
   Legacy configs without the field default to `provider: "claude"` —
   no migration required.
3. Rename `node_runner::run_claude` → `node_runner::run_skill` that
   resolves the adapter from `model_config.skillRun.provider` and
   dispatches. The Claude path becomes one branch, not the default.
4. Generalize `claude_gate`'s concurrency semaphore into a per-provider
   gate (each provider has its own rate-limit constraints).
5. UI: `SkillTrustModal` already surfaces "detected actions" via the
   `detect_risky_actions` heuristic. Reuse that signal to tag skills
   `claude-only` in the Skills list when body uses tools. Users see at
   a glance which skills will and won't run on their chosen provider.

## Config example (post-v2)

```json
{
  "brief":     { "provider": "claude",  "model": "haiku" },
  "synthesis": { "provider": "claude",  "model": "claude-opus-4-7[1m]" },
  "skillRun":  { "provider": "openai",  "model": "gpt-5" },
  "evolution": { "provider": "ollama",  "model": "llama3.3:70b" }
}
```

## Open questions

- **Credentials storage.** Options: env vars (simplest, user-hostile),
  `~/.orka/credentials.toml` with 0600 perms, macOS Keychain. Probably
  Keychain on Mac, file with 0600 perms elsewhere.
- **Cost tracking.** Claude CLI reports cost in the terminal `result`
  event. OpenAI API returns `usage` per response. Ollama returns
  nothing. `RunOutcome.cost_usd = None` is the honest fallback.
- **Rate limits.** Shared `claude_gate::acquire()` semaphore is
  Claude-scoped. Generalize to a per-provider gate (different providers
  have different limits; you don't want a stuck Ollama job to block
  Claude).
- **Tool use on non-Claude.** Eventually worth doing but not in v1.
  OpenAI's function-calling is mature; Ollama's is new; Codex has yet
  another shape. Track as a separate design doc when we get there.

## Migration path (3 phases, each shippable standalone)

1. **Phase A** — add `ProviderAdapter` trait, implement `ClaudeAdapter`
   as a no-op shim around current code. Prove the abstraction with
   zero user-visible change.
2. **Phase B** — add `OpenAICompatibleAdapter`. Extend model_config
   with `provider` field. UI picker gets a provider dropdown.
3. **Phase C** — skill-compatibility labels in the Skills list
   (`claude-only` badge on tool-using skills). Trust modal's permission
   analyzer already computes the signal.

## Explicit anti-goals

- Don't build a universal tool framework. You will spend months on it
  and end up with something strictly worse than Claude Code's native
  tools.
- Don't try to rewrite SKILL.md on the fly to fit a different provider.
  If a skill uses bash, it uses bash — label it Claude-only and move on.
- Don't let this block main product work. The selling point "your
  workflow outlives any single provider" is worth having, but only
  after the Claude-only version has shipped and has users.

## Trigger for starting

Start this when at least one of:
- Users are asking for it (not just "nice to have" — actual churn risk)
- Anthropic pricing / access becomes a real blocker for a meaningful
  slice of users
- Orka has ≥1000 active users so the multi-provider story gives us
  meaningful market differentiation
