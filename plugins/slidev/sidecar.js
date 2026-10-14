// The Slidev plugin's sidecar: Mahfouz starts it with the user's Node and
// talks to it in newline-delimited JSON-RPC over stdin/stdout.
//
// Slidev (https://sli.dev) has no browser-only renderer: it's a Node + Vite
// dev server. So presenting a note means running @slidev/cli from this
// plugin's own node_modules (installed by the manifest's npm step) and
// showing the served deck in an iframe. One server runs while the plugin
// is on. Its entry is a stub `deck.md` whose headmatter `src:` points at the
// note to show; presenting another note rewrites the stub and Slidev picks
// it up over HMR, so switching decks never restarts the server.
//
// The server is this process's child, in the process group Mahfouz stops
// together; and when Mahfouz goes away without stopping it, stdin closes
// and this process stops the server itself before exiting.
//
// Facts this relies on (verified against slidev 52.x sources):
// - Slidev's project root is `dirname(entry)` — this plugin's directory —
//   so the `node_modules/.slidev` stubs it writes land here, never in a
//   vault.
// - `src:` imports must stay inside the project root (`allowedRoots`) and
//   the check runs on the unresolved path, so the stub reaches the vault
//   through a `vaults/<id>` symlink here. Relative image paths in the note
//   resolve through the same link; absolute `src:` paths don't work.
// - Root-absolute `/files/<name>` links aren't served from `public/` (one
//   directory every run shares) but by `setup/vite-plugins.ts`
//   (vault-files.js), from the vault the run's own entry names in its
//   headmatter. Setups get the run's options, `entry` among them; the Vue
//   compiler turns a slide's `<img src="/files/…">` into an import, which
//   that plugin resolves too.
// - Edits to the imported note and rewrites of the stub both hot-reload.
// - A theme that isn't installed makes the CLI `process.exit(1)` when
//   stdin isn't a TTY, so the default theme is installed up front.
// - Headmatter is the entry's own first frontmatter, and keys Slidev doesn't
//   know are kept in `configs` — how a slides template (`mahfouz:`) reaches
//   the layer components even though the note itself comes in by `src:`.
// - `slide-top.vue` in the project root renders inside every slide, in the
//   dev server and in `slidev export` alike; each slide's wrapper carries
//   `slidev-page-<n>`. Slide-top.vue sits directly inside that wrapper, so
//   it reaches the page with `closest('.slidev-page')` and stamps
//   `data-layout`/`data-class` there; Vue only patches the attributes it
//   binds on it (`data-slidev-no`, `class`, `style`, `lang`).
// - The server picks a slide's layout as `(frontmatter.layout ??
//   defaults.layout) || (slide 1 ? "cover" : "default")`, and `default` for
//   an unknown name; the stamp mirrors the first part (layout-stamp.js).
//   `defaults` there is `data.slides[0].frontmatter.defaults`, the note's
//   own headmatter (or the first shown slide's), not the stub's: the client
//   reads it from `$nav.slides[0].meta.slide.frontmatter`, since
//   `configs.defaults` is the stub's and always unset.
//   The client can't check a name against the layouts: `#slidev/layouts`
//   generates `import __layout_two-cols …`, a SyntaxError that stops the
//   whole deck, so no layer component may import it.
// - Changing `fonts` (one of CONFIG_RESTART_FIELDS) restarts the dev
//   server; `colorSchema` and `mahfouz:` only invalidate `/@slidev/configs`.
//   So a v2 template's fonts come from its stylesheet, never `fonts:`.
// - `slidev export` waits for each `.slidev-slide-loading` in the page to
//   detach before rendering it (global-top.vue's font and image wait).
// - A presented note's HTML and Vue run as script on the dev server's
//   origin. `setup/vite-plugins.ts` (harden.js) leaves that server only
//   able to read, and only the vaults in use stay linked under `vaults/`.
// - `slidev export` reads its entry while it runs (and watches it), so
//   each export writes an entry of its own: concurrent exports never
//   rewrite each other's.
// - `slidev export --format png --output <dir>` (no `--with-clicks`, which
//   PNG doesn't default to, and no `--per-slide`) empties `<dir>` and
//   writes one `<n>.png` per slide, `n` its unpadded number from 1; the
//   template preview reads them back by that name.
// - The dev server listens on `localhost`, which on modern Node resolves to
//   `::1` first; readiness polling goes through `localhost` too.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./header-footer.js";
import { VAULT_KEY } from "./vault-files.js";

