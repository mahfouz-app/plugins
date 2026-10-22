// Wikilinks in a presented deck. The app (`host.slides.deck`) resolves every
// `[[…]]` in the deck's files, keyed by its raw inner text; this module turns
// each one in a slide's Markdown into its label, and a link to a note that's
// part of the deck into `<MahfouzLink :part="k">` (components/MahfouzLink.vue),
// which finds that part's first slide at runtime. setup/transformers.ts runs
// it on every slide. Pure, no imports: the tests load it directly.
//
// Vault content is untrusted: a label is always escaped and wrapped in
// `<span v-pre>`, so neither Markdown nor HTML nor a Vue `{{ }}` in it does
// anything; a path never reaches the markup, only a part's index does.

/**
 * Calls `onLink(start, end, target, alias)` for every `[[target]]` and
 * `[[target|alias]]` in `s`, leftmost first and without overlap: the app's
 * `replaceWikilinks` (src/core/src/markdown/wikilinkScan.ts), ported, so the
 * raw keys read here are the keys the app resolved. A target is one or more
 * characters other than `]` and `|`, an alias one or more other than `]`,
 * newlines included in both. Linear in the input.
 */
export function scanWikilinks(s, onLink) {
  const n = s.length;
  let stop = -1;
  let close = -1;
  const nextStop = (p) => {
    if (stop < p) {
      stop = p;
      while (stop < n && s.charCodeAt(stop) !== 93 && s.charCodeAt(stop) !== 124) stop++;
    }
    return stop;
  };
  const nextClose = (p) => {
    if (close < p) {
      close = p;
      while (close < n && s.charCodeAt(close) !== 93) close++;
    }
    return close;
  };
  let i = s.indexOf("[[");
  while (i !== -1) {
    const t = i + 2;
    const j = nextStop(t);
    let end = -1;
    let alias;
    if (j > t && j < n) {
      if (s.charCodeAt(j) === 93) {
        if (s.charCodeAt(j + 1) === 93) end = j + 2;
      } else {
        const k = nextClose(j + 1);
        if (k > j + 1 && k < n && s.charCodeAt(k + 1) === 93) {
          alias = s.slice(j + 1, k);
          end = k + 2;
        }
      }
    }
    if (end === -1) {
      if (j === n) break;
      i = s.indexOf("[[", i + 1);
      continue;
    }
    onLink(i, end, s.slice(t, j), alias);
    i = s.indexOf("[[", end);
  }
}

/** The raw key the app keys a link by: `target`, or `target|alias`. */
export function wikilinkKey(target, alias) {
  return alias === undefined ? target : `${target}|${alias}`;
}

// ---- what isn't prose ----------------------------------------------------------

// CommonMark's HTML block type 6 tag names.
const BLOCK_TAGS = new Set(
  (
    "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt " +
    "fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link " +
    "main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead " +
    "title tr track ul"
  ).split(" "),
);
const RAW_HTML = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;
const BLOCK_HTML = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/;
const LONE_TAG =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)/;
const BLANK = /^[ \t]*$/;
const PARAGRAPH_BREAK = /\n[ \t]*(?:\n|$)/;

/** Ranges `[start, end)` of `md` that are code, math or raw HTML blocks:
 * fenced and indented code, `$$` math blocks, `<script>`/`<style>`/`<pre>`/
 * `<textarea>`, comments and other HTML blocks (to their blank line). */
