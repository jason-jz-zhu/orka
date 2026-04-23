import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import { useSkills } from "../lib/skills";
import { alertDialog, confirmDialog } from "../lib/dialogs";
// Lazy: the add-tap flow has its own form + URL parser. Only mounted
// when the user opts in, so the modal cost stays small.
const AddTapModal = lazy(() => import("./AddTapModal"));

export interface Tap {
  id: string;
  name: string;
  description: string;
  url: string;
  isBuiltin: boolean;
  installed: boolean;
  skillCount: number;
}

type Props = {
  onClose: () => void;
};

/**
 * "Skill packs" modal — the hiring-from-a-staffing-agency path.
 *
 * Replaces the old sidebar "Trusted Sources" section. Rationale: the
 * sidebar permanently spent ~200px on a feature the user only engages
 * with when they want to hire. Folding it into the "+ Hire an agent"
 * menu keeps the sidebar focused on the user's actual team and
 * surfaces the marketplace when the intent is explicit.
 *
 * Same backend commands as before (list_trusted_taps / install_tap /
 * uninstall_tap / remove_custom_tap) — only the entry point and
 * packaging changed.
 */
export default function SkillPacksModal({ onClose }: Props) {
  const [taps, setTaps] = useState<Tap[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const refreshSkills = useSkills((s) => s.refresh);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invokeCmd<Tap[]>("list_trusted_taps");
      const normalized: Tap[] = (list ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        url: t.url,
        isBuiltin:
          typeof (t as unknown as { isBuiltin?: boolean }).isBuiltin === "boolean"
            ? (t as unknown as { isBuiltin: boolean }).isBuiltin
            : ((t as unknown as { is_builtin?: boolean }).is_builtin ?? false),
        installed: !!t.installed,
        skillCount:
          typeof (t as unknown as { skillCount?: number }).skillCount === "number"
            ? (t as unknown as { skillCount: number }).skillCount
            : ((t as unknown as { skill_count?: number }).skill_count ?? 0),
      }));
      setTaps(normalized);
    } catch (e) {
      console.warn("[skill-packs] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function install(tap: Tap) {
    setBusy(tap.id);
    try {
      const linked = await invokeCmd<number>("install_tap", { id: tap.id });
      await load();
      await refreshSkills();
      await alertDialog(
        `Hired from ${tap.name}: ${linked} agent${linked === 1 ? "" : "s"} joined your team.`,
      );
    } catch (e) {
      await alertDialog(`Install failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(tap: Tap) {
    const ok = await confirmDialog(
      `Let go of ${tap.name}? This removes the tap clone and its skill links. Your own skills are untouched.`,
      { title: "Uninstall pack?", okLabel: "Uninstall", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    setBusy(tap.id);
    try {
      await invokeCmd<number>("uninstall_tap", { id: tap.id });
      await load();
      await refreshSkills();
    } catch (e) {
      await alertDialog(`Uninstall failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function removeCustom(tap: Tap) {
    const ok = await confirmDialog(
      `Remove "${tap.name}" from your list? If it's installed, uninstall it first.`,
      { title: "Remove custom pack?" },
    );
    if (!ok) return;
    if (tap.installed) {
      await alertDialog(`Uninstall ${tap.name} first, then remove.`);
      return;
    }
    try {
      await invokeCmd("remove_custom_tap", { id: tap.id });
      await load();
    } catch (e) {
      await alertDialog(`Remove failed: ${e}`);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box skill-packs-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">📦 Browse skill packs</div>
            <div className="modal-subtitle">
              Hire pre-built agents from a community source. Each pack is a
              git repo of SKILL.md files — installing clones it locally and
              links each skill into your team.
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="skill-packs-modal__list">
          {loading && (
            <div className="skill-packs-modal__status">Loading…</div>
          )}
          {!loading && taps.length === 0 && (
            <div className="skill-packs-modal__status">
              No packs yet. Click “Add custom pack” to wire one up.
            </div>
          )}
          {!loading &&
            taps.map((t) => (
              <div key={t.id} className="skill-packs-row">
                <div className="skill-packs-row__info">
                  <div className="skill-packs-row__name">
                    📍 {t.name}
                    {!t.isBuiltin && (
                      <span className="skill-packs-row__custom-tag">custom</span>
                    )}
                    {t.installed && (
                      <span className="skill-packs-row__count">
                        · {t.skillCount} agent{t.skillCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {t.description && (
                    <div
                      className="skill-packs-row__desc"
                      title={t.description}
                    >
                      {t.description}
                    </div>
                  )}
                </div>
                <div className="skill-packs-row__actions">
                  {busy === t.id ? (
                    <span className="skill-packs-row__busy">⏳</span>
                  ) : t.installed ? (
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => void uninstall(t)}
                      title={`Uninstall ${t.name}`}
                    >
                      Uninstall
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="modal-btn modal-btn--primary"
                      onClick={() => void install(t)}
                      title={`Clone ${t.url}`}
                    >
                      Hire
                    </button>
                  )}
                  {!t.isBuiltin && !t.installed && (
                    <button
                      type="button"
                      className="skill-packs-row__remove"
                      onClick={() => void removeCustom(t)}
                      title="Remove from list (doesn't affect installed state)"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>

        <div className="skill-packs-modal__footer">
          <button
            type="button"
            className="modal-btn"
            onClick={() => setShowAdd(true)}
          >
            + Add custom pack
          </button>
        </div>

        {showAdd && (
          <Suspense fallback={null}>
            <AddTapModal
              onClose={() => setShowAdd(false)}
              onAdded={() => void load()}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