const WORKSPACE = process.env.MAHFOUZ_PLUGIN_DIR ?? path.dirname(fileURLToPath(import.meta.url));
const START_TIMEOUT_MS = 90_000;
const EXPORT_TIMEOUT_MS = 180_000;
const OUTPUT_CAP = 64 * 1024;
const MB = 1024 * 1024;
/** The template preview's limits: the sample deck the app sends, a
 * template's stylesheet, and the PNGs it returns. The app takes a slide's
 * data URL of at most 4 MiB characters, `data:image/png;base64,` included
 * (SLIDES_PREVIEW_MAX_PNG_BYTES); PREVIEW_PNG_CAP is the largest PNG whose
 * base64 fits in the rest. */
export const PREVIEW_MARKDOWN_CAP = 64 * 1024;
export const PREVIEW_STYLESHEET_CAP = 256 * 1024;
const APP_DATA_URL_MAX = 4 * MB;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
export const PREVIEW_PNG_CAP = Math.floor((APP_DATA_URL_MAX - PNG_DATA_URL_PREFIX.length) / 4) * 3;
export const PREVIEW_TOTAL_CAP = 30 * MB;
/** Vite (^20.19 || >=22.12) and some of its plugins (^22) set the floor. */
export const MIN_NODE = [22, 12];

// ---- pure helpers (exported for tests) ---------------------------------------

