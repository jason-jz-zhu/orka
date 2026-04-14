import { useEffect, useMemo, useRef, useState } from "react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import type {
  ProjectInfo,
  SessionInfo,
  SessionStatus,
} from "../lib/session-types";
import { useGraph } from "../lib/graph-store";

type Filter = "all" | "live" | "done" | "errored";

function fmtAgo(ms: number): string {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function statusColor(s: SessionStatus): string {
  switch (s) {
    case "live":
      return "#ff6b6b";
    case "done":
      return "#6bd76b";
    case "errored":
      return "#ffa24b";
    default:
      return "#6b7280";
  }
}

function statusDot(s: SessionStatus) {
  return (
    <span
      className="sidebar__dot"
      style={{ background: statusColor(s) }}
      title={s}
    />
  );
}

type Props = {
  onSessionClick?: (s: SessionInfo) => void;
  selectedSessionId?: string | null;
};

export default function SessionsSidebar({
  onSessionClick,
  selectedSessionId,
}: Props = {}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sessions, setSessions] = useState<Record<string, SessionInfo[]>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("live");
  const [hideDone, setHideDone] = useState(true);
  const [showOrka, setShowOrka] = useState(false);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const addSessionNode = useGraph((s) => s.addSessionNode);

  async function refreshProjects() {
    try {
      const p = await invokeCmd<ProjectInfo[]>("list_projects");
      setProjects(p);
    } catch (e) {
      console.warn("list_projects failed:", e);
    } finally {
      setLoading(false);
    }
  }

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function refreshDebounced() {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      refreshProjects();
    }, 250);
  }

  useEffect(() => {
    refreshProjects();
    // Kick off the Rust-side fs watcher; emits `sessions:changed` on any change.
    invokeCmd("start_projects_watcher").catch(() => {});
    let unlisten: (() => void) | null = null;
    listenEvent("sessions:changed", () => refreshDebounced()).then(
      (fn) => (unlisten = fn)
    );
    // Safety poll as a fallback (every 10s) in case fs events are missed.
    const t = setInterval(refreshProjects, 10_000);
    return () => {
      clearInterval(t);
      unlisten?.();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Refresh loaded sessions when a change fires, so expanded projects update too.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenEvent("sessions:changed", async () => {
      const keys = Object.keys(expanded).filter((k) => expanded[k]);
      for (const key of keys) {
        try {
          const list = await invokeCmd<SessionInfo[]>("list_sessions", {
            projectKey: key,
          });
          setSessions((prev) => ({ ...prev, [key]: list }));
        } catch {}
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [expanded]);

  async function toggleProject(p: ProjectInfo) {
    const wasOpen = !!expanded[p.key];
    setExpanded({ ...expanded, [p.key]: !wasOpen });
    if (!wasOpen) {
      try {
        const list = await invokeCmd<SessionInfo[]>("list_sessions", {
          projectKey: p.key,
        });
        setSessions((prev) => ({ ...prev, [p.key]: list }));
      } catch (e) {
        console.warn("list_sessions failed:", e);
      }
    }
  }

  function pin(s: SessionInfo) {
    if (onSessionClick) {
      onSessionClick(s);
      return;
    }
    addSessionNode({
      sessionId: s.id,
      path: s.path,
      projectCwd: s.project_cwd,
    });
  }

  // Exclude Orka's own spawned sessions unless the user opts in.
  const visibleProjects = useMemo(
    () => (showOrka ? projects : projects.filter((p) => !p.is_orka)),
    [projects, showOrka]
  );

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visibleProjects.filter((p) => {
      if (
        q &&
        !p.name.toLowerCase().includes(q) &&
        !p.cwd.toLowerCase().includes(q)
      ) {
        return false;
      }
      const c = p.status_counts;
      // Apply the active pill — the project must contain at least one session of that status.
      if (filter === "live" && c.live === 0) return false;
      if (filter === "done" && c.done === 0) return false;
      if (filter === "errored" && c.errored === 0) return false;
      // "All" with hideDone: hide projects whose only sessions are Done.
      if (filter === "all" && hideDone) {
        const active = c.live + c.errored;
        if (active === 0) return false;
      }
      return true;
    });
  }, [visibleProjects, query, filter, hideDone]);

  // Totals use the currently-visible set (Orka sessions included only when toggled on).
  const counts = useMemo(() => {
    const c: Record<SessionStatus, number> = {
      live: 0,
      done: 0,
      errored: 0,
      idle: 0,
    };
    for (const p of visibleProjects) {
      c.live += p.status_counts.live;
      c.done += p.status_counts.done;
      c.errored += p.status_counts.errored;
      c.idle += p.status_counts.idle;
    }
    return c;
  }, [visibleProjects]);

  const hiddenOrkaCount = useMemo(
    () => projects.filter((p) => p.is_orka).length,
    [projects]
  );

  function matches(s: SessionInfo): boolean {
    if (hideDone && s.status === "done") return false;
    return filter === "all" || s.status === filter;
  }

  if (collapsed) {
    return (
      <div className="sidebar sidebar--collapsed">
        <button
          className="sidebar__toggle"
          onClick={() => setCollapsed(false)}
          title="Show sessions"
        >
          »
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">Sessions</span>
        <button
          className="sidebar__toggle"
          onClick={() => setCollapsed(true)}
          title="Hide sidebar"
        >
          «
        </button>
      </div>
      <div className="sidebar__summary">
        <span style={{ color: statusColor("live") }}>{counts.live} live</span>
        {" · "}
        <span style={{ color: statusColor("done") }}>{counts.done} done</span>
        {counts.errored > 0 && (
          <>
            {" · "}
            <span style={{ color: statusColor("errored") }}>
              {counts.errored} err
            </span>
          </>
        )}
        {hiddenOrkaCount > 0 && (
          <label className="sidebar__toggle-orka" title="Show sessions spawned by Orka nodes">
            <input
              type="checkbox"
              checked={showOrka}
              onChange={(e) => setShowOrka(e.target.checked)}
            />
            <span>Orka ({hiddenOrkaCount})</span>
          </label>
        )}
        <label
          className="sidebar__toggle-orka"
          title="Show completed sessions (default hidden)"
        >
          <input
            type="checkbox"
            checked={!hideDone}
            onChange={(e) => setHideDone(!e.target.checked)}
          />
          <span>Show done</span>
        </label>
      </div>
      <div className="sidebar__filter">
        {(["all", "live", "done", "errored"] as Filter[]).map((f) => (
          <button
            key={f}
            className={
              "sidebar__filter-pill" +
              (filter === f ? " sidebar__filter-pill--active" : "")
            }
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <input
        className="sidebar__search"
        placeholder="Filter projects…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <div className="sidebar__status">loading…</div>}
      {!loading && filteredProjects.length === 0 && (
        <div className="sidebar__status">no projects</div>
      )}
      <div className="sidebar__list">
        {filteredProjects.map((p) => {
          const ss = (sessions[p.key] ?? []).filter(matches);
          const open = !!expanded[p.key];
          // Hide the project entirely when a filter is active and it has no matches loaded.
          if (open && filter !== "all" && ss.length === 0 && sessions[p.key])
            return null;
          return (
            <div key={p.key} className="sidebar__project">
              <div
                className="sidebar__project-row"
                onClick={() => toggleProject(p)}
              >
                <span className="sidebar__project-caret">
                  {open ? "▾" : "▸"}
                </span>
                <span className="sidebar__project-name" title={p.cwd}>
                  {p.name}
                  {p.is_orka && (
                    <span className="sidebar__orka-tag" title="Spawned by Orka">
                      {" "}⊙
                    </span>
                  )}
                </span>
                <span className="sidebar__project-meta">
                  {p.session_count} · {fmtAgo(p.last_modified_ms)}
                </span>
              </div>
              {open && (
                <div className="sidebar__sessions">
                  {ss.map((s) => (
                    <div
                      key={s.id}
                      className={
                        "sidebar__session" +
                        (selectedSessionId === s.id
                          ? " sidebar__session--active"
                          : "")
                      }
                      onClick={() => pin(s)}
                      title={
                        s.last_message_preview ||
                        s.first_user_preview ||
                        s.id
                      }
                    >
                      <div className="sidebar__session-head">
                        {statusDot(s.status)}
                        <span className="sidebar__session-id">
                          {s.id.slice(0, 8)}
                        </span>
                        <span className="sidebar__session-turns">
                          {s.turn_count}t
                        </span>
                        <span className="sidebar__session-ago">
                          {fmtAgo(s.modified_ms)}
                        </span>
                      </div>
                      <div className="sidebar__session-preview">
                        {s.last_message_preview ||
                          s.first_user_preview ||
                          "(empty)"}
                      </div>
                    </div>
                  ))}
                  {ss.length === 0 && !sessions[p.key] && (
                    <div className="sidebar__status">loading…</div>
                  )}
                  {ss.length === 0 && sessions[p.key] && (
                    <div className="sidebar__status">
                      (no {filter} sessions)
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
