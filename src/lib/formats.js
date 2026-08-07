/**
 * Bookmark Bar Switcher - import / export file formats.
 *
 * Every format is a codec around ONE intermediate shape: the native export
 * payload produced by core.js `exportSingleSet()` -
 *
 *   { version, exportedAt, bars: {…}, sets: [ { title, children } ] }
 *   node := { title, url }  |  { title, children: [node…] }
 *
 * so `serialize()` / `parse()` are the only things a new format has to supply,
 * and both ends of the pipeline (downloadBar / importSetsAsNewBars) stay
 * format-blind. Adding a format = one entry in FORMATS.
 *
 * JSON is the only LOSSLESS format: it carries the payload verbatim, including
 * the `bars` map that re-links a restored bar to its common bars. The text
 * formats (Markdown, BBCode, AsciiDoc) are a folder/link tree and nothing
 * else - exporting to one and importing it back loses the commons config, and
 * the imported bar keeps only its name, folders and links. That is the deal
 * with a human-readable, paste-into-a-forum file, and the settings hint says so.
 *
 * One more text-format asymmetry, deliberate: a bookmark with an EMPTY title is
 * written with its URL as the label, because a bullet with no text is invisible
 * in every one of these formats (and `[](url)` / `url[]` break some renderers).
 * It therefore comes back titled with its URL - which is what the browser
 * displays for an untitled bookmark anyway. JSON keeps the empty title.
 *
 * Import never trusts the file: a parsed link is only emitted when its URL
 * survives `new URL()`, so a mangled or hand-edited document cannot abort a
 * half-finished import with a bookmarks.create() throw.
 */

const PAYLOAD_VERSION = 2;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Bookmark titles are single-line; collapse anything a file may have wrapped. */
function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** A URL is usable only if the browser can parse it - otherwise drop the link. */
function usableUrl(u) {
  const s = String(u ?? "").trim();
  if (!s) return null;
  try {
    new URL(s);
    return s;
  } catch {
    return null;
  }
}

/** Wrap a parsed tree in the native payload shape so import stays format-blind. */
function toPayload(title, children) {
  return {
    version: PAYLOAD_VERSION,
    exportedAt: null, // unknown - importSetsAsNewBars() falls back to today
    bars: {},
    sets: [{ title: title == null ? null : oneLine(title), children }],
  };
}

/** The one set of a payload, for the single-bar text formats. */
function firstSet(payload) {
  const set = payload?.sets?.[0];
  if (!set) throw new Error("Nothing to export");
  return { title: oneLine(set.title), children: set.children || [] };
}

/** Depth-first walk emitting one line per node, indented by `depth`. */
function walk(nodes, depth, emitLink, emitFolder) {
  for (const n of nodes || []) {
    if (typeof n.url === "string") {
      emitLink(n, depth);
    } else {
      emitFolder(n, depth);
      walk(n.children || [], depth + 1, emitLink, emitFolder);
    }
  }
}

/** Total link count of a parsed tree - used to reject a file that parsed to nothing. */
export function countLinks(nodes) {
  let n = 0;
  for (const node of nodes || []) {
    if (typeof node.url === "string") n++;
    else n += countLinks(node.children);
  }
  return n;
}

// ---------------------------------------------------------------------------
// JSON - the native, lossless format
// ---------------------------------------------------------------------------