export function nodeVersionOk(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

export function deckUrl(port) {
  return `http://localhost:${port}/`;
}

export function cliEntry(workspace) {
  return path.join(workspace, "node_modules", "@slidev", "cli", "bin", "slidev.mjs");
}

function quote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---- slides templates ----------------------------------------------------------
//
// A template (the app's `host.slides.resolveTemplate`, from the vault's
// `.config/slides.md`) reaches the deck as a `mahfouz:` key in the entry's
// headmatter, which Slidev spreads into `configs`. The static layer
// components shipped here read it: `global-top.vue` injects the CSS and
// `slide-top.vue` draws the logo and footer on every slide. Being part of
// each entry (not a shared project file), a template can't leak between a
// Present and a concurrent export.

function declarations(parts) {
  return parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v};`).join(" ");
}

const url = (p) => (p ? `url(${JSON.stringify(p)})` : "");

function slideRule(selector, { background, backgroundImage, textColor }) {
  const body = declarations([
    ["background-color", background],
    ["background-image", url(backgroundImage)],
    ["background-size", backgroundImage && "cover"],
    ["background-position", backgroundImage && "center"],
    ["color", textColor],
  ]);
  return body ? `${selector} { ${body} }` : "";
}

/** The CSS a template stands for: every slide, then the cover (slide 1),
 * then the template's own CSS. It styles each slide's wrapper, which covers
 * the whole slide (the layout inside is padded) and is what the footer
 * inherits its color from; the default theme sets neither there. */
export function templateCss(t) {
  if (!t) return "";
  const rules = [slideRule(".slidev-page", t)];
  if (t.accentColor) {
    rules.push(
      `.slidev-page { ${declarations([
        ["--mahfouz-accent", t.accentColor],
        ["--slidev-theme-primary", t.accentColor],
      ])} }`,
      `.slidev-page a { color: ${t.accentColor}; }`
    );
  }
  rules.push(slideRule(".slidev-page.slidev-page-1", t.cover ?? {}));
  if (t.css?.trim()) rules.push(t.css.trim());
  return rules.filter(Boolean).join("\n");
}

/** JSON for one headmatter line. JSON is valid YAML, but JSON.stringify
 * leaves U+0085, U+2028 and U+2029 raw, which a YAML 1.1 parser reads as
 * line breaks; they're escaped (a template's raw css can hold anything,
 * `</style>` and `\n---\n` included, which JSON already keeps on one line). */
export function yamlJson(value) {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const COLOR_SCHEMAS = ["light", "dark"];

/** Headmatter lines for a template, or "" for none. `header`/`footer` are
 * inline Markdown rendered with `renderInline` (markdown-it in the sidecar;
 * plain escaping by default).
 *
 * An app with v2 templates sends `stylesheet`, the whole look as CSS, fonts
 * included (`@import`/`@font-face`), so it's used byte for byte and Slidev's
 * `fonts:` isn't set. An older app doesn't, and the plugin builds its own
 * CSS (templateCss) and `fonts:` as before. `colorSchema` is a headmatter
 * key of its own: Slidev follows it for `html.dark` (Shiki, the default
 * theme) and the export emulates it. Why fonts never go in `fonts:` for v2:
 * the header's "Facts this relies on". */
export function templateHeadmatter(t, renderInline = escapeHtml) {
  if (!t) return "";
  const v2 = typeof t.stylesheet === "string";
  const fontFamilies = Array.isArray(t.fontFamilies) ? t.fontFamilies.filter((f) => typeof f === "string") : [];
  const data = Object.fromEntries(
    Object.entries({
      css: v2 ? t.stylesheet : templateCss(t),
      fontFamilies: fontFamilies.length ? fontFamilies : undefined,
      logo: t.logo,
      coverLogo: t.cover?.logo,
      logoPosition: t.logoPosition,
      header: t.header && renderInline(t.header),
      footer: t.footer && renderInline(t.footer),
      titleSlide: t.titleSlide,
    }).filter(([, v]) => v)
  );
  let out = `mahfouz: ${yamlJson(data)}\n`;
  if (!v2 && t.font) out += `fonts: ${JSON.stringify({ sans: t.font })}\n`;
  if (COLOR_SCHEMAS.includes(t.colorSchema)) out += `colorSchema: ${JSON.stringify(t.colorSchema)}\n`;
  return out;
}

/** The tags and attributes markdown-it's inline renderer emits with raw
 * HTML off (and linkify, typographer, breaks off, its defaults). */
const INLINE_TAGS = {
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  strong: [],
  em: [],
  s: [],
  code: [],
  br: [],
};
const ENTITY = /&(?!(?:amp|lt|gt|quot);)/;
const SAFE_URL = /^(?![a-z][a-z0-9+.-]*:)|^(?:https?|mailto):|^data:image\/(?:gif|png|jpeg|webp);/i;

/** `html` when it holds only the markup markdown-it's inline renderer makes
 * from Markdown (no raw HTML, no event handlers, no script URLs), else
 * `source` escaped as plain text. A check, not a rewrite: anything
 * unexpected means the renderer isn't configured the way this relies on. */
export function safeInlineHtml(html, source) {
  const plain = escapeHtml(source);
  if (html.includes("<!--")) return plain;
  for (const [, close, name, attrs] of html.matchAll(/<(\/?)([^\s>\/]*)([^>]*)>/g)) {
    const allowed = INLINE_TAGS[name.toLowerCase()];
    if (!allowed || name !== name.toLowerCase()) return plain;
    if (close) {
      if (attrs !== "") return plain;
      continue;
    }
    const rest = attrs.replace(/ ([a-z]+)="([^"<>]*)"/g, (_, key, value) => {
      if (!allowed.includes(key) || ENTITY.test(value)) return "\0";
      if ((key === "href" || key === "src") && !SAFE_URL.test(value.replace(/&amp;/g, "&").trim())) return "\0";
      return "";
    });
    if (rest !== "") return plain;
  }
  // A stray `<` or `>` outside a tag would be a tag the regex above didn't see.
  if (/[<>]/.test(html.replace(/<\/?[a-z]+(?: [a-z]+="[^"<>]*")*>/g, ""))) return plain;
  return html;
}

/** Inline Markdown → HTML for a template's header and footer, given
 * markdown-it's constructor. The header and footer come from the vault's
 * `.config/slides.md` and a note's attributes, which a collaborator's commit
 * can change, and slide-top.vue injects the result with `v-html` on every
 * slide: so raw HTML is off (it's shown as text) and the output is checked
 * against what Markdown alone produces. Bold, italics, code, links and
 * images still render. */
export function inlineRenderer(MarkdownIt) {
  const md = new MarkdownIt({ html: false });
  return (s) => safeInlineHtml(md.renderInline(s), s);
}

/** The header/footer renderer, loaded lazily: the sidecar also runs before
 * the npm install that provides markdown-it. If markdown-it can't be loaded
 * (e.g. the install hasn't completed yet), falls back to escaped plain text
 * so Present/export still work, just without Markdown formatting in the
 * header/footer. */
let markdown = null;
let markdownUnavailable = false;
async function markdownInline() {
  if (markdownUnavailable) return escapeHtml;
  if (!markdown) {
    try {
      const { default: MarkdownIt } = await import("markdown-it");
      markdown = inlineRenderer(MarkdownIt);
    } catch (err) {
      markdownUnavailable = true;
      console.error("markdown-it unavailable; header/footer text will be escaped, not rendered as Markdown:", err);
      return escapeHtml;
    }
  }
  return markdown;
}

/** The headmatter line naming the vault whose `files/` the run serves at
 * `/files/` (vault-files.js), or "" for none. */
function vaultLine(vaultId) {
  return vaultId ? `${VAULT_KEY}: ${quote(vaultId)}\n` : "";
}

/** The stub entry deck: imports `src` (relative to the workspace, through
 * the vault symlink), or without one, the placeholder an idle server shows.
 * `vaultId` is the vault's link id, for its `/files/`. */
export function stubContent(src, template = null, renderInline = escapeHtml, vaultId = null) {
  return src
    ? `---\nsrc: ${quote(src)}\n${vaultLine(vaultId)}${templateHeadmatter(template, renderInline)}---\n`
    : "---\ntitle: Mahfouz\n---\n\n# Mahfouz\n\nOpen a note and choose Present.\n";
}

/** Headmatter for the one-shot export entry. The deck's `aspectRatio`
 * (default 16/9) sets the PDF's page shape, and `slidev export` has no
 * orientation flag of its own, so portrait means a taller ratio. */
export function exportEntryContent(src, portrait, template = null, renderInline = escapeHtml, vaultId = null) {
  return `---\nsrc: ${quote(src)}\n${vaultLine(vaultId)}${portrait ? 'aspectRatio: "3/4"\n' : ""}${templateHeadmatter(template, renderInline)}---\n`;
}

/** The template preview's entry: the sample deck (`preview-src.md`, the
 * Markdown the app sends) with the template's headmatter, written the way
 * an export's is. */
export function previewEntryContent(template = null, renderInline = escapeHtml, vaultId = null) {
  return exportEntryContent("./preview-src.md", false, template, renderInline, vaultId);
}

/** The slides `slidev export --format png` wrote to `dir`, as base64 in
 * slide order. Refuses a PNG not named `<n>.png` (the naming fact in the
 * header), one over PREVIEW_PNG_CAP, and more than PREVIEW_TOTAL_CAP in all. */
export function pngSlides(dir) {
  const slides = [];
  const seen = new Set();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".png")) continue;
    const stem = name.slice(0, -".png".length);
    if (!/^[0-9]+$/.test(stem)) throw new Error(`slidev export wrote ${name}, which isn't named by slide number`);
    const n = parseInt(stem, 10);
    if (seen.has(n)) throw new Error(`slidev export wrote slide ${n} twice`);
    seen.add(n);
    slides.push({ n, file: path.join(dir, name) });
  }
  if (slides.length === 0) throw new Error("slidev export produced no slides");
  slides.sort((a, b) => a.n - b.n);
  let total = 0;
  for (const slide of slides) {
    const size = fs.statSync(slide.file).size;
    if (size > PREVIEW_PNG_CAP) throw new Error(`slide ${slide.n} is too large: over ${APP_DATA_URL_MAX / MB} MB as a data URL`);
    total += size;
    if (total > PREVIEW_TOTAL_CAP) throw new Error(`the slides are over ${PREVIEW_TOTAL_CAP / MB} MB of PNGs in all`);
  }
  return slides.map(({ file }) => fs.readFileSync(file).toString("base64"));
}

