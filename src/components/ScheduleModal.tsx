import { useEffect, useState } from "react";
import {
  type Schedule,
  type ScheduleKind,
  computeNextRunAt,
  describeSchedule,
  getSchedule,
  saveSchedule,
  deleteSchedule,
  refreshNextRun,
  relativeTime,
} from "../lib/schedules";
import { confirmDialog } from "../lib/dialogs";

type Props = {
  pipelineName: string;
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

export default function ScheduleModal({ pipelineName, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
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
  const [history, setHistory] = useState<Schedule["history"]>([]);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const s = await getSchedule(pipelineName);
      if (!live) return;
      if (s) {
        setEnabled(s.enabled);
        setKind(s.kind);
        setNotify(s.notify);
        setSound(s.sound);
        setHistory(s.history ?? []);
        setLastRunAt(s.last_run_at);
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
  }, [pipelineName]);

  function buildSpec(): Schedule["spec"] {
    if (kind === "interval") return { minutes: intervalMin };
    if (kind === "daily") return { hour, minute };
    if (kind === "weekly") return { weekday, hour, minute };
    return { atMs: parseIsoLocal(onceAt) };
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
      last_run_at: lastRunAt,
      next_run_at: null,
      history,
    };
    const fresh = refreshNextRun(draft);
    await saveSchedule(fresh);
    onClose();
  }

  async function onDisable() {
    const ok = await confirmDialog(
      `Remove schedule for "${pipelineName}"? History will be lost.`,
      { title: "Remove schedule", okLabel: "Remove", cancelLabel: "Cancel" }
    );
    if (!ok) return;
    await deleteSchedule(pipelineName);
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
        <div className="sched__title">⏰ Schedule "{pipelineName}"</div>

        <label className="sched__enabled">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>

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
