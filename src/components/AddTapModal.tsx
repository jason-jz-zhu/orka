import { useEffect, useRef, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import { normalizeTapUrl, slugify } from "../lib/tap-url";
import { alertDialog } from "../lib/dialogs";

type Props = {
  onClose: () => void;
  /** Fires after a successful add so the parent reloads the tap list. */
  onAdded: () => void;
};

type PreviewResult = {
  skill_count: number;
  skill_names: string[];
  readme_excerpt: string | null;
};

const TAP_TRUST_NOTICE_KEY = "orka:tap-trust-notice-shown";

/**
 * Full-featured replacement for the 3-step promptDialog flow the
 * TrustedTapsSection used to chain. Single modal, live URL parsing,
 * optional "Test" button that previews the repo via a throwaway
 * clone before committing to the tap list.
 */
export default function AddTapModal({ onClose, onAdded }: Props) {
  const [url, setUrl] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [nameEdited, setNameEdited] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [hostLabel, setHostLabel] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [showTrustNotice, setShowTrustNotice] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Autofocus the URL input so paste-and-submit is one keystroke.
    urlRef.current?.focus();
  }, []);

  // Re-parse on every URL change. Cheap enough to do inline — no
  // debounce needed since it's pure string work, not IPC.
  useEffect(() => {
    const raw = url.trim();
    if (!raw) {
      setUrlError(null);
      setHostLabel(null);
      setPreview(null);
      if (!idEdited) setId("");
      if (!nameEdited) setName("");
      return;
    }
    try {
      const parsed = normalizeTapUrl(raw);
      setUrlError(null);
      setHostLabel(parsed.hostLabel);
      if (!idEdited) setId(parsed.defaultId);
      if (!nameEdited) setName(parsed.defaultName);
      // Invalidate any prior preview if URL changed.
      setPreview(null);
    } catch (e) {
      setUrlError(String(e instanceof Error ? e.message : e));
      setHostLabel(null);
      setPreview(null);
    }
  }, [url, idEdited, nameEdited]);

  async function onTest() {
    if (urlError || !url.trim()) return;
    setTesting(true);
    setPreview(null);
    try {
      const parsed = normalizeTapUrl(url);
      const p = await invokeCmd<PreviewResult>("preview_tap", {
        url: parsed.url,
      });
      setPreview(p);
    } catch (e) {
      await alertDialog(`Test failed: ${e}`);
    } finally {
      setTesting(false);
    }
  }

  async function onSave() {
    if (urlError || !url.trim() || !id.trim() || !name.trim()) return;
    setSaving(true);
    try {
      const parsed = normalizeTapUrl(url);
      await invokeCmd("add_custom_tap", {
        id: slugify(id),
        name: name.trim(),
        description: description.trim(),
        url: parsed.url,
      });
      // First-run trust notice — show once per user.
      const seen =
        typeof localStorage !== "undefined" &&
        localStorage.getItem(TAP_TRUST_NOTICE_KEY) === "1";
      if (!seen) {
        setShowTrustNotice(true);
        try {
          localStorage.setItem(TAP_TRUST_NOTICE_KEY, "1");
        } catch {
          /* private mode */
        }
        // Delay close until user acknowledges the notice.
        setSaving(false);
        return;
      }
      onAdded();
      onClose();
    } catch (e) {
      await alertDialog(`Add tap failed: ${e}`);
      setSaving(false);
    }
  }

  function acknowledgeTrustAndClose() {
    setShowTrustNotice(false);
    onAdded();
    onClose();
  }

  const canSave = !urlError && url.trim() && id.trim() && name.trim();

  return (
    <div
      className="tap-modal__overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="tap-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {!showTrustNotice ? (
          <>
            <div className="tap-modal__title">🏛 Add trusted tap</div>
            <div className="tap-modal__sub">
              Paste a Git URL. Orka will clone it into{" "}
              <code>~/.orka/taps/</code> when you hit Install on the row
              afterwards.
            </div>

            <label className="tap-modal__label">
              Git URL
              <span className="tap-modal__hint">
                https:// · git@ · or shortcut <code>user/repo</code>
              </span>
            </label>
            <input
              ref={urlRef}
              className={`tap-modal__input ${urlError ? "tap-modal__input--error" : ""}`}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="github.com/garrytan/gstack"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && canSave) {
                  e.preventDefault();
                  void onSave();
                }
              }}
              autoFocus
            />
            {urlError && (
              <div className="tap-modal__err">{urlError}</div>
            )}
            {hostLabel && !urlError && (
              <div className="tap-modal__host">→ {hostLabel}</div>
            )}

            <div className="tap-modal__grid">
              <div>
                <label className="tap-modal__label">
                  id
                  <span className="tap-modal__hint">slug prefix</span>
                </label>
                <input
                  className="tap-modal__input"
                  type="text"
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value);
                    setIdEdited(true);
                  }}
                />
              </div>
              <div>
                <label className="tap-modal__label">name</label>
                <input
                  className="tap-modal__input"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameEdited(true);
                  }}
                />
              </div>
            </div>

            <label className="tap-modal__label">
              description <span className="tap-modal__hint">optional</span>
            </label>
            <input
              className="tap-modal__input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short blurb shown in the sidebar"
            />

            <div className="tap-modal__test-row">
              <button
                type="button"
                className="tap-modal__btn tap-modal__btn--ghost"
                onClick={() => void onTest()}
                disabled={testing || !!urlError || !url.trim()}
              >
                {testing ? "Cloning…" : "🔍 Test (clone + inspect)"}
              </button>
              {preview && (
                <span className="tap-modal__preview">
                  Found {preview.skill_count} skill
                  {preview.skill_count === 1 ? "" : "s"}
                  {preview.skill_names.length > 0 && (
                    <>
                      : <code>{preview.skill_names.slice(0, 3).join(", ")}</code>
                      {preview.skill_count > 3 && ` +${preview.skill_count - 3} more`}
                    </>
                  )}
                </span>
              )}
            </div>

            {preview?.readme_excerpt && (
              <div className="tap-modal__readme">
                <div className="tap-modal__readme-label">README excerpt</div>
                <pre className="tap-modal__readme-body">
                  {preview.readme_excerpt}
                </pre>
              </div>
            )}

            <div className="tap-modal__actions">
              <button
                type="button"
                className="tap-modal__btn tap-modal__btn--secondary"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="tap-modal__btn tap-modal__btn--primary"
                onClick={() => void onSave()}
                disabled={!canSave || saving}
              >
                {saving ? "Saving…" : "Add tap"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="tap-modal__title">✓ Tap added</div>
            <div className="tap-modal__sub">
              A quick note on trust (shown once):
            </div>
            <div className="tap-modal__notice">
              <p>
                Skills installed from this tap get{" "}
                <strong>TOFU-pinned on first run</strong>: Orka stores a
                SHA-256 of each skill's SKILL.md the first time you
                approve it. If the skill changes later (tap author
                pushes an update, or someone MITM'd the clone) Orka
                will ask you to re-approve before executing.
              </p>
              <p>
                Taps are cloned over <code>https://</code> or{" "}
                <code>git@</code> (plain <code>http://</code> is
                rejected). Skill trust is tracked at{" "}
                <code>~/OrkaCanvas/.trusted-skills.json</code>.
              </p>
            </div>
            <div className="tap-modal__actions">
              <button
                type="button"
                className="tap-modal__btn tap-modal__btn--primary"
                onClick={acknowledgeTrustAndClose}
              >
                Got it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