/** The preview's `vaultPath`: absolute, an existing directory, never the
 * file system's root (which would link every file into the workspace).
 * Returned resolved, so its link id is the same however it was spelled. */
function previewVault(vaultPath) {
  if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath)) throw new Error("vaultPath must be an absolute path");
  const vault = path.resolve(vaultPath);
  if (vault === path.parse(vault).root) throw new Error("vaultPath can't be the file system's root");
  if (!fs.statSync(vault, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`vault not found: ${vault}`);
  return vault;
}

/** The preview's `template`: null, or an object whose text fields the
 * entry uses are strings (or absent), the stylesheet within its cap. */
function checkPreviewTemplate(template) {
  if (template === null || template === undefined) return;
  if (typeof template !== "object" || Array.isArray(template)) throw new Error("template must be an object or null");
  for (const key of ["stylesheet", "header", "footer"]) {
    const value = template[key];
    if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`template.${key} must be a string`);
  }
  if (typeof template.stylesheet === "string" && Buffer.byteLength(template.stylesheet) > PREVIEW_STYLESHEET_CAP) {
    throw new Error(`template.stylesheet is over ${PREVIEW_STYLESHEET_CAP / 1024} KB`);
  }
}

/** The Export dialog's formats → `slidev export --format` values (and the
 * output's extension, which is the key). PowerPoint uses the editable export:
 * text stays text, and a slide it can't convert goes in as a picture. Google
 * Slides imports the same file. */
