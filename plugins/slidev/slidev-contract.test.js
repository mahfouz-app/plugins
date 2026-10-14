// Run with `npm test` (node --test) from the repo root. The facts about
// Slidev that the layer components and the sidecar rely on (sidecar.js,
// "Facts this relies on"), checked against the installed @slidev/client
// and @slidev/cli, so a Slidev upgrade that breaks one fails here instead of
// in a user's export. The CLI's dist files are hashed (`serve-<hash>.mjs`),
// so they're found by prefix. Skipped without the plugin's npm install;
// CI has it, and fails instead.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import zlib from "node:zlib";
import { cliEntry, slidevExportFormat } from "./sidecar.js";

const require = createRequire(import.meta.url);
let client = null;
let cli = null;
try {
  client = path.dirname(require.resolve("@slidev/client/package.json"));
  cli = path.dirname(require.resolve("@slidev/cli/package.json"));
} catch (err) {
  if (process.env.CI) throw err;
}
const withSlidev = { skip: client && cli ? false : "@slidev/client or @slidev/cli isn't installed (npm ci in plugins/slidev)" };

/** The CLI's dist chunk named `<prefix>-<hash>.mjs`. */
function dist(prefix) {
  const dir = path.join(cli, "dist");
  const names = fs.readdirSync(dir).filter((f) => new RegExp(`^${prefix}-[\\w-]+\\.mjs$`).test(f));
  assert.equal(names.length, 1, `one ${prefix}-*.mjs in @slidev/cli/dist, found ${names.join(", ") || "none"}`);
  return fs.readFileSync(path.join(dir, names[0]), "utf8");
}
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

