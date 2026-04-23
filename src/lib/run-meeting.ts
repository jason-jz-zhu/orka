import type { RunRecord } from "./runs";

/**
 * From a set of selected run ids, return the UNIQUE session_ids we'd
 * invite to a meeting. Two virtues:
 *  - A run without `session_id` (legacy rows, direct `claude -p` calls)
 *    can't join — we silently drop it.
 *  - Multiple runs against the same session (e.g. repeated `--resume`)
 *    dedupe to one attendee; Claude reading the tail twice would just
 *    burn tokens.
 *
 * Pure function so we can exercise the rules without mocking Tauri.
 */
export function meetingSessionIdsForRuns(
  runs: RunRecord[],
  selected: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of runs) {
    if (!selected.has(r.id)) continue;
    const sid = r.session_id;
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    out.push(sid);
  }
  return out;
}