function blockMasks(md) {
  const masks = [];
  let fence = null; // { char, len }
  let math = false;
  let html = null; // "blank" | "comment" | closing tag name
  let paragraph = false;
  let list = false;
  let pos = 0;
  while (pos < md.length) {
    const nl = md.indexOf("\n", pos);
    const end = nl === -1 ? md.length : nl + 1;
    const line = md.slice(pos, nl === -1 ? md.length : nl);
    const start = pos;
    pos = end;
    const mask = () => masks.push([start, end]);

    if (fence) {
      mask();
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
      continue;
    }
    if (math) {
      mask();
      if (line.includes("$$")) math = false;
      continue;
    }
    if (html) {
      if (html === "blank") {
        if (BLANK.test(line)) html = null;
        else mask();
        continue;
      }
      mask();
      if (html === "comment" ? line.includes("-->") : line.toLowerCase().includes(`</${html}>`)) html = null;
      continue;
    }
    if (BLANK.test(line)) {
      paragraph = false;
      continue;
    }
    const indent = /^[ \t]*/.exec(line)[0].replace(/\t/g, "    ").length;
    if (indent >= 4 && !paragraph && !list) {
      mask();
      continue;
    }
    const f = FENCE.exec(line);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      mask();
      fence = { char: f[1][0], len: f[1].length };
      paragraph = false;
      continue;
    }
    const math$ = /^ {0,3}\$\$/.exec(line);
    if (math$) {
      mask();
      if (!line.slice(math$[0].length).includes("$$")) math = true;
      paragraph = false;
      continue;
    }
    const raw = RAW_HTML.exec(line);
    if (raw) {
      mask();
      if (!line.toLowerCase().includes(`</${raw[1].toLowerCase()}>`)) html = raw[1].toLowerCase();
      paragraph = false;
      continue;
    }
    if (/^ {0,3}<!--/.test(line)) {
      mask();
      if (!line.slice(line.indexOf("<!--") + 4).includes("-->")) html = "comment";
      paragraph = false;
      continue;
    }
    const tag = BLOCK_HTML.exec(line);
    if ((tag && BLOCK_TAGS.has(tag[1].toLowerCase())) || (!paragraph && LONE_TAG.test(line))) {
      mask();
      html = "blank";
      paragraph = false;
      continue;
    }
    if (LIST_ITEM.test(line)) list = true;
    else if (indent < 2) list = false;
    // A heading is a block of its own; anything else continues a paragraph.
    paragraph = !/^ {0,3}#{1,6}(?:\s|$)/.test(line);
  }
  return masks;
}

/** The index just past the run of `ch` starting at `i`. */
function runEnd(s, i, ch) {
  while (i < s.length && s[i] === ch) i++;
  return i;
}

/** Ranges of `s` (prose, between block masks) that are inline code spans
 * (any backtick count), `$…$` / `$$…$$` math, or an HTML tag itself. None
 * crosses a paragraph break. A wikilink that starts first wins, as in the
 * app's renderers, which take wikilinks out before parsing: a `<`, `$` or
 * backtick inside one opens nothing. */
