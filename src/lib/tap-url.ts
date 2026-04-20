// URL normalization for "Add tap" UX. Accepts every shape a user
// might copy/paste (GitHub shortcut, HTTPS URL with or without
// `.git`, SSH git@ form) and returns a canonical URL the backend
// `add_custom_tap` + `install_tap` flow can consume.
//
// Parsing is intentionally forgiving but never upgrades `http://` to
// `https://` silently — that's a security decision (see backend
// `trusted_taps.rs::add_tap`). Users pasting bare `http://` get a
// clear error rather than a stealth rewrite.

export interface ParsedTap {
  /** Canonical URL safe to pass to `git clone`. */
  url: string;
  /** Best-guess default id from the URL path (`user/repo` → `repo`). */
  defaultId: string;
  /** Best-guess display name (`user/repo`). */
  defaultName: string;
  /** Host label for UI, e.g. "github.com" or "SSH". */
  hostLabel: string;
}

const SHORTCUT_RE = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const HOST_RE = /^(?:https?:\/\/)?([\w.-]+)(\/.*)$/;
const SSH_RE = /^git@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

/**
 * Parse and canonicalize a tap URL. Throws on inputs we can't trust
 * (bare `http://`, malformed). Caller displays the error inline.
 */
export function normalizeTapUrl(raw: string): ParsedTap {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("URL is required");

  // SSH form: git@github.com:user/repo[.git]
  const sshMatch = trimmed.match(SSH_RE);
  if (sshMatch) {
    const [, host, user, repo] = sshMatch;
    return {
      url: `git@${host}:${user}/${repo}.git`,
      defaultId: slugify(repo),
      defaultName: `${user}/${repo}`,
      hostLabel: `SSH · ${host}`,
    };
  }

  // GitHub-style shortcut: `user/repo` (no scheme, no dots before /).
  // Distinguish from `github.com/user/repo` by testing SHORTCUT_RE
  // ONLY if no `/` follows a host-like path. Keep it strict: require
  // exactly one slash and no `://`.
  if (!trimmed.includes("://") && !trimmed.includes(":") && SHORTCUT_RE.test(trimmed)) {
    const m = trimmed.match(SHORTCUT_RE);
    if (m) {
      const [, user, repo] = m;
      return {
        url: `https://github.com/${user}/${repo}`,
        defaultId: slugify(repo),
        defaultName: `${user}/${repo}`,
        hostLabel: "github.com",
      };
    }
  }

  // http:// rejected explicitly — fall through to the HTTPS check.
  if (trimmed.toLowerCase().startsWith("http://")) {
    throw new Error(
      "plain http:// is rejected — use https:// or git@ (SSH). See README security notes.",
    );
  }

  // HTTPS form, with or without scheme, with or without `.git`.
  let withScheme = trimmed;
  if (!withScheme.toLowerCase().startsWith("https://")) {
    // `github.com/user/repo` → prepend scheme
    if (HOST_RE.test(trimmed)) {
      withScheme = "https://" + trimmed;
    } else {
      throw new Error(
        `unrecognized URL shape: ${raw}. Use \`user/repo\`, a full https:// URL, or git@host:user/repo`,
      );
    }
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  // Strip trailing `.git` for display and canonical URL — git clone
  // accepts both; the version without is what GitHub's UI shows.
  const cleanedPath = url.pathname.replace(/\.git$/, "").replace(/\/$/, "");
  url.pathname = cleanedPath;
  const parts = cleanedPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`URL must point at a repo (e.g. /user/repo): ${raw}`);
  }
  const [user, repo] = parts.slice(-2);
  return {
    url: url.toString().replace(/\/$/, ""),
    defaultId: slugify(repo),
    defaultName: `${user}/${repo}`,
    hostLabel: url.host,
  };
}

/** Lowercase, alnum+dash only, cap at 32 chars. Good default id shape. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
