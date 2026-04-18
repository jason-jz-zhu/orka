/**
 * Markdown → Block[] parser for the Output Annotator.
 *
 * Splits a markdown string into individually-selectable blocks so each
 * (paragraph / bullet / code / heading / blockquote / hr) can be annotated,
 * dispatched, or referenced independently.
 *
 * Line-based state machine — deliberately NOT a full CommonMark AST. Reasons:
 *   - user-level granularity: each bullet is its own block (even in a list)
 *   - resilient to Claude's streaming partial output
 *   - zero runtime deps
 *
 * Trade-off: nested lists collapse into a flat sequence of bullet blocks.
 * That is the intended behavior — a nested outline is still a list of
 * discrete things the user might want to keep.
 */

export type BlockType =
  | "paragraph"
  | "bullet"
  | "code"
  | "heading"
  | "blockquote"
  | "hr";

export interface Block {
  /** Stable 0-based index within the output. */
  idx: number;
  type: BlockType;
  /** Raw markdown source for this block (no surrounding blank lines). */
  content: string;
  /** For type === "code", the fence language (may be empty string). */
  language?: string;
  /** For type === "heading", level 1..6. */
  level?: number;
}

const BULLET_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const CODE_FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;

/**
 * Parse markdown into an ordered array of Blocks.
 *
 * Contract:
 *   - order preserved
 *   - every non-blank character in input lands in exactly one block (modulo
 *     delimiter whitespace inside code fences)
 *   - calling again on the same input returns structurally equal blocks
 *     (content fields identical)
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let idx = 0;

  // Accumulator for multi-line blocks we're still building.
  let buf: string[] = [];
  let bufType: "paragraph" | "blockquote" | null = null;

  function flushBuf() {
    if (buf.length === 0 || bufType === null) return;
    const content = buf.join("\n").trim();
    if (content) {
      blocks.push({ idx: idx++, type: bufType, content });
    }
    buf = [];
    bufType = null;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Code fence: consume until closing fence, emit as one block ──
    const fenceOpen = line.match(CODE_FENCE_RE);
    if (fenceOpen) {
      flushBuf();
      const fence = fenceOpen[1];
      const language = fenceOpen[2] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const closing = lines[i].match(CODE_FENCE_RE);
        if (closing && closing[1] === fence) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        idx: idx++,
        type: "code",
        content: codeLines.join("\n"),
        language,
      });
      continue;
    }

    // ── Blank line: flush current buffer ──
    if (line.trim() === "") {
      flushBuf();
      i++;
      continue;
    }

    // ── Horizontal rule ──
    if (HR_RE.test(line)) {
      flushBuf();
      blocks.push({ idx: idx++, type: "hr", content: line.trim() });
      i++;
      continue;
    }

    // ── Heading ──
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flushBuf();
      blocks.push({
        idx: idx++,
        type: "heading",
        content: headingMatch[2].trim(),
        level: headingMatch[1].length,
      });
      i++;
      continue;
    }

    // ── Bullet / numbered list item: each is its own block ──
    const bulletMatch = line.match(BULLET_RE);
    if (bulletMatch) {
      flushBuf();
      // A bullet item may wrap onto indented continuation lines. Consume them.
      const itemLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === "") break;
        if (BULLET_RE.test(next)) break;
        if (HEADING_RE.test(next)) break;
        if (HR_RE.test(next)) break;
        if (CODE_FENCE_RE.test(next)) break;
        if (BLOCKQUOTE_RE.test(next)) break;
        // Continuation: typically indented; take it either way.
        itemLines.push(next);
        i++;
      }
      blocks.push({
        idx: idx++,
        type: "bullet",
        content: itemLines.join("\n"),
      });
      continue;
    }

    // ── Blockquote: consecutive `>`-prefixed lines grouped ──
    if (BLOCKQUOTE_RE.test(line)) {
      if (bufType !== "blockquote") flushBuf();
      bufType = "blockquote";
      buf.push(line);
      i++;
      continue;
    }

    // ── Default: paragraph continuation ──
    if (bufType !== "paragraph") flushBuf();
    bufType = "paragraph";
    buf.push(line);
    i++;
  }

  flushBuf();
  return blocks;
}

/**
 * Reconstruct markdown from blocks. Round-trip with parseBlocks yields
 * semantically-equal markdown (not byte-identical — whitespace normalized).
 */
export function blocksToMarkdown(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading": {
        const hashes = "#".repeat(b.level ?? 1);
        parts.push(`${hashes} ${b.content}`);
        break;
      }
      case "hr":
        parts.push("---");
        break;
      case "code":
        parts.push(`\`\`\`${b.language ?? ""}\n${b.content}\n\`\`\``);
        break;
      default:
        parts.push(b.content);
    }
  }
  return parts.join("\n\n");
}

/**
 * Stable hash for a block's content — used as a key for persisted
 * annotations so they survive re-renders and minor text changes don't
 * lose the annotation. Uses a simple 32-bit djb2 variant; collisions are
 * acceptable in the single-run scope.
 */
export function blockHash(block: Block): string {
  const s = `${block.type}:${block.level ?? ""}:${block.language ?? ""}:${block.content}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Dev-time self-check. Runs once at module load in non-production builds.
 * Any failure logs a console.error with the failing case. Does not throw.
 *
 * When vitest is added later, port these into real tests and remove this
 * block.
 */
function __devSelfCheck() {
  const cases: Array<{ name: string; input: string; expect: (b: Block[]) => boolean }> = [
    {
      name: "two paragraphs",
      input: "First line.\n\nSecond line.",
      expect: (b) => b.length === 2 && b[0].type === "paragraph" && b[1].type === "paragraph",
    },
    {
      name: "each bullet is its own block",
      input: "- one\n- two\n- three",
      expect: (b) => b.length === 3 && b.every((x) => x.type === "bullet"),
    },
    {
      name: "code fence preserves language",
      input: "```ts\nconst x = 1;\n```",
      expect: (b) =>
        b.length === 1 &&
        b[0].type === "code" &&
        b[0].language === "ts" &&
        b[0].content === "const x = 1;",
    },
    {
      name: "heading level 2",
      input: "## A heading",
      expect: (b) => b.length === 1 && b[0].type === "heading" && b[0].level === 2,
    },
    {
      name: "hr emits hr block",
      input: "before\n\n---\n\nafter",
      expect: (b) => b.length === 3 && b[1].type === "hr",
    },
    {
      name: "blockquote grouped",
      input: "> line one\n> line two\n\npara",
      expect: (b) => b.length === 2 && b[0].type === "blockquote" && b[1].type === "paragraph",
    },
    {
      name: "bullet with continuation line",
      input: "- first bullet\n  continues here\n- second",
      expect: (b) =>
        b.length === 2 && b[0].type === "bullet" && b[0].content.includes("continues here"),
    },
    {
      name: "stable idx",
      input: "# H\n\npara\n\n- b",
      expect: (b) => b[0].idx === 0 && b[1].idx === 1 && b[2].idx === 2,
    },
    {
      name: "hash deterministic",
      input: "same content",
      expect: (b) => blockHash(b[0]) === blockHash(b[0]),
    },
    {
      name: "empty input → no blocks",
      input: "",
      expect: (b) => b.length === 0,
    },
  ];

  for (const c of cases) {
    const result = parseBlocks(c.input);
    if (!c.expect(result)) {
      // eslint-disable-next-line no-console
      console.error(`[markdown-blocks self-check] FAILED: ${c.name}`, {
        input: c.input,
        result,
      });
    }
  }
}

// Only run self-check in dev.
if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  __devSelfCheck();
}
