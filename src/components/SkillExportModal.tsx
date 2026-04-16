import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

type Scope = "global" | "project" | "bundle";

type Props = {
  pipelineName: string;
  onCancel: () => void;
  onConfirm: (targetDir: string) => void;
};

export default function SkillExportModal({
  pipelineName,
  onCancel,
  onConfirm,
}: Props) {
  const [scope, setScope] = useState<Scope>("global");
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [bundleDir, setBundleDir] = useState<string>("");

  async function pickProjectRoot() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Pick project root (the folder that contains .claude/)",
    });
    if (typeof picked === "string") setProjectRoot(picked);
  }

  async function pickBundleDir() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Pick folder to place the skill in",
    });
    if (typeof picked === "string") setBundleDir(picked);
  }

  function canConfirm(): boolean {
    if (scope === "global") return true;
    if (scope === "project") return projectRoot.trim().length > 0;
    return bundleDir.trim().length > 0;
  }

  function confirm() {
    if (!canConfirm()) return;
    let target: string;
    if (scope === "global") {
      target = "~/.claude/skills";
    } else if (scope === "project") {
      const root = projectRoot.replace(/\/+$/, "");
      target = `${root}/.claude/skills`;
    } else {
      target = bundleDir.replace(/\/+$/, "");
    }
    onConfirm(target);
  }

  return (
    <div className="gen__overlay">
      <div className="gen__box skill-export__box">
        <div className="gen__title">🎯 Export as Claude skill</div>
        <div className="gen__hint">
          Exporting <b>{pipelineName}</b>. Pick where the skill folder should
          live.
        </div>

        <div className="skill-export__options">
          <label className="skill-export__opt">
            <input
              type="radio"
              name="scope"
              checked={scope === "global"}
              onChange={() => setScope("global")}
            />
            <div className="skill-export__opt-body">
              <div className="skill-export__opt-title">Global</div>
              <div className="skill-export__opt-desc">
                <code>~/.claude/skills/</code> — available in every Claude Code
                conversation on this machine.
              </div>
            </div>
          </label>

          <label className="skill-export__opt">
            <input
              type="radio"
              name="scope"
              checked={scope === "project"}
              onChange={() => setScope("project")}
            />
            <div className="skill-export__opt-body">
              <div className="skill-export__opt-title">Project-local</div>
              <div className="skill-export__opt-desc">
                <code>&lt;project&gt;/.claude/skills/</code> — only active when
                Claude Code runs in that project. Checkable into git.
              </div>
              {scope === "project" && (
                <div className="skill-export__picker">
                  <input
                    className="skill-export__path"
                    readOnly
                    placeholder="(no project selected)"
                    value={projectRoot}
                  />
                  <button
                    className="gen__btn gen__btn--secondary"
                    onClick={pickProjectRoot}
                  >
                    Pick…
                  </button>
                </div>
              )}
            </div>
          </label>

          <label className="skill-export__opt">
            <input
              type="radio"
              name="scope"
              checked={scope === "bundle"}
              onChange={() => setScope("bundle")}
            />
            <div className="skill-export__opt-body">
              <div className="skill-export__opt-title">Bundle / share</div>
              <div className="skill-export__opt-desc">
                Any folder. Not auto-discovered by Claude — good for zipping
                and sharing, or staging before moving into a skills dir.
              </div>
              {scope === "bundle" && (
                <div className="skill-export__picker">
                  <input
                    className="skill-export__path"
                    readOnly
                    placeholder="(no folder selected)"
                    value={bundleDir}
                  />
                  <button
                    className="gen__btn gen__btn--secondary"
                    onClick={pickBundleDir}
                  >
                    Pick…
                  </button>
                </div>
              )}
            </div>
          </label>
        </div>

        <div className="gen__actions">
          <button className="gen__btn gen__btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="gen__btn gen__btn--primary"
            onClick={confirm}
            disabled={!canConfirm()}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
