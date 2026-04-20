import { useEffect, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import type { SkillMeta } from "../lib/skills";

export type SkillTrustState = {
  slug: string;
  currentHash: string | null;
  storedHash: string | null;
  trusted: boolean;
  skillMdPath: string | null;
};

type SkillPermissions = {
  slug: string;
  declaredTools: string[] | null;
  runsUnrestricted: boolean;
  inputs: Array<{
    name: string;
    type: string;
    default: string | null;
    description: string | null;
  }>;
  detectedActions: string[];
  workingDir: string;
};

type Props = {
  skill: SkillMeta;
  /** Result of check_skill_trust — tells us which variant to render. */
  trustState: SkillTrustState;
  /** Called after the user reviews + clicks Trust & run. The modal has
   *  already persisted the hash via trust_skill. */
  onApprove: () => void;
  onCancel: () => void;
};

/**
 * First-run / hash-changed consent modal for skills.
 *
 * Orka runs skills by shipping the SKILL.md's instructions to `claude -p`,
 * which means whoever controls that file controls what happens on disk
 * under the run's cwd. This modal is the user's one chance to look at the
 * contents before approving — especially important for tap-installed
 * skills whose upstream can be rewritten.
 *
 * On Approve we persist the current SHA-256 via trust_skill, so
 * subsequent runs go straight through until the file changes again.
 */
export function SkillTrustModal({
  skill,
  trustState,
  onApprove,
  onCancel,
}: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const [perms, setPerms] = useState<SkillPermissions | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);

  const variant = trustState.storedHash ? "changed" : "first-run";

  // Parallel fetch: parsed permissions (authoritative — from frontmatter +
  // heuristic body scan) AND raw SKILL.md contents (shown in a collapsed
  // panel for users who want to read the full instructions).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const jobs: Array<Promise<unknown>> = [];
      jobs.push(
        invokeCmd<SkillPermissions>("get_skill_permissions", {
          slug: skill.slug,
        })
          .then((p) => {
            if (!cancelled) setPerms(p);
          })
          .catch(() => {
            if (!cancelled) setPerms(null);
          }),
      );
      if (trustState.skillMdPath) {
        jobs.push(
          invokeCmd<string>("read_file_text", {
            path: trustState.skillMdPath,
          })
            .then((text) => {
              if (cancelled) return;
              const MAX = 8 * 1024;
              setPreview(
                text.length > MAX
                  ? text.slice(0, MAX) +
                      `\n\n… (${text.length - MAX} more bytes — open the path above in your editor for the full file)`
                  : text,
              );
            })
            .catch(() => {
              if (!cancelled) setPreview(null);
            }),
        );
      }
      await Promise.all(jobs);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [skill.slug, trustState.skillMdPath]);

  async function approve() {
    if (approving) return;
    setApproving(true);
    try {
      await invokeCmd("trust_skill", { slug: skill.slug });
      onApprove();
    } catch (e) {
      setApproving(false);
      // Surface failure inline rather than alert — modal stays open.
      setPreview(
        (preview ?? "") + `\n\n✗ Failed to record trust: ${String(e)}`,
      );
    }
  }

  const shortHash = (h: string | null) =>
    h ? h.slice(0, 12) + "…" + h.slice(-4) : "—";

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-box skill-trust"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">
              {variant === "first-run"
                ? "🔒 Trust this skill?"
                : "⚠️ SKILL.md changed"}
            </div>
            <div className="modal-subtitle">
              {variant === "first-run"
                ? `First run of ${skill.slug}. Review what it will do, then approve.`
                : `The SKILL.md for ${skill.slug} has changed since you last trusted it.`}
            </div>
          </div>
          <button className="modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="skill-trust__meta">
          <div className="skill-trust__meta-row">
            <span className="skill-trust__meta-label">slug</span>
            <code className="skill-trust__meta-val">{skill.slug}</code>
          </div>
          {skill.description && (
            <div className="skill-trust__meta-row">
              <span className="skill-trust__meta-label">description</span>
              <span className="skill-trust__meta-val">{skill.description}</span>
            </div>
          )}
          {trustState.skillMdPath && (
            <div className="skill-trust__meta-row">
              <span className="skill-trust__meta-label">path</span>
              <code className="skill-trust__meta-val skill-trust__path">
                {trustState.skillMdPath}
              </code>
            </div>
          )}
          <div className="skill-trust__meta-row">
            <span className="skill-trust__meta-label">current hash</span>
            <code className="skill-trust__meta-val">
              {shortHash(trustState.currentHash)}
            </code>
          </div>
          {variant === "changed" && (
            <div className="skill-trust__meta-row">
              <span className="skill-trust__meta-label">previously trusted</span>
              <code className="skill-trust__meta-val skill-trust__meta-val--muted">
                {shortHash(trustState.storedHash)}
              </code>
            </div>
          )}
        </div>

        <div className="skill-trust__perms">
          <div className="skill-trust__perms-title">
            Permissions this skill will have
          </div>

          {loading && (
            <div className="skill-trust__perms-loading">Analyzing…</div>
          )}

          {!loading && perms && (
            <>
              {/* Declared tool scope — authoritative from frontmatter. */}
              {perms.declaredTools && perms.declaredTools.length > 0 ? (
                <div className="skill-trust__perm-group">
                  <div className="skill-trust__perm-group-label">
                    ✓ Declared tools (frontmatter allowed-tools)
                  </div>
                  <div className="skill-trust__perm-chips">
                    {perms.declaredTools.map((t) => (
                      <code key={t} className="skill-trust__chip">
                        {t}
                      </code>
                    ))}
                  </div>
                </div>
              ) : perms.runsUnrestricted ? (
                <div className="skill-trust__perm-group skill-trust__perm-group--warn">
                  <div className="skill-trust__perm-group-label">
                    ⚠ Unrestricted — no allowed-tools declared
                  </div>
                  <div className="skill-trust__perm-note">
                    Claude will have full Claude Code access under the cwd:
                    Read, Edit, Write, Bash, Glob, Grep, WebFetch, and any MCP
                    tools you've configured. To restrict this, add an
                    <code> allowed-tools:</code> line to the SKILL.md
                    frontmatter.
                  </div>
                </div>
              ) : (
                <div className="skill-trust__perm-group">
                  <div className="skill-trust__perm-group-label">
                    · No tool usage detected
                  </div>
                  <div className="skill-trust__perm-note">
                    This skill appears to be prose-only. Claude will still
                    have full tool access if the frontmatter doesn't restrict
                    it — just nothing in the body clearly invokes tools.
                  </div>
                </div>
              )}

              {/* Heuristic action detection — transparency layer. */}
              {perms.detectedActions.length > 0 && (
                <div className="skill-trust__perm-group">
                  <div className="skill-trust__perm-group-label">
                    Likely actions (detected from prose)
                  </div>
                  <ul className="skill-trust__perm-list">
                    {perms.detectedActions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Working directory — blast radius. */}
              <div className="skill-trust__perm-group">
                <div className="skill-trust__perm-group-label">
                  Working directory
                </div>
                <code className="skill-trust__perm-cwd">{perms.workingDir}</code>
                <div className="skill-trust__perm-note">
                  Files outside this directory require an explicit{" "}
                  <code>--add-dir</code>. By default, Claude can only touch
                  paths under this root.
                </div>
              </div>

              {/* Expected inputs — the user-supplied values. */}
              {perms.inputs.length > 0 && (
                <div className="skill-trust__perm-group">
                  <div className="skill-trust__perm-group-label">
                    Inputs the skill expects from you
                  </div>
                  <ul className="skill-trust__perm-list">
                    {perms.inputs.map((i) => (
                      <li key={i.name}>
                        <code>{i.name}</code>
                        <span className="skill-trust__perm-input-type">
                          {" "}({i.type}){i.default ? ` · default: ${i.default}` : ""}
                        </span>
                        {i.description && (
                          <div className="skill-trust__perm-input-desc">
                            {i.description}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {!loading && !perms && (
            <div className="skill-trust__perms-loading">
              Couldn't analyze permissions — the raw SKILL.md is below for
              manual review.
            </div>
          )}
        </div>

        <button
          className="skill-trust__show-full"
          onClick={() => setShowFull((v) => !v)}
        >
          {showFull ? "▾ Hide raw SKILL.md" : "▸ Show raw SKILL.md"}
        </button>
        {showFull && (
          <pre className="skill-trust__preview">
            {preview ?? "(could not read SKILL.md — did it move?)"}
          </pre>
        )}

        <div className="skill-trust__hint">
          {variant === "first-run" ? (
            <>
              Approval is remembered via SHA-256. If SKILL.md changes later
              you'll see this prompt again, showing both the old and new
              hashes.
            </>
          ) : (
            <>
              Someone (or something) modified this file since you last
              trusted it. Read the diff in your editor — the hash check
              won't save you if you approve a malicious change.
            </>
          )}
        </div>

        <div className="skill-trust__actions">
          <button className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn--primary"
            disabled={approving || !trustState.currentHash}
            onClick={() => void approve()}
          >
            {approving
              ? "Trusting…"
              : variant === "first-run"
                ? "Trust & run"
                : "Accept changes & run"}
          </button>
        </div>
      </div>
    </div>
  );
}