test("SlideTop renders inside the element carrying getSlideClass, whose first class is slidev-page", withSlidev, () => {
  const wrapper = read(client, "internals", "SlideWrapper.vue");
  const template = /<template>([\s\S]*)<\/template>/.exec(wrapper)[1];
  const open = /<div\b([^>]*)>/.exec(template);
  assert.ok(open, "the wrapper's root is a div");
  assert.match(open[1], /:class="getSlideClass\(/);
  const body = template.slice(open.index + open[0].length, template.lastIndexOf("</div>"));
  assert.match(body, /<SlideTop\s*\/>/, "SlideTop is a direct child of the page element");
  assert.doesNotMatch(body, /<div\b/, "no element between the page and SlideTop");
  assert.match(read(client, "utils.ts"), /function getSlideClass\([^)]*\)\s*\{\s*const classes = \['slidev-page'/);
});

// The layer components can't learn the layout names from `#slidev/layouts`:
// its generated module names each import `__layout_<name>`, which isn't an
// identifier for `two-cols` (a layout every deck has), so importing it fails
// the whole deck with a SyntaxError. If this starts failing, Slidev changed
// the generator; the unknown-layout mapping (layout-stamp.js) could then
// use it again.
test("#slidev/layouts can't be imported: its identifiers break on hyphenated layout names", withSlidev, () => {
  const serve = dist("serve");
  assert.match(serve, /id: "\/@slidev\/layouts"/);
  assert.match(serve, /imports\.push\(`import __layout_\$\{k\} from "\$\{toAtFS\(v\)\}"`\)/);
  assert.ok(fs.existsSync(path.join(client, "layouts", "two-cols.vue")));
});

test("no layer component imports #slidev/layouts", () => {
  for (const f of ["slide-top.vue", "global-top.vue"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), "utf8"), /#slidev\/layouts/, f);
  }
});

test("the server's layout rule: own layout, then defaults, then cover for slide 1; unknown is default", withSlidev, () => {
  const serve = dist("serve");
  assert.match(
    serve,
    /let layoutName = \(data\.slides\[index\]\?\.frontmatter\?\.layout \?\? data\.slides\[0\]\?\.frontmatter\?\.defaults\?\.layout\) \|\| \(index === 0 \? "cover" : "default"\);/
  );
  assert.match(serve, /if \(!layouts\[layoutName\]\) \{[\s\S]{0,400}?layoutName = "default";/);
});

test("the client reaches slide 1's own frontmatter defaults through $nav.slides", withSlidev, () => {
  const serve = dist("serve");
  // Each slide's frontmatter is the stub's headmatter defaults under its own.
  assert.match(serve, /function getFrontmatter\(pageNo\) \{\s*return \{\s*\.\.\.data\.headmatter\?\.defaults \|\| \{\},\s*\.\.\.data\.slides\[pageNo\]\?\.frontmatter \|\| \{\}/);
  // The slide list is data.slides, in order, each with meta.slide.frontmatter.
  assert.match(serve, /const slides = data\.slides\.map\(\(_, idx\) => \{/);
  assert.match(serve, /"  slide: \{",\s*`    \.\.\.\(\$\{JSON\.stringify\(slideBase\)\}\),`,\s*`    frontmatter,`/);
  // The context is reactive, so $nav.value.slides is the unwrapped list, in Present and print.
  assert.match(read(client, "setup", "root.ts"), /const context = reactive\(\{\s*nav: useNav\(\),/);
  assert.match(read(client, "internals", "PrintSlideClick.vue"), /provideLocal\(injectionSlidevContext, reactive\(\{\s*nav,/);
  assert.match(read(client, "composables", "useNav.ts"), /\n    slides,\n/);
});

test("changing fonts restarts the dev server; colorSchema doesn't", withSlidev, () => {
  const fields = /const CONFIG_RESTART_FIELDS = \[([^\]]*)\]/.exec(read(cli, "dist", "cli.mjs"));
  assert.ok(fields, "CONFIG_RESTART_FIELDS");
  const names = [...fields[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.includes("fonts"), names.join(", "));
  assert.ok(!names.includes("colorSchema"), names.join(", "));
});

test("export waits for every .slidev-slide-loading to detach, and PDF and PowerPoint both go through print", withSlidev, () => {
  const exp = dist("export");
  assert.match(exp, /const slide = no === "print" \? page\.locator\("body"\)/);
  assert.match(
    exp,
    /const elements = slide\.locator\("\.slidev-slide-loading"\);\s*const count = await elements\.count\(\);\s*for \(let index = 0; index < count; index\+\+\) await elements\.nth\(index\)\.waitFor\(\{ state: "detached" \}\);/
  );
  // PDF: one piece through print (the sidecar never passes --per-slide).
  assert.match(exp, /return perSlide \? genPagePdfPerSlide\(\) : genPagePdfOnePiece\(\);/);
  assert.match(exp, /async function genPagePdfOnePiece\(\) \{\s*await go\("print"\);/);
  // PowerPoint: the sidecar asks for pptx-editable, which hands `go` to the
  // pptx chunk, whose export starts by going to print.
  assert.equal(slidevExportFormat("pptx"), "pptx-editable");
  assert.match(exp, /else if \(format === "pptx-editable"\) await genPagePptxEditable\(\);/);
  assert.match(exp, /await exportPptxEditable\(\{[^}]*\bgo\b[^}]*\}, output\)/);
  assert.match(dist("pptx"), /async function exportPptxEditable\(ctx, output\) \{\s*await ctx\.go\("print"\);/);
});

// The template preview (sidecar.js `preview`) reads its PNGs back by name:
// without --with-clicks (PNG's default) and --per-slide (never passed), each
// slide is `<n>.png`, n its unpadded number. The real export below needs
// Chromium; this reads the CLI's source, so CI checks it too.
test("a PNG export names each slide <n>.png, unpadded, by default", withSlidev, () => {
  const exp = dist("export");
  const onePiece = /async function genPagePngOnePiece\(writeToDisk\) \{([\s\S]*?)\n\t\}\n/.exec(exp);
  assert.ok(onePiece, "genPagePngOnePiece");
  assert.match(onePiece[1], /const slideNo = \+id\.split\("-"\)\[0\];/);
  assert.match(onePiece[1], /const filename = `\$\{withClicks \? id : slideNo\}\.png`;/);
  assert.match(onePiece[1], /await fs\.writeFile\(path\.join\(writeToDisk, filename\), buffer\);/);
  assert.match(exp, /return perSlide \? genPagePngPerSlide\(writeToDisk\) : genPagePngOnePiece\(writeToDisk\);/);
  assert.match(exp, /withClicks: withClicks \?\? !!format\?\.startsWith\("pptx"\)/);
  assert.match(exp, /perSlide: perSlide \|\| false/);
});

// The template preview (sidecar.js `preview`) reads `slidev export --format
// png --output <dir>`'s files back as slides by their names: one `<n>.png`
// per slide, numbered from 1 and not zero-padded (one piece through print,
// without clicks; `--per-slide` would pad them). A real export, so it also
// needs the headless Chromium playwright downloads in its postinstall, which
// CI's `npm ci --ignore-scripts` skips: skipped there too.
let chromium = null;
try {
  const path_ = require("playwright-chromium").chromium.executablePath();
  if (fs.existsSync(path_)) chromium = path_;
} catch {
  // not installed
}
const withChromium = {
  skip: !(client && cli)
    ? "@slidev/cli isn't installed (npm ci in plugins/slidev)"
    : chromium
      ? false
      : "playwright's Chromium isn't installed (npm ci in plugins/slidev, with scripts)",
  timeout: 240_000,
};

test("a PNG export of a two-slide deck writes 1.png and 2.png", withChromium, async () => {
  const workspace = path.dirname(fileURLToPath(import.meta.url));
  // Slidev's project root is the entry's directory, where its theme is installed.
  const entry = path.join(workspace, `contract-png-${randomUUID()}.md`);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "mahfouz-slidev-contract-png-"));
  fs.writeFileSync(entry, "---\ntitle: Contract\n---\n\n# One\n\n---\n\n# Two\n");
  try {
    const log = [];
    const child = spawn(process.execPath, [cliEntry(workspace), "export", entry, "--output", output, "--format", "png"], {
      cwd: workspace,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (d) => log.push(d));
    child.stderr.setEncoding("utf8").on("data", (d) => log.push(d));
    const code = await new Promise((resolve) => child.on("exit", (c, signal) => resolve(signal ?? c)));
    assert.equal(code, 0, log.join(""));
    assert.deepEqual(fs.readdirSync(output).sort(), ["1.png", "2.png"]);
    for (const name of ["1.png", "2.png"]) {
      const bytes = fs.readFileSync(path.join(output, name));
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name} is a PNG`);
    }
  } finally {
    fs.rmSync(entry, { force: true });
    fs.rmSync(output, { recursive: true, force: true });
  }
});

// ---- each run serves its own vault's /files/ (vault-files.js) ----------------
//
// The bug this guards: one `public/files` link, repointed by every run, so
// Present for vault A and a preview of vault B served each other's files.
// Both vaults hold `files/probe.png`, red in A and blue in B; Present's dev
// server must answer A's, and B's preview must render blue, at the same time.
// The preview's slide shows the file as a Markdown image, which the Vue
// compiler turns into an import: blue also means that import resolved.

/** A 1×1 RGB PNG of one colour. */
function solidPng([r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, r, g, b]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The RGB of the pixel at the centre of an 8-bit, non-interlaced RGB or
 * RGBA PNG (what Chromium's screenshots are). */
function centrePixel(png) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit");
      assert.equal(data[12], 0, "not interlaced");
      channels = { 2: 3, 6: 4 }[data[9]];
      assert.ok(channels, `colour type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let prev = Buffer.alloc(stride);
  const row = Math.floor(height / 2);
  for (let y = 0; y <= row; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, paeth][filter]) & 0xff;
    }
    prev = line;
  }
  const x = Math.floor(width / 2) * channels;
  return [prev[x], prev[x + 1], prev[x + 2]];
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const FULL_SLIDE_IMAGE = `![probe](/files/probe.png)

<style>
img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
</style>
`;

test("Present for one vault and a preview of another each resolve their own /files/", withChromium, async () => {
  const vaults = {};
  for (const [name, colour] of [
    ["a", RED],
    ["b", BLUE],
  ]) {
    const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mahfouz-slidev-files-${name}-`)));
    fs.mkdirSync(path.join(vault, "files"));
    fs.writeFileSync(path.join(vault, "files", "probe.png"), solidPng(colour));
    fs.writeFileSync(path.join(vault, "talk.md"), `# Talk\n\n${FULL_SLIDE_IMAGE}`);
    vaults[name] = vault;
  }
  const { methods } = await import("./sidecar.js");
  const probe = async (url) => Buffer.from(await (await fetch(`${url}files/probe.png`)).arrayBuffer());
  try {
    const { url } = await methods.start({ vaultPath: vaults.a, relPath: "talk.md", template: null });
    assert.deepEqual(await probe(url), solidPng(RED), "Present serves A's file");

    const preview = methods.preview({ vaultPath: vaults.b, markdown: FULL_SLIDE_IMAGE, template: null });
    // Present keeps serving A's while B's preview runs.
    const during = await probe(url);
    const { slides } = await preview;
    assert.deepEqual(during, solidPng(RED), "Present still serves A's file while B's preview runs");
    assert.deepEqual(centrePixel(Buffer.from(slides[0].png, "base64")), BLUE, "the preview rendered B's file");
    assert.deepEqual(await probe(url), solidPng(RED), "and after it");
    assert.equal(fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "files")), false);
  } finally {
    methods.stop();
    const ws = path.dirname(fileURLToPath(import.meta.url));
    fs.rmSync(path.join(ws, "deck.md"), { force: true });
    fs.rmSync(path.join(ws, "vaults"), { recursive: true, force: true });
    for (const vault of Object.values(vaults)) fs.rmSync(vault, { recursive: true, force: true });
  }
});
