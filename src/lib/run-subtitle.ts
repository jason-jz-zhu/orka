import type { RunRecord } from "./runs";

/**
 * Pick a one-line descriptor that tells a user what this run DID, so
 * three rows of the same skill don't read as identical.
 *
 * Priority:
 *   1. First input (the thing the user actually passed — repo URL,
 *      file path, etc.)
 *   2. Workdir basename (the repo / folder the run took place in)
 *   3. Empty marker so the row still renders something
 *
 * Returns the display string plus a longer `title` for hover — callers
 * should wire the latter to the HTML `title` attribute.
 */
export type RunSubtitle = {
  text: string;
  title: string;
  /** True when no input or workdir was captured — rendered dim/italic. */
  empty: boolean;
};

export function runSubtitle(run: RunRecord, maxLen = 60): RunSubtitle {
  const inputs = run.inputs ?? [];
  if (inputs.length > 0) {
    const first = String(inputs[0]);
    const extra = inputs.length > 1 ? ` (+${inputs.length - 1})` : "";
    return {
      text: truncate(first, maxLen) + extra,
      title: inputs.join("\n"),
      empty: false,
    };
  }
  if (run.workdir) {
    const base = basename(run.workdir);
    return {
      text: base,
      title: run.workdir,
      empty: false,
    };
  }
  return {
    text: "(no inputs captured)",
    title: "This run recorded no inputs or workdir.",
    empty: true,
  };
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
