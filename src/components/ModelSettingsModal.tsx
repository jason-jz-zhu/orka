import { useEffect, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import { alertDialog } from "../lib/dialogs";

interface ModelConfig {
  brief: string;
  synthesis: string;
  skillRun: string;
  evolution: string;
}

type Props = { onClose: () => void };

/** Model options the UI offers. Users can pick one or type a custom
 *  Claude CLI model string (e.g., a specific pinned version or the
 *  1M-context variant of a new model). */
const PRESETS: Array<{ id: string; label: string; hint?: string }> = [
  { id: "haiku", label: "Haiku", hint: "Fastest. Good for briefs, short JSON." },
  { id: "sonnet", label: "Sonnet", hint: "Balanced." },
  { id: "opus", label: "Opus", hint: "Smartest default." },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 · 1M context",
    hint: "Best for synthesis across long sessions.",
  },
];

type FeatureKey = keyof ModelConfig;
const FEATURE_LABELS: Record<FeatureKey, { title: string; subtitle: string }> = {
  brief: {
    title: "Session Brief",
    subtitle: "Auto-summary of each session in the Sessions tab",
  },
  synthesis: {
    title: "Cross-Session Synthesis",
    subtitle: "Ask across selected sessions (📚 Ask across…)",
  },
  skillRun: {
    title: "Skill Run + Continue Chat",
    subtitle: "Running a skill and replying in the output chat",
  },
  evolution: {
    title: "Skill Evolution",
    subtitle: "💡 Evolve — propose SKILL.md updates from your annotations",
  },
};

/**
 * Per-feature model picker. Each of the four features Orka calls Claude
 * for gets its own model setting, so the user can trade speed for depth
 * where it matters most (synthesis → Opus) and stay fast where it
 * doesn't (brief → Haiku).
 *
 * Config persists at ~/.orka/model-config.json. Deleting that file
 * restores defaults.
 */
export function ModelSettingsModal({ onClose }: Props) {
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await invokeCmd<ModelConfig>("get_model_config");
        if (!cancelled) setConfig(c);
      } catch (e) {
        if (!cancelled)
          await alertDialog(`Failed to load model config: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      await invokeCmd("set_model_config", { config });
      onClose();
    } catch (e) {
      await alertDialog(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  function update(key: FeatureKey, value: string) {
    setConfig((c) => (c ? { ...c, [key]: value } : c));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box model-settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">🤖 Claude Models</div>
            <div className="modal-subtitle">
              Which model Orka uses for each feature
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {!config && (
          <div className="model-settings__loading">⏳ loading…</div>
        )}

        {config &&
          (Object.keys(FEATURE_LABELS) as FeatureKey[]).map((key) => (
            <div key={key} className="model-settings__row">
              <div className="model-settings__row-label">
                <div className="model-settings__row-title">
                  {FEATURE_LABELS[key].title}
                </div>
                <div className="model-settings__row-subtitle">
                  {FEATURE_LABELS[key].subtitle}
                </div>
              </div>
              <div className="model-settings__row-control">
                <select
                  className="model-settings__select"
                  value={
                    PRESETS.some((p) => p.id === config[key])
                      ? config[key]
                      : "__custom__"
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__custom__") {
                      // Keep whatever's already in custom, or seed empty.
                      update(
                        key,
                        PRESETS.some((p) => p.id === config[key])
                          ? ""
                          : config[key],
                      );
                    } else {
                      update(key, v);
                    }
                  }}
                >
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id} title={p.hint}>
                      {p.label}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
                {!PRESETS.some((p) => p.id === config[key]) && (
                  <input
                    className="model-settings__custom"
                    placeholder="e.g. claude-sonnet-4-6"
                    value={config[key]}
                    onChange={(e) => update(key, e.target.value)}
                  />
                )}
              </div>
            </div>
          ))}

        <div className="model-settings__actions">
          <button className="modal-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn--primary"
            onClick={() => void save()}
            disabled={!config || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