const EXPORT_FORMATS = { pdf: "pdf", pptx: "pptx-editable" };

export function slidevExportFormat(format = "pdf") {
  if (!Object.hasOwn(EXPORT_FORMATS, format)) throw new Error(`unsupported export format "${format}"`);
  return EXPORT_FORMATS[format];
}

/** Stable, filename-safe name for a vault's symlink. */
export function vaultLinkId(vaultPath) {
  return createHash("sha256").update(vaultPath).digest("hex").slice(0, 16);
}

/** The `<script type="module" src="…">` Slidev's index.html boots from. */
export function entryModuleSrc(html) {
  const m = /type="module"[^>]*\bsrc="([^"]+)"/.exec(html) ?? /\bsrc="([^"]+)"[^>]*type="module"/.exec(html);
  return m ? m[1] : null;
}

/** `vault/relPath`, refusing anything that climbs out of the vault. */
export function safeJoin(vaultPath, relPath) {
  if (path.isAbsolute(relPath)) throw new Error("the note path must be relative to the vault");
  const root = path.resolve(vaultPath);
  const full = path.resolve(root, relPath);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("the note path leaves the vault");
  return full;
}

/** Points `link` at `target` (a directory symlink), repointing a stale one. */
export function ensureLink(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let current = null;
  try {
    current = fs.readlinkSync(link);
  } catch {
    if (fs.existsSync(link)) throw new Error(`${link} exists and is not a symlink`);
  }
  if (current === target) return;
  if (current !== null) fs.unlinkSync(link);
  // A junction on Windows: directory symlinks there need admin rights or
  // Developer Mode, junctions don't (the target is always absolute here).
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** `vaults/<id>` → the vault, for `src:` and, through vault-files.js, the
 * deck's `/files/<name>` links. Each vault has a link of its own, so runs
 * for different vaults never repoint each other's. A `public/files` link an
 * older version kept (one for all runs, repointed by each) is removed:
 * Vite would serve it to every run. */
export function linkVault(workspace, vaultPath) {
  const id = vaultLinkId(vaultPath);
  ensureLink(path.join(workspace, "vaults", id), vaultPath);
  const legacy = path.join(workspace, "public", "files");
  if (fs.lstatSync(legacy, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(legacy);
  return id;
}

/** Removes the `vaults/<id>` links not in `keep`. Script in a presented
 * note runs on the dev server's origin and can read what the server can
 * reach, so only the vaults a Present or an export is using stay linked:
 * a note never reaches a vault other than its own (and, while an export
 * of another vault runs, that one). Only symlinks are removed. */
export function pruneVaultLinks(workspace, keep) {
  const dir = path.join(workspace, "vaults");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const link = path.join(dir, name);
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  }
}

/** The vault the Present server shows, and the exports running per vault. */
const linked = { present: null, exports: new Map() };

function linkedIds() {
  const ids = new Set(linked.exports.keys());
  if (linked.present) ids.add(linked.present);
  return ids;
}

function checkNote(vaultPath, relPath, verb) {
  const full = safeJoin(vaultPath, relPath);
  if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) throw new Error(`note file not found: ${full}`);
  // Slidev splits `src` on '#' for slide ranges; such paths can't be imported.
  if (relPath.includes("#")) throw new Error(`notes whose path contains '#' can't be ${verb}`);
}

// ---- the server --------------------------------------------------------------

function tail() {
  let text = "";
  return {
    add(chunk) {
      if (text.length < OUTPUT_CAP) text += chunk;
    },
    get text() {
      return text;
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function get(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** State of the one server this sidecar runs. */
const server = {
  child: null,
  port: 0,
  starting: null,
  /** True until the first Present after a spawn: a page rendered against a
   * cold server comes up with its UI chrome unstyled and never recovers,
   * so the frontend reloads it once. */
  cold: false,
  output: tail(),
};

function assertInstalled() {
  if (!fs.existsSync(cliEntry(WORKSPACE))) throw new Error("Slidev isn't installed (its npm install step didn't finish)");
}

async function spawnServer() {
  assertInstalled();
  const stub = path.join(WORKSPACE, "deck.md");
  if (!fs.existsSync(stub)) fs.writeFileSync(stub, stubContent(null));
  const port = await freePort();
  const output = tail();
  const child = spawn(process.execPath, [cliEntry(WORKSPACE), stub, "--port", String(port), "--log", "warn"], {
    cwd: WORKSPACE,
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8").on("data", (d) => output.add(d));
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = signal ?? code;
    if (server.child === child) server.child = null;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (exited !== null) throw new Error(`slidev exited (${exited}):\n${output.text}`);
    try {
      const html = await get(deckUrl(port), 5000);
      // Vite serves index.html before dependency optimisation is done, so
      // wait for the entry module too: "ready" then means the optimiser is
      // finished, not just that the port is open. Best effort.
      const src = entryModuleSrc(html);
      if (src) await get(`${deckUrl(port).replace(/\/$/, "")}${src}`, 60_000).catch(() => {});
      break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`slidev did not become ready within ${START_TIMEOUT_MS / 1000}s:\n${output.text}`);
    }
    await sleep(250);
  }
  Object.assign(server, { child, port, cold: true, output });
  return port;
}

/** The running server's port, spawning it first if needed. Concurrent
 * callers share one start. */
function ensureServer() {
  if (server.child) return Promise.resolve(server.port);
  if (!server.starting) {
    server.starting = spawnServer().finally(() => {
      server.starting = null;
    });
  }
  return server.starting;
}

function stopServer() {
  const child = server.child;
  server.child = null;
  if (child) child.kill();
}

// ---- methods -----------------------------------------------------------------

export const methods = {
  /** Checks the Node.js version this plugin runs with. */
  ready() {
    if (!nodeVersionOk(process.version)) {
      throw new Error(
        `Slidev needs Node.js ${MIN_NODE.join(".")} or newer (this is ${process.version}). Install it (nodejs.org, Homebrew, mise, nvm, or volta) and try again.`
      );
    }
    assertInstalled();
    return { node: process.version };
  },

  /** Starts the server in the background; returns its URL. */
  async warm() {
    return deckUrl(await ensureServer());
  },

  /** Points the server at a note; returns where to load it. */
  async start({ vaultPath, relPath, template }) {
    checkNote(vaultPath, relPath, "presented");
    const id = linkVault(WORKSPACE, vaultPath);
    linked.present = id;
    pruneVaultLinks(WORKSPACE, linkedIds());
    fs.writeFileSync(
      path.join(WORKSPACE, "deck.md"),
      stubContent(`./vaults/${id}/${relPath}`, template ?? null, template ? await markdownInline() : undefined, id)
    );
    const port = await ensureServer();
    const fresh = server.cold;
    server.cold = false;
    return { url: deckUrl(port), fresh };
  },

  /**
   * Renders a note to a PDF or, with `format: "pptx"`, a PowerPoint file in
   * the OS temp dir with `slidev export`, and returns the file's path. Independent of the Present server: its own
   * entry (`export-<uuid>.md`, so neither a concurrent Present rewriting
   * `deck.md` nor another export can race it), run to completion as a
   * one-shot process. `content`, when
   * given, is rendered instead of the note file (the Export dialog's
   * children/attachment options). `template` is the note's slides
   * template, or null.
   */
  async export({ vaultPath, relPath, orientation, content, template, format = "pdf" }) {
    const slidevFormat = slidevExportFormat(format);
    assertInstalled();
    checkNote(vaultPath, relPath, "exported");
    return withLinkedVault(vaultPath, (id) => runExport(id, relPath, orientation, content, template, format, slidevFormat));
  },

  /**
   * Renders the app's sample deck (`markdown`) with a slides template to
   * PNGs (Settings → Slides' "Render with Slidev") and returns them as
   * base64, in slide order: `{ slides: [{ png }] }`. A one-shot `slidev
   * export --format png` like `export`'s, from its own entry
   * (`preview.md`, importing `preview-src.md`), into a fresh temp dir; the
   * vault is linked for the template's `/files/` images. One at a time: a
   * preview asked for while one runs is refused as busy, so a request the
   * app has given up on can't queue behind it. The temp dir and both entry
   * files are removed afterwards, whatever happened.
   */
  async preview({ vaultPath, markdown, template = null } = {}) {
    if (typeof markdown !== "string") throw new Error("markdown must be a string");
    if (Buffer.byteLength(markdown) > PREVIEW_MARKDOWN_CAP) throw new Error(`markdown is over ${PREVIEW_MARKDOWN_CAP / 1024} KB`);
    const vault = previewVault(vaultPath);
    checkPreviewTemplate(template);
    if (previewing) throw new Error("busy: a preview is already rendering");
    previewing = true;
    try {
      assertInstalled();
      return await runPreview(vault, markdown, template ?? null);
    } finally {
      previewing = false;
    }
  },

  stop() {
    stopServer();
    linked.present = null;
    return null;
  },

  /** Recent output of the server, for error reports. */
  log() {
    return server.output.text;
  },
};

/** Whether a preview is rendering (they run one at a time). */
let previewing = false;

/**
 * Runs `fn(id)` with `vaultPath` linked as `vaults/<id>` and counted in
 * use, so a concurrent Present or export doesn't prune it; afterwards the
 * count drops and the links no longer in use are pruned. Cleanup failures
 * are logged, never put in place of `fn`'s result or error.
 */
async function withLinkedVault(vaultPath, fn) {
  const id = linkVault(WORKSPACE, vaultPath);
  linked.exports.set(id, (linked.exports.get(id) ?? 0) + 1);
  try {
    pruneVaultLinks(WORKSPACE, linkedIds());
    return await fn(id);
  } finally {
    const n = linked.exports.get(id) - 1;
    if (n > 0) linked.exports.set(id, n);
    else linked.exports.delete(id);
    try {
      pruneVaultLinks(WORKSPACE, linkedIds());
    } catch (err) {
      console.error("pruning the vault links failed", err);
    }
  }
}

/** `preview`'s work, once its params are checked. */
function runPreview(vault, markdown, template) {
  return withLinkedVault(vault, async (id) => {
    const src = path.join(WORKSPACE, "preview-src.md");
    const entry = path.join(WORKSPACE, "preview.md");
    let output = null;
    try {
      output = fs.mkdtempSync(path.join(os.tmpdir(), "mahfouz-preview-"));
      fs.writeFileSync(src, markdown);
      fs.writeFileSync(entry, previewEntryContent(template, template ? await markdownInline() : undefined, id));
      await runSlidevExport(entry, ["--output", output, "--format", "png"], tail());
      return { slides: pngSlides(output).map((png) => ({ png })) };
    } finally {
      for (const file of [output, src, entry]) {
        if (file === null) continue;
        try {
          fs.rmSync(file, { recursive: true, force: true });
        } catch (err) {
          console.error(`removing ${file} failed`, err);
        }
      }
    }
  });
}

const CAUSE_MAX = 200;

/** One line naming why a run failed, for the first line of its error (the
 * app shows only that): the last line of `text` that isn't blank or a
 * stack frame, trimmed to CAUSE_MAX characters. "" when there's none. */
export function logCause(text) {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l))
    .pop();
  if (!line) return "";
  return line.length > CAUSE_MAX ? `${line.slice(0, CAUSE_MAX - 1)}…` : line;
}

/** Runs `slidev export <entry> <args>` to completion in the workspace,
 * collecting its output in `log`; throws on a failure or after
 * EXPORT_TIMEOUT_MS. Export and the preview both go through it, so they
 * run Slidev the same way (cwd, project root, env). */
export async function runSlidevExport(entry, args, log) {
  const child = spawn(process.execPath, [cliEntry(WORKSPACE), "export", entry, ...args], {
    cwd: WORKSPACE,
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (d) => log.add(d));
  child.stderr.setEncoding("utf8").on("data", (d) => log.add(d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, EXPORT_TIMEOUT_MS);
    child.on("exit", (c, signal) => {
      clearTimeout(timer);
      resolve(signal ?? c);
    });
  });
  if (code === "timeout") throw new Error(`slidev export did not finish within ${EXPORT_TIMEOUT_MS / 1000}s:\n${log.text}`);
  if (code !== 0) {
    const cause = logCause(log.text);
    throw new Error(`slidev export failed (${code})${cause ? `: ${cause}` : ""}\n${log.text}`);
  }
}

/** `export`'s work, once its vault is linked and marked in use. */
async function runExport(id, relPath, orientation, content, template, format, slidevFormat) {
  const run = randomUUID();
  const entry = path.join(WORKSPACE, `export-${run}.md`);
  const contentSrc = path.join(WORKSPACE, `export-src-${run}.md`);
  try {
    let src = `./vaults/${id}/${relPath}`;
    if (typeof content === "string") {
      fs.writeFileSync(contentSrc, content);
      src = `./${path.basename(contentSrc)}`;
    }
    fs.writeFileSync(
      entry,
      exportEntryContent(src, orientation === "portrait", template ?? null, template ? await markdownInline() : undefined, id)
    );
    const output = path.join(os.tmpdir(), `mahfouz-export-${run}.${format}`);
    await runSlidevExport(entry, ["--output", output, "--format", slidevFormat], tail());
    if (!fs.existsSync(output)) throw new Error("slidev export exited successfully but produced no file");
    return output;
  } finally {
    for (const file of [entry, contentSrc]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (err) {
        console.error(`removing ${file} failed`, err);
      }
    }
  }
}

// ---- JSON-RPC over stdio -----------------------------------------------------

function main() {
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const method = methods[msg.method];
    if (!method) {
      send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
      return;
    }
    try {
      send({ id: msg.id, result: (await method(msg.params ?? {})) ?? null });
    } catch (err) {
      send({ id: msg.id, error: { code: 1, message: err instanceof Error ? err.message : String(err) } });
    }
  });
  // Mahfouz went away (or stopped us): don't leave the server behind.
  rl.on("close", () => {
    stopServer();
    process.exit(0);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      stopServer();
      process.exit(0);
    });
  }
}

/** Whether this file is the script node was started with (not imported by a
 * test). Real paths, since either side may go through a symlink (e.g.
 * macOS's /var → /private/var). */
function isEntryScript() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryScript()) main();
