import { useEffect, useState } from "react";
import {
  type DestinationProfile,
  PROFILE_KIND_LABEL,
  deleteProfile,
  listProfiles,
  newProfileId,
  saveProfile,
  testWeworkWebhook,
} from "../lib/destinations";
import { alertDialog, confirmDialog } from "../lib/dialogs";

/** Platform detection via `navigator.platform`. Tauri's webview
 *  inherits this from the host OS. macOS-only destinations (Apple
 *  Notes, iCloud Drive) are hidden on Linux/Windows to avoid
 *  promising features that silently no-op. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = navigator.platform || "";
  return p.toLowerCase().includes("mac");
}
import {
  type TerminalConfig,
  type TerminalPreference,
  TERMINAL_LABEL,
  detectAvailableTerminals,
  getTerminalConfig,
  setTerminalConfig,
} from "../lib/terminal-config";

type Props = { onClose: () => void };

type WizardKind = "wechat_work" | null;

export default function SettingsModal({ onClose }: Props) {
  const [profiles, setProfiles] = useState<DestinationProfile[]>([]);
  const [wizard, setWizard] = useState<WizardKind>(null);

  async function refresh() {
    setProfiles(await listProfiles());
  }
  useEffect(() => {
    refresh();
  }, []);

  async function onDelete(id: string, name: string) {
    const ok = await confirmDialog(`Delete destination "${name}"?`, {
      title: "Delete destination",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    await deleteProfile(id);
    refresh();
  }

  return (
    <div className="settings__overlay">
      <div className="settings__card">
        {wizard === null && (
          <SettingsHome
            profiles={profiles}
            onAddWeChat={() => setWizard("wechat_work")}
            onDelete={onDelete}
            onClose={onClose}
          />
        )}
        {wizard === "wechat_work" && (
          <WeChatWorkWizard
            onCancel={() => setWizard(null)}
            onSaved={async () => {
              await refresh();
              setWizard(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function SettingsHome({
  profiles,
  onAddWeChat,
  onDelete,
  onClose,
}: {
  profiles: DestinationProfile[];
  onAddWeChat: () => void;
  onDelete: (id: string, name: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="settings__title">Destinations</div>
      <div className="settings__sub">
        Always-available destinations need no setup. Configure others below to
        send pipeline output to your phone, team chat, or external tools.
      </div>

      <div className="settings__section-label">🌟 Always available</div>
      <div className="settings__static">
        <div>
          📁 Local folder
          {isMac() && " · 📱 iCloud Drive · 📝 Apple Notes"}
        </div>
        <div className="settings__static-hint">
          {isMac()
            ? "No setup. Pick directly from the Output node's \"send to\" dropdown."
            : "Apple Notes and iCloud destinations are macOS-only. Local folder works everywhere."}
        </div>
      </div>

      <div className="settings__section-label">⚙️ Configured by you</div>
      {profiles.length === 0 && (
        <div className="settings__empty">
          No configured destinations yet. Add one below.
        </div>
      )}
      {profiles.map((p) => (
        <div key={p.id} className="settings__profile">
          <div className="settings__profile-line">
            <span className="settings__profile-kind">
              {PROFILE_KIND_LABEL[p.config.kind]}
            </span>
            <span className="settings__profile-name">{p.name}</span>
            <span className="settings__profile-meta">
              {p.last_used_ms
                ? `last used ${new Date(p.last_used_ms).toLocaleString()}`
                : "never used"}
            </span>
          </div>
          <div className="settings__profile-actions">
            <button onClick={() => onDelete(p.id, p.name)}>Delete</button>
          </div>
        </div>
      ))}

      <TerminalSection />

      <div className="settings__section-label">➕ Add destination</div>
      <div className="settings__add-grid">
        <button className="settings__add-card" onClick={onAddWeChat}>
          <div className="settings__add-card-icon">💼</div>
          <div className="settings__add-card-name">WeChat Work</div>
          <div className="settings__add-card-meta">企业微信群机器人</div>
        </button>
        <button className="settings__add-card settings__add-card--disabled">
          <div className="settings__add-card-icon">📚</div>
          <div className="settings__add-card-name">Notion</div>
          <div className="settings__add-card-meta">coming next</div>
        </button>
        <button className="settings__add-card settings__add-card--disabled">
          <div className="settings__add-card-icon">💬</div>
          <div className="settings__add-card-name">Telegram</div>
          <div className="settings__add-card-meta">coming next</div>
        </button>
      </div>

      <div className="settings__actions">
        <button className="settings__btn settings__btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}

function TerminalSection() {
  const [cfg, setCfg] = useState<TerminalConfig | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [c, a] = await Promise.all([
          getTerminalConfig(),
          detectAvailableTerminals(),
        ]);
        setCfg(c);
        setAvailable(a);
      } catch {
        setCfg({ preference: "auto", custom_template: null });
      }
    })();
  }, []);

  async function update(patch: Partial<TerminalConfig>) {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSaving(true);
    try {
      await setTerminalConfig(next);
      setSavedAt(Date.now());
    } catch (e) {
      // Silently dropping config-write errors caused a "my settings
      // aren't saving" class of bug with no in-app signal. Surface
      // the error — users can retry, report, or fix permissions.
      void alertDialog(`Couldn't save terminal settings: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) return null;

  const options: TerminalPreference[] = [
    "auto",
    "terminal-app",
    "iterm",
    "warp",
    "vscode",
    "custom",
  ];

  return (
    <>
      <div className="settings__section-label">⌨️ Terminal</div>
      <div className="settings__sub" style={{ marginBottom: 10 }}>
        Which terminal to open when you click "⌨ Terminal" on a Run row. The
        command pre-fills with <code>claude --resume &lt;session&gt;</code> in
        the run's working directory.
      </div>
      <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
        {options.map((opt) => {
          const isAvailable =
            opt === "auto" ||
            opt === "custom" ||
            available.includes(opt);
          const checked = cfg.preference === opt;
          return (
            <label
              key={opt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: isAvailable ? 1 : 0.5,
                cursor: isAvailable ? "pointer" : "not-allowed",
              }}
            >
              <input
                type="radio"
                name="term-pref"
                checked={checked}
                disabled={!isAvailable}
                onChange={() => void update({ preference: opt })}
              />
              <span>{TERMINAL_LABEL[opt]}</span>
              {!isAvailable && (
                <span className="settings__static-hint">(not detected)</span>
              )}
              {opt === "auto" && available.length > 0 && (
                <span className="settings__static-hint">
                  → {available[0]}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {cfg.preference === "custom" && (
        <div style={{ marginBottom: 8 }}>
          <label className="settings__label">Custom command template</label>
          <textarea
            className="settings__input"
            rows={3}
            placeholder="alacritty -e bash -c 'cd {cwd} && {cmd}'"
            value={cfg.custom_template ?? ""}
            onChange={(e) => void update({ custom_template: e.target.value })}
          />
          <div className="settings__hint">
            Variables:{" "}
            <code>{"{cwd}"}</code> · <code>{"{cmd}"}</code> ·{" "}
            <code>{"{sid}"}</code>. Runs through <code>sh -c</code>. Unknown
            placeholders stay literal.
          </div>
        </div>
      )}
      {saving && (
        <div className="settings__static-hint">Saving…</div>
      )}
      {!saving && savedAt !== null && (
        <div className="settings__static-hint">✓ Saved</div>
      )}
    </>
  );
}

function WeChatWorkWizard({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [name, setName] = useState("");
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runTest() {
    setError(null);
    setTesting(true);
    try {
      const r = await testWeworkWebhook(webhookUrl);
      setTestStatus(`✓ ${r}`);
    } catch (e) {
      setTestStatus(null);
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setError(null);
    try {
      await saveProfile({
        id: newProfileId(),
        name: name.trim() || "工作群",
        last_used_ms: null,
        config: { kind: "wechat_work", webhook_url: webhookUrl.trim() },
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  const urlValid = webhookUrl.startsWith("https://qyapi.weixin.qq.com/");

  return (
    <>
      <div className="settings__title">添加企业微信群机器人</div>
      <div className="settings__sub">第 {step} 步 / 共 2 步</div>

      {step === 1 && (
        <div className="settings__step">
          <ol className="settings__steps">
            <li>打开企业微信(电脑或手机版)</li>
            <li>进入想接收 Orka 报告的群</li>
            <li>
              群设置 → 群机器人 → 添加 → <b>添加机器人</b>
            </li>
            <li>名字写"Orka"(任意),保存</li>
            <li>
              复制生成的 <b>Webhook 地址</b>
            </li>
          </ol>
          <label className="settings__label">Webhook URL</label>
          <input
            className="settings__input"
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            autoFocus
          />
          {!urlValid && webhookUrl.length > 0 && (
            <div className="settings__warn">
              URL 应该以 <code>https://qyapi.weixin.qq.com/</code> 开头
            </div>
          )}
          <div className="settings__actions">
            <button
              className="settings__btn settings__btn--secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              className="settings__btn settings__btn--primary"
              disabled={!urlValid}
              onClick={() => setStep(2)}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="settings__step">
          <label className="settings__label">给这个目标起个名字</label>
          <input
            className="settings__input"
            placeholder="工作群 - 日报"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="settings__hint">
            后面在 OutputNode 的 destination 下拉里会看到这个名字。
          </div>

          <button
            className="settings__btn settings__btn--secondary"
            onClick={runTest}
            disabled={testing}
            style={{ marginTop: 12 }}
          >
            {testing ? "Sending test…" : "🧪 发条测试消息"}
          </button>
          {testStatus && (
            <div className="settings__success">
              {testStatus}
              <div className="settings__hint">
                ✓ 检查你的企业微信群应该有"🎉 Orka 测试消息"
              </div>
            </div>
          )}
          {error && <div className="settings__error">{error}</div>}

          <div className="settings__actions">
            <button
              className="settings__btn settings__btn--secondary"
              onClick={() => setStep(1)}
            >
              ← Back
            </button>
            <button
              className="settings__btn settings__btn--primary"
              onClick={save}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </>
  );
}
