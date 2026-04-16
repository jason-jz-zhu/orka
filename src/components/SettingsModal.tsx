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
import { confirmDialog } from "../lib/dialogs";

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
        <div>📁 Local folder · 📱 iCloud Drive · 📝 Apple Notes</div>
        <div className="settings__static-hint">
          No setup. Pick directly from the Output node's "send to" dropdown.
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
