import { useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invokeCmd } from "../lib/tauri";
import { useGraph, type OrkaNode } from "../lib/graph-store";
import { alertDialog, confirmDialog } from "../lib/dialogs";
import {
  type DestinationProfile,
  PROFILE_KIND_LABEL,
  listProfiles,
} from "../lib/destinations";

type Props = NodeProps<Extract<OrkaNode, { type: "output" }>>;

const DEST_ICON: Record<string, string> = {
  local: "📁",
  icloud: "📱",
  notes: "📝",
  webhook: "🔗",
  shell: "⚙️",
  profile: "🔌",
};
const DEST_LABEL: Record<string, string> = {
  local: "Local folder",
  icloud: "iCloud Drive",
  notes: "Apple Notes",
  webhook: "HTTP webhook",
  shell: "Shell command",
  profile: "Saved destination",
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function ShellTrustIndicator({
  command,
  onApproved,
}: {
  command: string;
  onApproved: () => void;
}) {
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const trimmed = command.trim();

  useEffect(() => {
    let cancelled = false;
    if (!trimmed) {
      setTrusted(null);
      return;
    }
    invokeCmd<boolean>("is_shell_command_trusted", { commandTemplate: trimmed })
      .then((ok) => { if (!cancelled) setTrusted(ok); })
      .catch(() => { if (!cancelled) setTrusted(null); });
    return () => { cancelled = true; };
  }, [trimmed]);

  if (!trimmed) return null;
  if (trusted === true) {
    return <span className="output-node__trust output-node__trust--ok">✓ approved</span>;
  }
  return (
    <div className="output-node__trust-row">
      <span className="output-node__trust output-node__trust--warn">
        ⚠ not approved — required before this node can run
      </span>
      <button
        className="output-node__trust-btn nodrag"
        onClick={async (e) => {
          e.stopPropagation();
          const ok = await confirmDialog(
            `Approve this shell command to run as part of this pipeline?\n\n${trimmed}`,
            { title: "Approve shell command?", okLabel: "Approve", cancelLabel: "Cancel" }
          );
          if (!ok) return;
          try {
            await invokeCmd<string>("approve_shell_command", {
              commandTemplate: trimmed,
            });
            setTrusted(true);
            onApproved();
          } catch (err) {
            await alertDialog(`Approve failed: ${err}`);
          }
        }}
      >
        Approve…
      </button>
    </div>
  );
}

export default function OutputNode({ id, data }: Props) {
  const update = useGraph((s) => s.updateNodeData);
  const [defaultDir, setDefaultDir] = useState<string>("");
  const [advanced, setAdvanced] = useState(false);
  const [profiles, setProfiles] = useState<DestinationProfile[]>([]);

  useEffect(() => {
    invokeCmd<string>("outputs_dir")
      .then((d) => setDefaultDir(d))
      .catch(() => {});
    listProfiles()
      .then(setProfiles)
      .catch(() => {});
  }, []);

  async function pickDir() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Select output directory",
    });
    if (typeof picked === "string") update(id, { dir: picked });
  }

  async function reveal() {
    if (!data.lastWrittenPath) return;
    try {
      await revealItemInDir(data.lastWrittenPath);
    } catch (e) {
      console.warn("revealItemInDir failed:", e);
    }
  }

  async function openFile() {
    if (!data.lastWrittenPath) return;
    try {
      await openPath(data.lastWrittenPath);
    } catch (e) {
      await alertDialog(`Open failed: ${e}`);
    }
  }

  const destination = data.destination ?? "local";
  const isFileDest = destination === "local" || destination === "icloud";

  // Primary input for the selected destination — the ONE field the user
  // always needs to configure. Everything else hides behind ⚙︎ Advanced.
  function PrimaryField() {
    switch (destination) {
      case "local":
        return (
          <input
            className="output-node__input nodrag"
            value={data.filename}
            onChange={(e) => update(id, { filename: e.target.value })}
            placeholder="report.md"
          />
        );
      case "icloud":
        return (
          <input
            className="output-node__input nodrag"
            value={data.filename}
            onChange={(e) => update(id, { filename: e.target.value })}
            placeholder="report.md"
          />
        );
      case "notes":
        return (
          <input
            className="output-node__input nodrag"
            value={data.notesTitle ?? "Orka Inbox"}
            onChange={(e) => update(id, { notesTitle: e.target.value })}
            placeholder="Orka Inbox"
          />
        );
      case "webhook":
        return (
          <input
            className="output-node__input nodrag"
            value={data.webhookUrl ?? ""}
            onChange={(e) => update(id, { webhookUrl: e.target.value })}
            placeholder="https://…"
          />
        );
      case "shell":
        return (
          <div className="output-node__shell-wrap nodrag">
            <textarea
              className="output-node__input nodrag nowheel"
              value={data.shellCommand ?? ""}
              onChange={(e) => update(id, { shellCommand: e.target.value })}
              placeholder={`shortcuts run "…"`}
              rows={2}
            />
            <ShellTrustIndicator
              command={data.shellCommand ?? ""}
              onApproved={() => {
                // Force a re-render by touching the node so the badge updates.
                update(id, { shellCommand: data.shellCommand ?? "" });
              }}
            />
          </div>
        );
      case "profile":
        return (
          <select
            className="output-node__input nodrag"
            value={data.profileId ?? ""}
            onChange={(e) => update(id, { profileId: e.target.value })}
          >
            <option value="">— pick a saved destination —</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {PROFILE_KIND_LABEL[p.config.kind]} · {p.name}
              </option>
            ))}
          </select>
        );
    }
  }

  const primaryLabel =
    destination === "local"
      ? "filename"
      : destination === "icloud"
        ? "filename"
        : destination === "notes"
          ? "note"
          : destination === "webhook"
            ? "url"
            : destination === "profile"
              ? "profile"
              : "cmd";

  return (
    <div className="output-node">
      <Handle type="target" position={Position.Left} />
      <div className="output-node__header">
        OUTPUT · {id}
        <button
          className="output-node__gear"
          title={advanced ? "Hide advanced" : "Advanced options"}
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? "−" : "⚙︎"}
        </button>
      </div>
      <div className="output-node__destinations-bar">
        📝 Notes · ☁️ iCloud · 💬 WeChat · 🔧 Shell · 🌐 Webhook
      </div>

      <div className="output-node__row">
        <select
          className="output-node__input nodrag output-node__input--dest"
          value={destination}
          onChange={(e) =>
            update(id, { destination: e.target.value as typeof destination })
          }
        >
          {Object.keys(DEST_LABEL).map((k) => (
            <option key={k} value={k}>
              {DEST_ICON[k]} {DEST_LABEL[k]}
            </option>
          ))}
        </select>
      </div>

      <div className="output-node__row">
        <label className="output-node__label">{primaryLabel}</label>
        {PrimaryField()}
        {destination === "local" && (
          <button
            className="output-node__pick"
            onClick={pickDir}
            title={data.dir || defaultDir || "Pick folder"}
          >
            …
          </button>
        )}
      </div>

      {advanced && (
        <div className="output-node__advanced">
          {destination === "local" && (
            <div className="output-node__row">
              <label className="output-node__label">dir</label>
              <input
                className="output-node__input nodrag"
                value={data.dir}
                onChange={(e) => update(id, { dir: e.target.value })}
                placeholder={defaultDir || "default outputs/"}
                title={data.dir || defaultDir}
              />
            </div>
          )}
          {destination === "webhook" && (
            <div className="output-node__row">
              <label className="output-node__label">headers</label>
              <textarea
                className="output-node__input nowheel nodrag"
                value={data.webhookHeaders ?? ""}
                onChange={(e) =>
                  update(id, { webhookHeaders: e.target.value })
                }
                placeholder={`Authorization: Bearer xxx`}
                rows={2}
              />
            </div>
          )}
          {isFileDest && (
            <div className="output-node__row">
              <label className="output-node__label">format</label>
              <select
                className="output-node__input nodrag"
                value={data.format}
                onChange={(e) => update(id, { format: e.target.value })}
              >
                <option value="markdown">markdown</option>
                <option value="json">json</option>
                <option value="text">text</option>
              </select>
            </div>
          )}
          <div className="output-node__row">
            <label className="output-node__label">merge</label>
            <select
              className="output-node__input nodrag"
              value={data.mergeMode}
              onChange={(e) => update(id, { mergeMode: e.target.value })}
            >
              <option value="concat">concat</option>
              <option value="list">list</option>
              <option value="json">json</option>
            </select>
          </div>
          {isFileDest && (
            <div className="output-node__row">
              <label className="output-node__check">
                <input
                  type="checkbox"
                  checked={data.overwrite}
                  onChange={(e) =>
                    update(id, { overwrite: e.target.checked })
                  }
                />
                overwrite (off = timestamp suffix)
              </label>
            </div>
          )}
        </div>
      )}

      {data.running && (
        <div className="output-node__status output-node__status--running">
          ⋯ sending…
        </div>
      )}
      {data.lastError && (
        <div className="output-node__status output-node__status--err">
          ✗ {data.lastError}
        </div>
      )}
      {data.lastWrittenPath && !data.lastError && (
        <div className="output-node__written">
          <div className="output-node__written-row">
            <span className="output-node__written-icon">✓</span>
            <span
              className="output-node__written-path"
              title={data.lastWrittenPath}
            >
              {data.lastWrittenPath}
            </span>
          </div>
          <div className="output-node__written-meta">
            sent {data.lastWrittenAt ? fmtTime(data.lastWrittenAt) : ""}
          </div>
          {isFileDest && (
            <div className="output-node__written-actions">
              <button onClick={reveal}>Reveal</button>
              <button onClick={openFile}>Open</button>
            </div>
          )}
          {destination === "notes" && (
            <div className="output-node__written-actions">
              <button
                onClick={async () => {
                  try {
                    await invokeCmd("open_app_by_name", { name: "Notes" });
                  } catch (e) {
                    await alertDialog(`Open Notes failed: ${e}`);
                  }
                }}
              >
                Open Notes.app
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
