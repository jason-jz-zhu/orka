/**
 * Detect SKILL.md drafts inside an assistant's streaming reply.
 *
 * The hire-chat backend prompts Claude to wrap drafts in a fenced
 * `skill-md` code block — looks for that first. Falls back to any
 * fenced block that starts with a valid YAML frontmatter header
 * (```\n---\nname: ...\n---\n...) so we still catch drafts when
 * Claude picks a different fence tag. Returns the LAST candidate
 * in the text (most recent iteration) to favour the newest version
 * if Claude revised during the same turn.
 */
export type SkillMdDraft = {
  /** Body between the fences, trimmed. Includes frontmatter + prose. */
  content: string;
  /** Slug suggested by the `name:` field in the frontmatter, or null
   *  if the frontmatter was missing or unparseable. */
  slug: string | null;
};

export function extractSkillMdDraft(text: string): SkillMdDraft | null {
  if (!text) return null;
  // Prefer explicitly-tagged blocks.
  const tagged = findAllFenced(text, /^\s*```\s*skill-md\s*$/m);
  if (tagged.length > 0) {
    const body = tagged[tagged.length - 1];
    return { content: body.trim(), slug: parseSlug(body) };
  }
  // Fallback: any fenced block whose first non-blank line is `---` and
  // that has a valid frontmatter `name:`.
  const untagged = findAllFenced(text, /^\s*```(?:\s*\w+)?\s*$/m);
  for (let i = untagged.length - 1; i >= 0; i--) {
    const slug = parseSlug(untagged[i]);
    if (slug) return { content: untagged[i].trim(), slug };
  }
  return null;
}

function findAllFenced(text: string, opener: RegExp): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (opener.test(lines[i])) {
      const start = i + 1;
      let end = -1;
      for (let j = start; j < lines.length; j++) {
        if (/^\s*```\s*$/.test(lines[j])) {
          end = j;
          break;
        }
      }
      if (end === -1) break;
      out.push(lines.slice(start, end).join("\n"));
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return out;
}

function parseSlug(body: string): string | null {
  // Expect YAML frontmatter at the top: `---\n...\n---`.
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith("---")) return null;
  const afterFirst = trimmed.slice(3).replace(/^\r?\n/, "");
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return null;
  const fm = afterFirst.slice(0, endIdx);
  const m = fm.match(/^name:\s*(.+?)\s*$/m);
  if (!m) return null;
  const raw = m[1].replace(/^["']|["']$/g, "");
  // Defer strict sanitisation to the Rust save command; here we just
  // lightly normalise so the preview shows a reasonable folder name.
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
