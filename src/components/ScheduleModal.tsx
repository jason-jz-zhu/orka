import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  type Schedule,
  type ScheduleKind,
  computeDefaultLabel,
  computeNextRunAt,
  describeSchedule,
  getSchedule,
  saveSchedule,
  deleteSchedule,
  refreshNextRun,
  relativeTime,
} from "../lib/schedules";
import { alertDialog, confirmDialog } from "../lib/dialogs";
import { invokeCmd } from "../lib/tauri";

type Props = {
  pipelineName: string;
  /** When null → creating a new schedule (opens empty). When set →
   *  edit mode, loads the schedule with that label. */
  label?: string | null;
  onClose: () => void;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtIsoLocal(ms: number): string {
  // datetime-local input expects "YYYY-MM-DDTHH:MM"
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function parseIsoLocal(s: string): number {
  const d = new Date(s);
  return d.getTime();
}

export default function ScheduleModal({
  pipelineName,
  label: initialLabel = null,
  onClose,
}: Props) {
  // The label we were opened with — needed at save time so the backend
  // can clean up the old file when the label is renamed. Null means
  // "this modal is creating a brand new schedule". Frozen for the
  // lifetime of the modal.
  const [originalLabel] = useState<string | null>(initialLabel);
  const isNewSchedule = initialLabel === null;
  // Skill schedules use a `skill:<slug>` convention. The prompt+inputs
  // fields are only meaningful for these; legacy canvas pipelines run
  // via the DAG and don't accept a free-text prompt.
  const isSkillSchedule = pipelineName.startsWith("skill:");
  const skillSlug = isSkillSchedule
    ? pipelineName.slice("skill:".length)
    : null;

  const [loading, setLoading] = useState(true);
  // Default to ENABLED — the user filled out this form because they
  // want it to run. A separate "pause" toggle is available post-save.
  const [enabled, setEnabled] = useState(true);
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [intervalMin, setIntervalMin] = useState(30);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  const [onceAt, setOnceAt] = useState(() =>
    fmtIsoLocal(Date.now() + 5 * 60_000)
  );
  const [notify, setNotify] = useState(true);
  const [sound, setSound] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<Schedule["history"]>([]);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  // Schedule label → subfolder name under the skill's configured output
  // folder. Users typically leave this at the auto-computed default
  // ("daily-0900", "every-1h"); advanced users can customize.
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);
  const [outputFolder, setOutputFolder] = useState<string | null>(null);

  useEffect(() => {
    if (isNewSchedule) {
      // Empty form for "+ Add schedule". Still mark loading done so the
      // form renders. Defaults are already set in the useState calls
      // above; nothing to fetch from disk.
      setLoading(false);
      return;
    }
    let live = true;
    (async () => {
      const s = await getSchedule(pipelineName, initialLabel);
      if (!live) return;
      if (s) {
        setEnabled(s.enabled);
        setKind(s.kind);
        setNotify(s.notify);
        setSound(s.sound);
        setPrompt(s.prompt ?? "");
        setHistory(s.history ?? []);
        setLastRunAt(s.last_run_at);
        if (s.label) {
          setLabel(s.label);
          setLabelEdited(true);
        }
        const sp = s.spec as Record<string, number>;
        if (s.kind === "interval") setIntervalMin(sp.minutes ?? 30);
        else if (s.kind === "daily") {
          setHour(sp.hour ?? 9);
          setMinute(sp.minute ?? 0);
        } else if (s.kind === "weekly") {
          setWeekday(sp.weekday ?? 1);
          setHour(sp.hour ?? 9);
          setMinute(sp.minute ?? 0);
        } else if (s.kind === "once") {
          setOnceAt(fmtIsoLocal(sp.atMs ?? Date.now() + 5 * 60_000));
        }
      }
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [pipelineName, initialLabel, isNewSchedule]);

  function buildSpec(): Schedule["spec"] {
    if (kind === "interval") return { minutes: intervalMin };
    if (kind === "daily") return { hour, minute };
    if (kind === "weekly") return { weekday, hour, minute };
    return { atMs: parseIsoLocal(onceAt) };
  }

  // Backend-shape for default_label: daily uses hourLocal/minuteLocal
  // (the existing schedule spec uses hour/minute). Translate here so
  // the preview matches what runScheduledPipeline will compute.
  function specForLabel(): Record<string, unknown> {
    const s = buildSpec() as Record<string, unknown>;
    if (kind === "daily" || kind === "weekly") {
      return {
        ...s,
        hourLocal: s.hour,
        minuteLocal: s.minute,
      };
    }
    return s;
  }

  // Auto-populate the default label when the user hasn't manually edited
  // it. Re-runs when kind/spec inputs change so "daily 09:00" preview
  // becomes "daily-0900" etc.
  useEffect(() => {
    if (labelEdited) return;
    let live = true;
    (async () => {
      try {
        const def = await computeDefaultLabel(
          kind,
          specForLabel() as Schedule["spec"],
        );
        if (live) setLabel(def);
      } catch {
        // ignore — fallback label
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, intervalMin, hour, minute, weekday, onceAt, labelEdited]);

  // Load the skill's configured output folder so we can preview where
  // runs will actually land. Only meaningful for skill schedules.
  useEffect(() => {
    if (!skillSlug) return;
    let live = true;
    (async () => {
      try {
        const cfg = await invokeCmd<
          { output_folder: string } | null
        >("get_skill_output_config", { slug: skillSlug });
        if (live) setOutputFolder(cfg?.output_folder ?? null);
      } catch {
        if (live) setOutputFolder(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [skillSlug]);

  async function pickOutputFolderInline() {
    if (!skillSlug) return;
    try {
      const chosen = await openDialog({
        directory: true,
        multiple: false,
        title: `Choose output folder for ${skillSlug}`,
      });
      if (!chosen || Array.isArray(chosen)) return;
      await invokeCmd("set_skill_output_folder", {
        slug: skillSlug,
        folder: chosen,
        subfolderTemplate: null,
        scheduledSubfolderTemplate: null,
      });
      setOutputFolder(chosen);
    } catch (e) {
      await alertDialog(`Set folder failed: ${e}`);
    }
  }

  async function clearOutputFolderInline() {
    if (!skillSlug) return;
    try {
      await invokeCmd("clear_skill_output_folder", { slug: skillSlug });
      setOutputFolder(null);
    } catch (e) {
      await alertDialog(`Clear folder failed: ${e}`);
    }
  }

  async function onSave() {
    const spec = buildSpec();
    const draft: Schedule = {
      pipeline_name: pipelineName,
      kind,
      spec,
      enabled,
      notify,
      sound,
      prompt: isSkillSchedule ? (prompt.trim() || null) : null,
      inputs: null,
      label: label.trim() || null,
      last_run_at: lastRunAt,
      next_run_at: null,
      history,
    };
    const fresh = refreshNextRun(draft);
    // If user is saving with a future fire time but the schedule is
    // paused, warn. This was the single most common "my schedule
    // didn't run" complaint — someone saves once-at-10pm with Active
    // unchecked and then wonders why nothing happens.
    if (!enabled && fresh.next_run_at && fresh.next_run_at > Date.now()) {
      const proceed = await confirmDialog(
        `This schedule is paused, so it won't fire at ${new Date(fresh.next_run_at).toLocaleString()}.\n\nSave it paused anyway?`,
        {
          title: "Save paused schedule?",
          okLabel: "Save paused",
          cancelLabel: "Cancel",
        },
      );
      if (!proceed) return;
    }
    try {
      await saveSchedule(fresh, originalLabel);
    } catch (e) {
      await alertDialog(`Save failed: ${e}`);
      return;
    }
    // Tell App.tsx to refresh its "has any schedules" cache so the
    // tick loop wakes up immediately instead of waiting for the next
    // 30s interval.
    window.dispatchEvent(new Event("orka:schedule-changed"));
    onClose();
  }

  async function onDisable() {
    const displayLabel = originalLabel ?? label ?? "(default)";
    const ok = await confirmDialog(
      `Remove schedule "${displayLabel}" for "${pipelineName}"? History will be lost.`,
      { title: "Remove schedule", okLabel: "Remove", cancelLabel: "Cancel" }
    );
    if (!ok) return;
    await deleteSchedule(pipelineName, originalLabel);
    window.dispatchEvent(new Event("orka:schedule-changed"));
    onClose();
  }

  const previewNext = computeNextRunAt(kind, buildSpec(), Date.now(), lastRunAt);

  if (loading) {
    return (
      <div className="sched__overlay">
        <div className="sched__card">loading…</div>
      </div>
    );
  }

  return (
    <div className="sched__overlay">
      <div className="sched__card">
        <div className="sched__title">
          {isNewSchedule
            ? `⏰ New schedule for "${pipelineName}"`
            : `⏰ Edit "${originalLabel ?? "(default)"}" for "${pipelineName}"`}
        </div>

        <label
          className="sched__enabled"
          title={
            enabled
              ? "The schedule will fire at its next run time. Uncheck to keep the config but pause firing."
              : "Paused — the config is saved but the schedule won't fire until you check this again."
          }
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>{enabled ? "Active" : "Paused"}</span>
        </label>

        {isSkillSchedule && (
          <div className="sched__prompt-wrap">
            <label className="sched__prompt-label">
              Prompt (optional) — what to tell <code>/{skillSlug}</code> when it fires
            </label>
            <textarea
              className="sched__prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`e.g., summarize ~/code/my-project; focus on what changed this week`}
              rows={3}
            />
            <div className="sched__prompt-hint">
              Leave blank to run the skill with only its declared defaults. Anything
              you type here is prepended as free-text context to the skill's
              invocation, the same way the prompt textarea works on the Skills tab.
            </div>
          </div>
        )}

        {isSkillSchedule && (
          <div className="sched__prompt-wrap">
            <label className="sched__prompt-label">
              Output folder — where runs of this skill save
            </label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {outputFolder ? (
                <>
                  <code
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: "#cbd5e1",
                      background: "rgba(148, 163, 184, 0.08)",
                      padding: "4px 8px",
                      borderRadius: 4,
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={outputFolder}
                  >
                    📁 {shortenPathForDisplay(outputFolder)}
                  </code>
                  <button
                    type="button"
                    className="sched__btn sched__btn--secondary"
                    onClick={() => void pickOutputFolderInline()}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="sched__btn sched__btn--secondary"
                    onClick={() => void clearOutputFolderInline()}
                    title="Use Orka's default internal workdir instead"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, color: "#6b7280", fontSize: 12 }}>
                    Default (internal — not visible in Finder)
                  </span>
                  <button
                    type="button"
                    className="sched__btn sched__btn--primary"
                    onClick={() => void pickOutputFolderInline()}
                  >
                    📁 Set folder…
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {isSkillSchedule && (
          <div className="sched__prompt-wrap">
            <label className="sched__prompt-label">
              Label — subfolder name for this schedule's runs
            </label>
            <input
              className="sched__prompt-input"
              type="text"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setLabelEdited(true);
              }}
              placeholder="auto"
            />
            <div className="sched__prompt-hint">
              {outputFolder ? (
                <>
                  Runs will save to:{" "}
                  <code>
                    {shortenPathForDisplay(outputFolder)}/
                    {label || "…"}/{"{timestamp}"}/
                  </code>
                </>
              ) : (
                <>
                  (Set an output folder above to put runs where you can find
                  them in Finder.)
                </>
              )}
            </div>
          </div>
        )}

        <div className="sched__kinds">
          {(["interval", "daily", "weekly", "once"] as ScheduleKind[]).map(
            (k) => (
              <label key={k} className="sched__kind">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                <span>{k}</span>
              </label>
            )
          )}
        </div>

        <div className="sched__spec">
          {kind === "interval" && (
            <>
              every
              <input
                type="number"
                min={1}
                max={1440}
                value={intervalMin}
                onChange={(e) => setIntervalMin(Number(e.target.value))}
              />
              minutes
            </>
          )}
          {kind === "daily" && (
            <>
              at
              <input
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(e) => setHour(Number(e.target.value))}
              />
              :
              <input
                type="number"
                min={0}
                max={59}
                value={minute}
                onChange={(e) => setMinute(Number(e.target.value))}
              />
            </>
          )}
          {kind === "weekly" && (
            <>
              on
              <select
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
              >
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </select>
              at
              <input
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(e) => setHour(Number(e.target.value))}
              />
              :
              <input
                type="number"
                min={0}
                max={59}
                value={minute}
                onChange={(e) => setMinute(Number(e.target.value))}
              />
            </>
          )}
          {kind === "once" && (
            <input
              type="datetime-local"
              value={onceAt}
              onChange={(e) => setOnceAt(e.target.value)}
            />
          )}
        </div>

        <div className="sched__preview">
          {previewNext
            ? `next run: ${new Date(previewNext).toLocaleString()} (${relativeTime(previewNext)})`
            : "no future runs (already past)"}
          <span className="sched__describe"> · {describeSchedule({
            ...({} as Schedule),
            kind,
            spec: buildSpec(),
          })}</span>
        </div>

        <div className="sched__notify-row">
          <label className="sched__check">
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
            OS notification on completion
          </label>
          <label className="sched__check">
            <input
              type="checkbox"
              checked={sound}
              onChange={(e) => setSound(e.target.checked)}
            />
            Sound on completion
          </label>
        </div>

        {history.length > 0 && (
          <>
            <div className="sched__history-title">
              Last {Math.min(5, history.length)} runs
            </div>
            <div className="sched__history">
              {history.slice(0, 5).map((h, i) => (
                <div
                  key={i}
                  className={
                    "sched__hist-row " +
                    (h.ok ? "sched__hist-row--ok" : "sched__hist-row--err")
                  }
                  title={h.error ?? h.output_path ?? ""}
                >
                  <span className="sched__hist-icon">{h.ok ? "✓" : "✗"}</span>
                  <span>{new Date(h.ran_at).toLocaleString()}</span>
                  <span className="sched__hist-meta">
                    {h.ok
                      ? `${(h.duration_ms / 1000).toFixed(1)}s`
                      : (h.error ?? "fail")}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="sched__actions">
          <button
            className="sched__btn sched__btn--danger"
            onClick={onDisable}
          >
            Remove
          </button>
          <span style={{ flex: 1 }} />
          <button className="sched__btn sched__btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="sched__btn sched__btn--primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Collapse $HOME to ~ for display in previews. */
function shortenPathForDisplay(p: string): string {
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/);
  if (m) return "~" + (m[2] ?? "");
  return p;
}