function jsonSerialize(payload) {
  // Escape every non-ASCII codepoint as \uXXXX so the file is byte-identical
  // under UTF-8, Latin-1, or cp1252 - survives a round-trip through any editor
  // that might re-save it with the system codepage. Only JSON can do this; the
  // text formats have to stay readable, so they are written as plain UTF-8.
  return JSON.stringify(payload, null, 2).replace(
    /[-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function jsonParse(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || !Array.isArray(data.sets)) {
    throw new Error("MISSING_SETS");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Markdown - `# Bar` + a nested `- [title](url)` list
// ---------------------------------------------------------------------------

function mdEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/([*_`[\]])/g, "\\$1");
}

function mdUnescape(s) {
  return s.replace(/\\([\\*_`[\]])/g, "$1");
}

/** Angle-bracket a URL that would break `](url)` parsing. */
function mdUrl(u) {
  return /[()\s<>]/.test(u) ? "<" + u.replace(/[<>]/g, encodeURIComponent) + ">" : u;
}

function mdSerialize(payload) {
  const set = firstSet(payload);
  const out = [`# ${mdEscape(set.title)}`, ""];
  walk(
    set.children,
    0,
    (n, d) => out.push(`${"  ".repeat(d)}- [${mdEscape(oneLine(n.title) || n.url)}](${mdUrl(n.url)})`),
    (n, d) => out.push(`${"  ".repeat(d)}- **${mdEscape(oneLine(n.title))}**`),
  );
  return out.join("\n") + "\n";
}

/** Strip the emphasis wrappers a folder bullet may carry. */
function stripEmphasis(s) {
  let t = s.trim();
  for (;;) {
    const m = /^(\*\*|__|\*|_|`)([\s\S]+)\1$/.exec(t);
    if (!m) return t;
    t = m[2].trim();
  }
}

function mdItem(content) {
  const s = content.trim();
  if (!s) return null;

  // [label](url) - greedy label so a title containing "]" still round-trips.
  const link = /^\[([\s\S]*)\]\(\s*(?:<([^>]*)>|([^)\s]*))[^)]*\)\s*$/.exec(s);
  if (link) {
    const url = usableUrl(link[2] != null ? link[2] : link[3]);
    if (!url) return null;
    return { title: oneLine(mdUnescape(link[1])) || url, url };
  }

  // A bare URL, with or without angle brackets.
  const bare = usableUrl(s.replace(/^<|>$/g, ""));
  if (bare && /^[a-z][a-z0-9+.-]*:/i.test(s.replace(/^</, ""))) {
    return { title: bare, url: bare };
  }

  return { title: oneLine(mdUnescape(stripEmphasis(s))), children: [] };
}

function mdParse(text) {
  let title = null;
  const root = [];
  // Sentinel at indent -1 so the root list can never be popped.
  const stack = [{ indent: -1, children: root }];

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");

    if (title === null) {
      const h = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
      if (h) {
        title = oneLine(mdUnescape(h[1]));
        continue;
      }
    }

    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const item = mdItem(m[2]);
    if (!item) continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].children.push(item);
    if (item.children) stack.push({ indent, children: item.children });
  }

  return toPayload(title, root);
}

// ---------------------------------------------------------------------------
// BBCode - `[list]` / `[*]` / `[url=…]`, the forum-paste format
// ---------------------------------------------------------------------------

/** BBCode has no escape character; keep "]" out of the tag argument instead. */
function bbUrl(u) {
  return u.replace(/]/g, "%5D");
}

/** Emit `[list] … [/list]` for one level; folders recurse into their own list. */
function bbList(nodes, depth, out) {
  const pad = "  ".repeat(depth);
  out.push(`${pad}[list]`);
  for (const n of nodes || []) {
    if (typeof n.url === "string") {
      out.push(`${pad}  [*][url=${bbUrl(n.url)}]${oneLine(n.title) || n.url}[/url]`);
    } else {
      out.push(`${pad}  [*][b]${oneLine(n.title)}[/b]`);
      bbList(n.children || [], depth + 1, out);
    }
  }
  out.push(`${pad}[/list]`);
}

function bbSerialize(payload) {
  const set = firstSet(payload);
  const out = [`[b]${set.title}[/b]`, ""];
  bbList(set.children, 0, out);
  return out.join("\n") + "\n";
}

function bbItem(content) {
  const s = content.trim();
  if (!s) return null;

  let m = /^\[url=([^\]]+)]([\s\S]*)\[\/url]\s*$/i.exec(s);
  if (m) {
    const url = usableUrl(m[1]);
    if (!url) return null;
    return { title: oneLine(bbUnwrap(m[2])) || url, url };
  }

  m = /^\[url]([\s\S]*)\[\/url]\s*$/i.exec(s);
  if (m) {
    const url = usableUrl(m[1]);
    return url ? { title: url, url } : null;
  }

  const bare = usableUrl(s);
  if (bare && /^[a-z][a-z0-9+.-]*:/i.test(s)) return { title: bare, url: bare };

  return { title: oneLine(bbUnwrap(s)), children: [] };
}

/**
 * Peel the formatting tags a label is WRAPPED in - `[b]Dev[/b]` → `Dev`.
 * Deliberately not a global tag strip: a bookmark whose title happens to
 * contain "[b]" must keep it, and BBCode has no escape character to tell the
 * two apart. Only a pair that encloses the whole label is markup.
 */
function bbUnwrap(s) {
  let t = s.trim();
  for (;;) {
    const m = /^\[(b|i|u|s|color|size|font)(?:=[^\]]*)?]([\s\S]*)\[\/\1]$/i.exec(t);
    if (!m) return t;
    t = m[2].trim();
  }
}

function bbParse(text) {
  const parts = String(text).split(/(\[list(?:=[^\]]*)?]|\[\/list]|\[\*])/i);
  const root = [];
  const stack = [root];
  let current = null; // the item a following [list] would turn into a folder
  let expectItem = false;
  let title = null;
  let sawList = false;

  for (const part of parts) {
    if (/^\[list/i.test(part)) {
      sawList = true;
      if (current) {
        // The item before this list is its parent folder, not a link.
        delete current.url;
        current.children = [];
        stack.push(current.children);
      } else {
        // Outermost list (or a stray one): re-push the same level so the
        // matching [/list] pops symmetrically instead of unbalancing the stack.
        stack.push(stack[stack.length - 1]);
      }
      current = null;
      expectItem = false;
      continue;
    }
    if (/^\[\/list]/i.test(part)) {
      if (stack.length > 1) stack.pop();
      const top = stack[stack.length - 1];
      current = top.length ? top[top.length - 1] : null;
      expectItem = false;
      continue;
    }
    if (/^\[\*]/.test(part)) {
      expectItem = true;
      continue;
    }

    if (expectItem) {
      expectItem = false;
      const item = bbItem(part);
      if (!item) continue;
      stack[stack.length - 1].push(item);
      current = item;
    } else if (!sawList && title === null) {
      // Everything before the first [list] is the document heading.
      const head = oneLine(bbUnwrap(part));
      if (head) title = head;
    }
  }

  return toPayload(title, root);
}

// ---------------------------------------------------------------------------
// AsciiDoc - `= Bar` + `*`-depth list with `url[label]` links
// ---------------------------------------------------------------------------

/** AsciiDoc renders these schemes as bare macros; anything else needs `link:`. */
const ADOC_BARE_SCHEMES = /^(?:https?|ftp|irc|mailto|file):/i;

function adocEscape(s) {
  return s.replace(/]/g, "\\]");
}

function adocSerialize(payload) {
  const set = firstSet(payload);
  const out = [`= ${set.title}`, ""];
  walk(
    set.children,
    0,
    (n, d) => {
      const label = adocEscape(oneLine(n.title) || n.url);
      const prefix = ADOC_BARE_SCHEMES.test(n.url) ? "" : "link:";
      out.push(`${"*".repeat(d + 1)} ${prefix}${n.url}[${label}]`);
    },
    (n, d) => out.push(`${"*".repeat(d + 1)} *${adocEscape(oneLine(n.title))}*`),
  );
  return out.join("\n") + "\n";
}

function adocItem(content) {
  const s = content.trim();
  if (!s) return null;

  const link = /^(?:link:)?(\S+?)\[([\s\S]*)]\s*$/.exec(s);
  if (link) {
    const url = usableUrl(link[1]);
    if (url) return { title: oneLine(link[2].replace(/\\]/g, "]")) || url, url };
  }

  const bare = usableUrl(s.replace(/^link:/i, ""));
  if (bare && /^[a-z][a-z0-9+.-]*:/i.test(s.replace(/^link:/i, ""))) {
    return { title: bare, url: bare };
  }

  return { title: oneLine(stripEmphasis(s)), children: [] };
}

function adocParse(text) {
  let title = null;
  const root = [];
  const stack = [{ depth: 0, children: root }];

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();

    if (title === null) {
      const h = /^=\s+(.*\S)\s*$/.exec(line);
      if (h) {
        title = oneLine(h[1]);
        continue;
      }
    }

    const m = /^(\*+|-)\s+(.*)$/.exec(line);
    if (!m) continue;
    const depth = m[1] === "-" ? 1 : m[1].length;
    const item = adocItem(m[2]);
    if (!item) continue;

    while (stack.length > 1 && depth <= stack[stack.length - 1].depth) stack.pop();
    stack[stack.length - 1].children.push(item);
    if (item.children) stack.push({ depth, children: item.children });
  }

  return toPayload(title, root);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * `name` is a proper noun and is deliberately NOT translated. `exts[0]` is the
 * extension used when writing a file; the rest are accepted on import.
 */
export const FORMATS = [
  {
    id: "json",
    name: "JSON",
    exts: ["json"],
    mime: "application/json;charset=utf-8",
    lossless: true,
    serialize: jsonSerialize,
    parse: jsonParse,
  },
  {
    id: "markdown",
    name: "Markdown",
    exts: ["md", "markdown"],
    mime: "text/markdown;charset=utf-8",
    lossless: false,
    serialize: mdSerialize,
    parse: mdParse,
  },
  {
    id: "bbcode",
    name: "BBCode",
    exts: ["bbcode", "bb"],
    mime: "text/plain;charset=utf-8",
    lossless: false,
    serialize: bbSerialize,
    parse: bbParse,
  },
  {
    id: "asciidoc",
    name: "AsciiDoc",
    exts: ["adoc", "asciidoc", "asc"],
    mime: "text/plain;charset=utf-8",
    lossless: false,
    serialize: adocSerialize,
    parse: adocParse,
  },
];

export const DEFAULT_FORMAT_ID = "json";

export function getFormat(id) {
  return FORMATS.find(f => f.id === id) || FORMATS.find(f => f.id === DEFAULT_FORMAT_ID);
}

/** Lower-case extension of a filename, without the dot ("" if there is none). */
export function fileExt(filename) {
  const m = /\.([^.\\/]+)$/.exec(String(filename || ""));
  return m ? m[1].toLowerCase() : "";
}

/** The format that owns a file extension, or null when nothing claims it. */
export function formatForFile(filename) {
  const ext = fileExt(filename);
  if (!ext) return null;
  return FORMATS.find(f => f.exts.includes(ext)) || null;
}

/** `accept` attribute for the import file input - every extension we can read. */
export function acceptAttribute() {
  return FORMATS.flatMap(f => f.exts.map(e => "." + e)).join(",");
}

/** Human list of importable extensions, for the "unrecognized file" error. */
export function extensionList() {
  return FORMATS.flatMap(f => f.exts.map(e => "." + e)).join(", ");
}
