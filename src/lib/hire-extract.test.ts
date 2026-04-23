import { describe, expect, it } from "vitest";
import { extractSkillMdDraft } from "./hire-extract";

describe("extractSkillMdDraft", () => {
  it("returns null on empty / missing text", () => {
    expect(extractSkillMdDraft("")).toBeNull();
    expect(extractSkillMdDraft("hello, no fences here")).toBeNull();
  });

  it("picks a tagged ```skill-md block and its slug", () => {
    const text = [
      "Sure, here's a draft:",
      "",
      "```skill-md",
      "---",
      "name: daily-digest",
      "description: Summarize my notes",
      "---",
      "",
      "# Daily Digest",
      "Do the thing.",
      "```",
      "",
      "Want me to tweak anything?",
    ].join("\n");
    const draft = extractSkillMdDraft(text);
    expect(draft).not.toBeNull();
    expect(draft!.slug).toBe("daily-digest");
    expect(draft!.content).toContain("name: daily-digest");
    expect(draft!.content).toContain("# Daily Digest");
  });

  it("prefers the LAST tagged block when multiple drafts appear", () => {
    const text = [
      "```skill-md",
      "---",
      "name: v1-draft",
      "---",
      "old body",
      "```",
      "On reflection:",
      "```skill-md",
      "---",
      "name: v2-draft",
      "---",
      "new body",
      "```",
    ].join("\n");
    const draft = extractSkillMdDraft(text);
    expect(draft!.slug).toBe("v2-draft");
    expect(draft!.content).toContain("new body");
  });

  it("falls back to a plain fence when frontmatter is present", () => {
    const text = [
      "```markdown",
      "---",
      "name: weekly-review",
      "description: Weekly recap",
      "---",
      "# Weekly Review",
      "```",
    ].join("\n");
    const draft = extractSkillMdDraft(text);
    expect(draft).not.toBeNull();
    expect(draft!.slug).toBe("weekly-review");
  });

  it("normalises spaces / casing in the suggested slug", () => {
    const text = [
      "```skill-md",
      "---",
      'name: "Weekly PR Summarizer"',
      "---",
      "body",
      "```",
    ].join("\n");
    const draft = extractSkillMdDraft(text);
    expect(draft!.slug).toBe("weekly-pr-summarizer");
  });

  it("returns null when there is a fence but no frontmatter", () => {
    const text = [
      "```skill-md",
      "no frontmatter here",
      "just a body",
      "```",
    ].join("\n");
    const draft = extractSkillMdDraft(text);
    // The tagged-fence branch still returns the content even without a
    // parseable slug — the save path will reject it, but we want the
    // preview to render so the user can fix the draft.
    expect(draft).not.toBeNull();
    expect(draft!.slug).toBeNull();
  });

  it("ignores an unterminated fence", () => {
    const text = "```skill-md\n---\nname: half\n---\nmissing closing fence";
    expect(extractSkillMdDraft(text)).toBeNull();
  });
});
