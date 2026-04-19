import { useCallback, useEffect, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import { useSkills } from "../lib/skills";
import { alertDialog, confirmDialog, promptDialog } from "../lib/dialogs";

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
  /** Collapsed by default; parent can persist state if desired. */
  defaultCollapsed?: boolean;
};

/**
 * Sidebar section listing authoritative tap sources (gstack, etc).
 * Each tap shows install/uninstall state; installing clones the repo
 * into ~/.orka/taps/<id>/ and symlinks each skill into
 * ~/.claude/skills/<id>-<slug>/ so both Orka and Claude Code pick it up.
 *
 * Users can add custom taps via the "+ Add tap" button. Builtins are
 * always shown first; user-added taps follow alphabetically.
 */
export function TrustedTapsSection({ defaultCollapsed }: Props) {
  const [taps, setTaps] = useState<Tap[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  const refreshSkills = useSkills((s) => s.refresh);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invokeCmd<Tap[]>("list_trusted_taps");
      // Accept both camelCase and snake_case from the backend serializer —
      // be defensive in case serde changes.
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
      console.warn("[taps] list failed:", e);
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
        `Installed ${tap.name}: ${linked} skill${linked === 1 ? "" : "s"} linked.`,
      );
    } catch (e) {
      await alertDialog(`Install failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(tap: Tap) {
    const ok = await confirmDialog(
      `Uninstall ${tap.name}? This removes the tap clone and its skill links. Your own skills are untouched.`,
      { title: "Uninstall tap?", okLabel: "Uninstall", cancelLabel: "Cancel" },
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

  async function addCustom() {
    const id = await promptDialog(
      "Short id (letters, numbers, dashes — used as slug prefix):",
      { title: "Add a tap · step 1 of 3" },
    );
    if (!id) return;
    const name = await promptDialog("Display name:", {
      default: id,
      title: "Add a tap · step 2 of 3",
    });
    if (!name) return;
    const url = await promptDialog("Git URL (https://…):", {
      title: "Add a tap · step 3 of 3",
    });
    if (!url) return;
    try {
      await invokeCmd("add_custom_tap", {
        id,
        name,
        description: "",
        url,
      });
      await load();
    } catch (e) {
      await alertDialog(`Add tap failed: ${e}`);
    }
  }

  async function removeCustom(tap: Tap) {
    const ok = await confirmDialog(
      `Remove "${tap.name}" from your tap list? If it's installed, uninstall it first.`,
      { title: "Remove custom tap?" },
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
    <div className="taps-section">
      <button
        type="button"
        className="taps-section__toggle"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="taps-section__toggle-icon">{collapsed ? "▸" : "▾"}</span>
        <span className="taps-section__title">🏛 Trusted Sources</span>
        <span className="taps-section__count">
          {taps.filter((t) => t.installed).length}/{taps.length}
        </span>
      </button>
      {!collapsed && (
        <div className="taps-section__body">
          {loading && <div className="taps-section__status">loading…</div>}
          {!loading &&
            taps.map((t) => (
              <div key={t.id} className="taps-row">
                <div className="taps-row__info">
                  <div className="taps-row__name">
                    📍 {t.name}
                    {!t.isBuiltin && (
                      <span className="taps-row__custom-tag">custom</span>
                    )}
                    {t.installed && (
                      <span className="taps-row__count">· {t.skillCount}</span>
                    )}
                  </div>
                  {t.description && (
                    <div className="taps-row__desc" title={t.description}>
                      {t.description}
                    </div>
                  )}
                </div>
                <div className="taps-row__actions">
                  {busy === t.id ? (
                    <span className="taps-row__busy">⏳</span>
                  ) : t.installed ? (
                    <button
                      type="button"
                      className="taps-row__btn taps-row__btn--ghost"
                      onClick={() => void uninstall(t)}
                      title={`Uninstall ${t.name}`}
                    >
                      Uninstall
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="taps-row__btn"
                      onClick={() => void install(t)}
                      title={`Clone ${t.url}`}
                    >
                      Install
                    </button>
                  )}
                  {!t.isBuiltin && !t.installed && (
                    <button
                      type="button"
                      className="taps-row__remove"
                      onClick={() => void removeCustom(t)}
                      title="Remove from list (doesn't affect installed state)"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
          <button
            type="button"
            className="taps-section__add"
            onClick={() => void addCustom()}
          >
            + Add tap…
          </button>
        </div>
      )}
    </div>
  );
}