function inlineMasks(s) {
  const masks = [];
  const links = new Map();
  scanWikilinks(s, (start, end) => links.set(start, end));
  let i = 0;
  const within = (from, to) => !PARAGRAPH_BREAK.test(s.slice(from, to));
  while (i < s.length) {
    if (links.has(i)) {
      i = links.get(i);
      continue;
    }
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const open = runEnd(s, i, "`");
      const len = open - i;
      let j = s.indexOf("`", open);
      let found = -1;
      while (j !== -1) {
        const e = runEnd(s, j, "`");
        if (e - j === len) {
          found = e;
          break;
        }
        j = s.indexOf("`", e);
      }
      if (found !== -1 && within(i, found)) {
        masks.push([i, found]);
        i = found;
      } else i = open;
      continue;
    }
    if (c === "$") {
      if (s[i + 1] === "$") {
        const j = s.indexOf("$$", i + 2);
        if (j !== -1 && within(i, j)) {
          masks.push([i, j + 2]);
          i = j + 2;
        } else i += 2;
        continue;
      }
      // markdown-it-katex's rule: no space after the opening `$`, none
      // before the closing one, and no digit after it.
      if (i + 1 < s.length && !/\s/.test(s[i + 1])) {
        let j = i + 1;
        let found = -1;
        while ((j = s.indexOf("$", j)) !== -1) {
          if (s[j - 1] !== "\\" && !/\s/.test(s[j - 1]) && !/[0-9]/.test(s[j + 1] ?? "")) {
            found = j;
            break;
          }
          j++;
        }
        if (found !== -1 && found > i + 1 && within(i, found)) {
          masks.push([i, found + 1]);
          i = found + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === "<" && /[A-Za-z/!?]/.test(s[i + 1] ?? "")) {
      const raw = /^<(script|style)(?=[\s>])/i.exec(s.slice(i, i + 8));
      if (raw) {
        const close = s.toLowerCase().indexOf(`</${raw[1].toLowerCase()}>`, i);
        const end = close === -1 ? s.length : close + raw[1].length + 3;
        masks.push([i, end]);
        i = end;
        continue;
      }
      const j = s.indexOf(">", i);
      if (j !== -1 && within(i, j)) {
        masks.push([i, j + 1]);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return masks;
}

/** The pieces of `md` that are prose, as `[start, end)` ranges. */
export function proseRanges(md) {
  const out = [];
  const gaps = (from, to, masks, then) => {
    let at = from;
    for (const [s, e] of masks) {
      if (s > at) then(at, s);
      at = Math.max(at, e);
    }
    if (at < to) then(at, to);
  };
  gaps(0, md.length, blockMasks(md), (from, to) => {
    const local = inlineMasks(md.slice(from, to)).map(([s, e]) => [s + from, e + from]);
    gaps(from, to, local, (a, b) => out.push([a, b]));
  });
  return out;
}

// ---- the rewrite ---------------------------------------------------------------

/** Text that Markdown, HTML and Vue all show as written: every ASCII
 * punctuation character as a numeric entity (markdown-it decodes it to text
 * and escapes what HTML needs), line breaks as spaces. */
export function literalLabel(s) {
  return s.replace(/\s*\n\s*/g, " ").replace(/[!-/:-@[-`{-~]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A links entry as the app sends it, or null for anything else. */
function entryOf(links, key) {
  if (!links || typeof links !== "object" || !Object.hasOwn(links, key)) return null;
  const v = links[key];
  if (!v || typeof v !== "object" || typeof v.path !== "string") return null;
  return { path: v.path, title: typeof v.title === "string" && v.title !== "" ? v.title : null };
}

/**
 * The edits that turn each wikilink in `md`'s prose into its label, or into
 * `<MahfouzLink :part="k">` when it names `parts[k]`: `[{ start, end, text }]`
 * in order. `deck` is `{ links, parts }` as the sidecar writes them to
 * `deck-links.json`; with none (an export), every link is its label.
 */
export function wikilinkEdits(md, deck = {}) {
  const links = deck?.links ?? {};
  const partOf = new Map();
  if (Array.isArray(deck?.parts)) {
    deck.parts.forEach((p, k) => {
      if (typeof p === "string" && !partOf.has(p)) partOf.set(p, k);
    });
  }
  const edits = [];
  for (const [from, to] of proseRanges(md)) {
    scanWikilinks(md.slice(from, to), (start, end, target, alias) => {
      const hit = entryOf(links, wikilinkKey(target, alias));
      const label = alias ?? hit?.title ?? target;
      const span = `<span v-pre>${literalLabel(label)}</span>`;
      const part = hit ? partOf.get(hit.path) : undefined;
      const text = part === undefined ? span : `<MahfouzLink :part="${part}">${span}</MahfouzLink>`;
      edits.push({ start: start + from, end: end + from, text });
    });
  }
  return edits;
}

/** `md` with wikilinkEdits applied. */
export function rewriteWikilinks(md, deck = {}) {
  let out = "";
  let at = 0;
  for (const { start, end, text } of wikilinkEdits(md, deck)) {
    out += md.slice(at, start) + text;
    at = end;
  }
  return out + md.slice(at);
}
