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
// - Edits to the imported note and rewrites of the stub both hot-reload.
// - A theme that isn't installed makes the CLI `process.exit(1)` when
//   stdin isn't a TTY, so the default theme is installed up front.
// - Headmatter is the entry's own first frontmatter, and keys Slidev doesn't
//   know are kept in `configs` — how a slides template (`mahfouz:`) reaches
//   the layer components even though the note itself comes in by `src:`.
// - `slide-top.vue` in the project root renders inside every slide, in the
//   dev server and in `slidev export` alike; each slide's wrapper carries
//   `slidev-page-<n>`.
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

const WORKSPACE = process.env.MAHFOUZ_PLUGIN_DIR ?? path.dirname(fileURLToPath(import.meta.url));
const START_TIMEOUT_MS = 90_000;
const EXPORT_TIMEOUT_MS = 180_000;
const OUTPUT_CAP = 64 * 1024;
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
 * then the template's own CSS. Selectors are specific enough to win over
 * the default theme without `!important`. */
export function templateCss(t) {
  if (!t) return "";
  const rules = [slideRule(".slidev-page .slidev-layout", t)];
  if (t.accentColor) {
    rules.push(
      `.slidev-page .slidev-layout { ${declarations([
        ["--mahfouz-accent", t.accentColor],
        ["--slidev-theme-primary", t.accentColor],
      ])} }`,
      `.slidev-page .slidev-layout a { color: ${t.accentColor}; }`
    );
  }
  rules.push(slideRule(".slidev-page.slidev-page-1 .slidev-layout", t.cover ?? {}));
  if (t.css?.trim()) rules.push(t.css.trim());
  return rules.filter(Boolean).join("\n");
}

/** Headmatter lines for a template (JSON is valid YAML), or "" for none. */
export function templateHeadmatter(t) {
  if (!t) return "";
  const data = Object.fromEntries(
    Object.entries({
      css: templateCss(t),
      logo: t.logo,
      coverLogo: t.cover?.logo,
      logoPosition: t.logoPosition,
      footer: t.footer,
    }).filter(([, v]) => v)
  );
  let out = `mahfouz: ${JSON.stringify(data)}\n`;
  if (t.font) out += `fonts: ${JSON.stringify({ sans: t.font })}\n`;
  return out;
}

/** The stub entry deck: imports `src` (relative to the workspace, through
 * the vault symlink), or without one, the placeholder an idle server shows. */
export function stubContent(src, template = null) {
  return src
    ? `---\nsrc: ${quote(src)}\n${templateHeadmatter(template)}---\n`
    : "---\ntitle: Mahfouz\n---\n\n# Mahfouz\n\nOpen a note and choose Present.\n";
}

/** Headmatter for the one-shot export entry. The deck's `aspectRatio`
 * (default 16/9) sets the PDF's page shape, and `slidev export` has no
 * orientation flag of its own, so portrait means a taller ratio. */
export function exportEntryContent(src, portrait, template = null) {
  return `---\nsrc: ${quote(src)}\n${portrait ? 'aspectRatio: "3/4"\n' : ""}${templateHeadmatter(template)}---\n`;
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
  fs.symlinkSync(target, link, "dir");
}

/** `vaults/<id>` → the vault (for `src:`), and `public/files` → its `files/`
 * directory: Slidev serves `public/` at the site root, so a note's
 * root-absolute attachment links (`/files/<name>`) resolve in the deck as
 * they do in the editor. One vault at a time, like the single server. */
export function linkVault(workspace, vaultPath) {
  const id = vaultLinkId(vaultPath);
  ensureLink(path.join(workspace, "vaults", id), vaultPath);
  ensureLink(path.join(workspace, "public", "files"), path.join(vaultPath, "files"));
  return id;
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
    fs.writeFileSync(path.join(WORKSPACE, "deck.md"), stubContent(`./vaults/${id}/${relPath}`, template ?? null));
    const port = await ensureServer();
    const fresh = server.cold;
    server.cold = false;
    return { url: deckUrl(port), fresh };
  },

  /**
   * Renders a note to a PDF in the OS temp dir with `slidev export`, and
   * returns the file's path. Independent of the Present server: its own
   * entry (`export.md`, so a concurrent Present rewriting `deck.md` can't
   * race it), run to completion as a one-shot process. `content`, when
   * given, is rendered instead of the note file (the Export dialog's
   * children/attachment options). `template` is the note's slides
   * template, or null.
   */
  async export({ vaultPath, relPath, orientation, content, template }) {
    assertInstalled();
    checkNote(vaultPath, relPath, "exported");
    const id = linkVault(WORKSPACE, vaultPath);
    let src = `./vaults/${id}/${relPath}`;
    if (typeof content === "string") {
      fs.writeFileSync(path.join(WORKSPACE, "export-src.md"), content);
      src = "./export-src.md";
    }
    const entry = path.join(WORKSPACE, "export.md");
    fs.writeFileSync(entry, exportEntryContent(src, orientation === "portrait", template ?? null));
    const output = path.join(os.tmpdir(), `mahfouz-export-${randomUUID()}.pdf`);
    const log = tail();
    const child = spawn(
      process.execPath,
      [cliEntry(WORKSPACE), "export", entry, "--output", output, "--format", "pdf"],
      { cwd: WORKSPACE, env: { ...process.env, NO_COLOR: "1", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] }
    );
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
    if (code !== 0) throw new Error(`slidev export failed (${code}):\n${log.text}`);
    if (!fs.existsSync(output)) throw new Error("slidev export exited successfully but produced no file");
    return output;
  },

  stop() {
    stopServer();
    return null;
  },

  /** Recent output of the server, for error reports. */
  log() {
    return server.output.text;
  },
};

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
