// Run with `npm test` (node --test) from the repo root. The sidecar's pure
// parts (ported from the app's former slidev.rs tests); the server and
// export need a real install, see the README's smoke test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { layerHtml } from "./header-footer.js";
import { deckLinksFor, deckRev, DECK_LINKS_FILE } from "./deck-links.js";
import {
  checkNote,
  cleanDeckLinks,
  deckUrl,
  entryModuleSrc,
  ensureLink,
  exportEntryContent,
  inlineRenderer,
  slidevExportFormat,
  linkVault,
  methods,
  pruneVaultLinks,
  nodeVersionOk,
  safeInlineHtml,
  safeJoin,
  stubContent,
  templateCss,
  templateHeadmatter,
  vaultLinkId,
  writeDeck,
} from "./sidecar.js";
import * as sidecar from "./sidecar.js";
import { entryVaultId, VAULT_KEY } from "./vault-files.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mahfouz-slidev-${name}-`));
}

test("the stub quotes src, and the idle placeholder imports nothing", () => {
  assert.equal(stubContent('./vaults/abc/Plain "Talk".md'), '---\nsrc: "./vaults/abc/Plain \\"Talk\\".md"\n---\n');
  assert.doesNotMatch(stubContent(null), /src:/);
});

test("the export entry sets an aspect ratio only for portrait", () => {
  assert.equal(exportEntryContent("./vaults/abc/n/a.md", false), '---\nsrc: "./vaults/abc/n/a.md"\n---\n');
  assert.equal(exportEntryContent("./vaults/abc/n/a.md", true), '---\nsrc: "./vaults/abc/n/a.md"\naspectRatio: "3/4"\n---\n');
});

test("export formats map to slidev's; PowerPoint is the editable export", () => {
  assert.equal(slidevExportFormat(undefined), "pdf");
  assert.equal(slidevExportFormat("pdf"), "pdf");
  assert.equal(slidevExportFormat("pptx"), "pptx-editable");
  assert.throws(() => slidevExportFormat("png"), /unsupported export format "png"/);
  assert.throws(() => slidevExportFormat("toString"), /unsupported export format/);
});

test("the vault link id is stable and filename-safe", () => {
  assert.equal(vaultLinkId("/Users/o/Notes"), vaultLinkId("/Users/o/Notes"));
  assert.notEqual(vaultLinkId("/Users/o/Notes"), vaultLinkId("/Users/o/Other"));
  assert.match(vaultLinkId("/a b/ç"), /^[0-9a-f]{16}$/);
});

test("vault links are created, kept, and repointed; no shared files link", () => {
  const base = tempDir("links");
  const ws = path.join(base, "ws");
  const v1 = path.join(base, "v1");
  const v2 = path.join(base, "v2");
  for (const d of [ws, path.join(v1, "files"), path.join(v2, "files")]) fs.mkdirSync(d, { recursive: true });

  // A shared `public/files` link from an older version is removed: each
  // run serves its own vault's files (vault-files.js).
  fs.mkdirSync(path.join(ws, "public"));
  fs.symlinkSync(path.join(v2, "files"), path.join(ws, "public", "files"), "dir");
  const id = linkVault(ws, v1);
  assert.equal(fs.readlinkSync(path.join(ws, "vaults", id)), v1);
  assert.equal(fs.existsSync(path.join(ws, "public", "files")), false);
  assert.equal(linkVault(ws, v1), id);
  const id2 = linkVault(ws, v2);
  assert.equal(fs.readlinkSync(path.join(ws, "vaults", id)), v1, "linking another vault leaves this one alone");
  assert.equal(fs.readlinkSync(path.join(ws, "vaults", id2)), v2);
  assert.equal(fs.existsSync(path.join(ws, "public", "files")), false);

  const stale = path.join(ws, "vaults", id);
  fs.unlinkSync(stale);
  fs.symlinkSync(v2, stale);
  ensureLink(stale, v1);
  assert.equal(fs.readlinkSync(stale), v1);

  const blocker = path.join(ws, "vaults", "real-dir");
  fs.mkdirSync(blocker);
  assert.throws(() => ensureLink(blocker, v1), /not a symlink/);
  fs.rmSync(base, { recursive: true, force: true });
});

test("note paths can't leave the vault", () => {
  assert.equal(safeJoin("/v", "a/b.md"), path.resolve("/v/a/b.md"));
  assert.throws(() => safeJoin("/v", "../etc/passwd"), /leaves the vault/);
  assert.throws(() => safeJoin("/v", "/etc/passwd"), /must be relative/);
});

test("the Vite entry module is found in index.html", () => {
  assert.equal(entryModuleSrc('<html><script type="module" src="/@fs/x/main.ts"></script></html>'), "/@fs/x/main.ts");
  assert.equal(entryModuleSrc('<script src="/y.ts" type="module"></script>'), "/y.ts");
  assert.equal(entryModuleSrc("<html></html>"), null);
});

test("Node version floor", () => {
  assert.equal(nodeVersionOk("v22.12.0"), true);
  assert.equal(nodeVersionOk("v24.0.0"), true);
  assert.equal(nodeVersionOk("v22.11.9"), false);
  assert.equal(nodeVersionOk("v20.19.0"), false);
});

test("deck URLs go through localhost", () => {
  assert.equal(deckUrl(3999), "http://localhost:3999/");
});

test("start and export refuse missing notes and paths with '#'", async () => {
  const vault = tempDir("vault");
  fs.writeFileSync(path.join(vault, "a#b.md"), "# x");
  await assert.rejects(methods.start({ vaultPath: vault, relPath: "missing.md" }), /note file not found/);
  await assert.rejects(methods.start({ vaultPath: vault, relPath: "a#b.md" }), /can't be presented/);
  fs.rmSync(vault, { recursive: true, force: true });
});

const BRAND = {
  name: "Brand",
  background: "#0B1F3A",
  backgroundImage: "/files/bg.png",
  textColor: "#fff",
  accentColor: "#F5A623",
  font: "Inter",
  logo: "/files/logo.png",
  logoPosition: "bottom-left",
  footer: "Acme",
  cover: { background: "#F5A623", logo: "/files/big.png" },
  css: "h1 { color: red; }",
};

test("template CSS styles every slide, then the cover, then the raw CSS", () => {
  const css = templateCss(BRAND);
  assert.match(css, /\.slidev-page \{[^}]*background-color: #0B1F3A;/);
  assert.match(css, /background-image: url\("\/files\/bg\.png"\);/);
  assert.match(css, /color: #fff;/);
  assert.match(css, /--slidev-theme-primary: #F5A623;/);
  assert.match(css, /\.slidev-page a \{ color: #F5A623; \}/);
  assert.match(css, /\.slidev-page\.slidev-page-1 \{[^}]*background-color: #F5A623;/);
  assert.ok(css.trimEnd().endsWith("h1 { color: red; }"));
});

test("template CSS leaves out what isn't set", () => {
  const css = templateCss({ name: "X", logoPosition: "top-right", cover: {}, css: "" });
  assert.equal(css, "");
  assert.doesNotMatch(templateCss({ ...BRAND, cover: {} }), /slidev-page-1/);
  assert.equal(templateCss(null), "");
});

test("template headmatter is JSON (valid YAML) for the layer components, plus fonts", () => {
  const lines = templateHeadmatter(BRAND);
  const m = /^mahfouz: (.*)$/m.exec(lines);
  assert.ok(m);
  assert.deepEqual(JSON.parse(m[1]), {
    css: templateCss(BRAND),
    logo: "/files/logo.png",
    coverLogo: "/files/big.png",
    logoPosition: "bottom-left",
    footer: "Acme",
  });
  assert.match(lines, /^fonts: \{"sans":"Inter"\}$/m);
  assert.equal(templateHeadmatter(null), "");
});

test("entries carry the template headmatter", () => {
  assert.equal(stubContent("./a.md", null), '---\nsrc: "./a.md"\n---\n');
  const stub = stubContent("./a.md", BRAND);
  assert.ok(stub.startsWith('---\nsrc: "./a.md"\nmahfouz: '));
  assert.ok(stub.endsWith("\n---\n"));
  const exp = exportEntryContent("./a.md", true, BRAND);
  assert.match(exp, /aspectRatio: "3\/4"\n/);
  assert.match(exp, /\nmahfouz: /);
});

test("template headmatter renders header and footer and carries titleSlide", () => {
  const render = (s) => `<r>${s}</r>`;
  const lines = templateHeadmatter({ ...BRAND, header: "**H** {page}", titleSlide: true }, render);
  const data = JSON.parse(/^mahfouz: (.*)$/m.exec(lines)[1]);
  assert.equal(data.header, "<r>**H** {page}</r>");
  assert.equal(data.footer, "<r>Acme</r>");
  assert.equal(data.titleSlide, true);
});

test("a bare template (name \"\") with only a footer still writes headmatter", () => {
  const lines = templateHeadmatter({ name: "", logoPosition: "top-right", cover: {}, css: "", footer: "F" });
  assert.deepEqual(JSON.parse(/^mahfouz: (.*)$/m.exec(lines)[1]), { logoPosition: "top-right", footer: "F" });
});

// A v2 template (the app's `stylesheet`, `colorSchema`, `fontFamilies`): the
// app builds the whole look, fonts included, so the plugin passes it through.
// Raw css inside it is the vault owner's and can hold anything.
const HOSTILE_CSS = 'h1 { color: red; }\n</style><script>alert(1)</script>\n---\nlayout: x\n---\na\u2028b\u2029c\u0085d { }';
const V2 = {
  ...BRAND,
  stylesheet: `@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");\n.slidev-page:where([data-layout="quote"]) { --mahfouz-text: #111; }\n${HOSTILE_CSS}`,
  colorSchema: "dark",
  fontFamilies: ["Inter", "mahfouz-brand"],
};
const mahfouzLine = (lines) => JSON.parse(/^mahfouz: (.*)$/m.exec(lines)[1]);

test("a v2 template's stylesheet is the CSS, byte for byte, with no fonts: line", () => {
  const lines = templateHeadmatter(V2);
  assert.equal(mahfouzLine(lines).css, V2.stylesheet);
  assert.doesNotMatch(lines, /^fonts:/m);
});

test("an empty stylesheet is still the v2 path: no legacy CSS and no fonts: line", () => {
  const lines = templateHeadmatter({ ...BRAND, stylesheet: "" });
  assert.equal(mahfouzLine(lines).css, undefined);
  assert.doesNotMatch(lines, /^fonts:/m);
});

test("without a stylesheet (an older app) the plugin's own CSS and fonts: stay", () => {
  const lines = templateHeadmatter({ ...BRAND, stylesheet: 42 });
  assert.equal(mahfouzLine(lines).css, templateCss(BRAND));
  assert.match(lines, /^fonts: \{"sans":"Inter"\}$/m);
});

test("colorSchema goes in the headmatter only as light or dark", () => {
  assert.match(templateHeadmatter(V2), /^colorSchema: "dark"$/m);
  assert.match(templateHeadmatter({ ...V2, colorSchema: "light" }), /^colorSchema: "light"$/m);
  for (const colorSchema of [undefined, "auto", "purple", 1]) {
    assert.doesNotMatch(templateHeadmatter({ ...V2, colorSchema }), /colorSchema/);
  }
});

test("fontFamilies reach the layer components through mahfouz:, strings only", () => {
  assert.deepEqual(mahfouzLine(templateHeadmatter(V2)).fontFamilies, ["Inter", "mahfouz-brand"]);
  assert.deepEqual(mahfouzLine(templateHeadmatter({ ...V2, fontFamilies: ["Inter", 3, null] })).fontFamilies, ["Inter"]);
  assert.equal(mahfouzLine(templateHeadmatter({ ...V2, fontFamilies: "Inter" })).fontFamilies, undefined);
  assert.equal(mahfouzLine(templateHeadmatter({ ...V2, fontFamilies: [] })).fontFamilies, undefined);
});

test("the mahfouz: line has no character a YAML parser could break a line on", () => {
  const lines = templateHeadmatter(V2);
  assert.doesNotMatch(lines, /[\u0085\u2028\u2029]/);
  assert.equal(lines.split("\n").filter((l) => l.startsWith("mahfouz: ")).length, 1);
  const stub = stubContent("./a.md", V2);
  assert.equal(stub.split("\n").filter((l) => l === "---").length, 2, "a `---` inside the CSS can't end the headmatter");
});

test("each entry names the vault its /files/ come from, right after src", () => {
  const id = "0123456789abcdef";
  const key = `\n${VAULT_KEY}: "${id}"\n`;
  assert.equal(stubContent("./vaults/x/a.md", null, undefined, id), `---\nsrc: "./vaults/x/a.md"${key}---\n`);
  assert.equal(exportEntryContent("./export-src-1.md", true, null, undefined, id), `---\nsrc: "./export-src-1.md"${key}aspectRatio: "3/4"\n---\n`);
  assert.equal(sidecar.previewEntryContent(null, undefined, id), `---\nsrc: "./preview-src.md"${key}---\n`);
  for (const entry of [stubContent("./a.md", V2, undefined, id), exportEntryContent("./a.md", false, V2, undefined, id), sidecar.previewEntryContent(V2, undefined, id)]) {
    assert.equal(entryVaultId(entry), id);
  }
  assert.equal(entryVaultId(stubContent(null)), null);
});

test("Present's stub and the export entry carry the same mahfouz: line", () => {
  const line = (s) => /^mahfouz: .*$/m.exec(s)[0];
  assert.equal(line(stubContent("./a.md", V2)), line(exportEntryContent("./a.md", false, V2)));
  assert.equal(line(stubContent("./a.md", V2)), line(exportEntryContent("./a.md", true, V2)));
  assert.equal(mahfouzLine(stubContent("./a.md", V2)).css, V2.stylesheet);
});

// The `yaml` package is the one Slidev parses headmatter with (a dependency
// of @slidev/parser, from the plugin's npm install).
let YAML = null;
try {
  YAML = await import("yaml");
} catch (err) {
  if (process.env.CI) throw err;
}
const withYaml = { skip: YAML ? false : "yaml isn't installed (npm ci in plugins/slidev)" };

test("Slidev's YAML parser reads a sample template back from both entries (the mahfouz: line test guards the escaping)", withYaml, () => {
  const headmatter = (entry) => YAML.parse(/^---\n([\s\S]*?)\n---\n$/.exec(entry)[1]);
  for (const entry of [stubContent("./a.md", V2), exportEntryContent("./a.md", true, V2)]) {
    const data = headmatter(entry);
    assert.equal(data.mahfouz.css, V2.stylesheet);
    assert.equal(data.colorSchema, "dark");
    assert.deepEqual(data.mahfouz.fontFamilies, ["Inter", "mahfouz-brand"]);
    assert.equal(data.fonts, undefined);
  }
});

// markdown-it comes from the plugin's own npm install (CI runs `npm ci` in
// plugins/slidev before the tests). Without it, these tests are skipped
// locally and fail in CI.
let MarkdownIt = null;
try {
  ({ default: MarkdownIt } = await import("markdown-it"));
} catch (err) {
  if (process.env.CI) throw err;
}
const withMarkdownIt = { skip: MarkdownIt ? false : "markdown-it isn't installed (npm ci in plugins/slidev)" };

const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "<svg onload=alert(1)>",
  "<a href=\"javascript:alert(1)\">x</a>",
  "<iframe src=\"https://evil.example\"></iframe>",
  "<!-- x --><b onclick=alert(1)>b</b>",
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](vbscript:msgbox(1))",
  "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  "[x](data:text/html,<script>alert(1)</script>)",
  "[x](&#106;avascript:alert(1))",
  "**<img src=x onerror=alert(1)>** {page}",
];

/** Whether `html`, parsed the way a browser would, could run script: any
 * element other than the inline Markdown ones, any on* attribute, or a
 * script-capable URL. A deliberately simple model of the DOM; the inputs are
 * markdown-it's output or escaped text. */
function runsScript(html) {
  for (const [, name, attrs] of html.matchAll(/<([a-zA-Z][^\s>\/]*)([^>]*)>/g)) {
    if (!["a", "img", "strong", "em", "s", "code", "br"].includes(name)) return true;
    if (/\son/i.test(attrs)) return true;
    for (const [, url] of attrs.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const decoded = url.replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
      if (/^\s*(?:javascript|vbscript|data:(?!image\/(?:gif|png|jpeg|webp);))/i.test(decoded)) return true;
    }
  }
  return false;
}

test("a hostile header or footer renders as inert text", withMarkdownIt, () => {
  const render = inlineRenderer(MarkdownIt);
  for (const header of HOSTILE) {
    const html = render(header);
    assert.equal(runsScript(html), false, `${header} → ${html}`);
    const shown = layerHtml({ header: html }, "header", 2, 5);
    assert.equal(runsScript(shown), false, `${header} → ${shown}`);
  }
  assert.equal(render("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(render("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("a hostile header stays inert through the template headmatter", withMarkdownIt, () => {
  const lines = templateHeadmatter(
    { ...BRAND, header: "<img src=x onerror=alert(1)> {page}", footer: "<script>alert(1)</script>" },
    inlineRenderer(MarkdownIt)
  );
  const data = JSON.parse(/^mahfouz: (.*)$/m.exec(lines)[1]);
  assert.equal(data.header, "&lt;img src=x onerror=alert(1)&gt; {page}");
  assert.equal(data.footer, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(layerHtml(data, "header", 3, 7), "&lt;img src=x onerror=alert(1)&gt; 3");
});

test("inline Markdown still renders in a header and footer", withMarkdownIt, () => {
  const render = inlineRenderer(MarkdownIt);
  assert.equal(render("**Acme** · *Q3* {page} / {total}"), "<strong>Acme</strong> · <em>Q3</em> {page} / {total}");
  assert.equal(render("~~old~~ `code`"), "<s>old</s> <code>code</code>");
  assert.equal(render("[Site](https://acme.example \"Home\")"), '<a href="https://acme.example" title="Home">Site</a>');
  assert.equal(render("![logo](/files/logo.png)"), '<img src="/files/logo.png" alt="logo">');
  assert.equal(render("[mail](mailto:a@acme.example)"), '<a href="mailto:a@acme.example">mail</a>');
  assert.equal(render("Tom & Jerry <3"), "Tom &amp; Jerry &lt;3");
  assert.equal(layerHtml({ footer: render("**{page}** of {total}") }, "footer", 2, 9), "<strong>2</strong> of 9");
});

test("safeInlineHtml passes inline Markdown markup through", () => {
  for (const html of [
    "<strong>a</strong> <em>b</em> <s>c</s> <code>d</code><br>",
    '<a href="https://x.example/?a=1&amp;b=2" title="t">x</a>',
    '<a href="#top">top</a> <a href="/files/a.pdf">a</a>',
    '<img src="/files/logo.png" alt="logo"> <img src="data:image/png;base64,AAAA" alt="">',
    "plain &amp; &lt;text&gt; &quot;q&quot;",
  ]) {
    assert.equal(safeInlineHtml(html, "src"), html);
  }
});

test("safeInlineHtml falls back to escaped source for anything else", () => {
  const source = "<b>x</b>";
  for (const html of [
    "<b>x</b>",
    "<img src=x onerror=alert(1)>",
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href=" JAVASCRIPT:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="data:text/html,x">x</a>',
    '<img src="data:image/svg+xml;base64,AAAA" alt="">',
    '<a href="https://x.example" style="color:red">x</a>',
    "<STRONG>x</STRONG>",
    "<strong >x</strong>",
    "</strong x>",
    "<!-- x -->",
    "<script>alert(1)</script>",
    "<svg/onload=alert(1)>",
    "a < b",
    "<a",
  ]) {
    assert.equal(safeInlineHtml(html, source), "&lt;b&gt;x&lt;/b&gt;", html);
  }
});

test("pruning keeps only the vault links in use, and only removes links", () => {
  const ws = tempDir("prune");
  const vaults = ["a", "b", "c"].map((n) => {
    const v = tempDir(`vault-${n}`);
    fs.writeFileSync(path.join(v, "note.md"), "# n\n");
    return v;
  });
  const ids = vaults.map((v) => linkVault(ws, v));
  fs.writeFileSync(path.join(ws, "vaults", "not-a-link"), "x");
  pruneVaultLinks(ws, new Set([ids[1]]));
  assert.deepEqual(fs.readdirSync(path.join(ws, "vaults")).sort(), [ids[1], "not-a-link"].sort());
  // The vaults themselves are untouched.
  for (const v of vaults) assert.ok(fs.existsSync(path.join(v, "note.md")));
});

test("pruning a workspace that has no vaults/ yet is a no-op", () => {
  assert.doesNotThrow(() => pruneVaultLinks(tempDir("empty"), new Set()));
});

// ---- the template preview ------------------------------------------------------
//
// `preview` renders the app's sample deck with a slides template to PNGs
// (Settings → Slides' "Render with Slidev"). Its helpers are read through
// the `sidecar` namespace, so a missing export fails only these tests.

/** The bytes a PNG file starts with, then a marker so files differ. */
const pngBytes = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(String(n))]);

test("the preview entry is headmatter only, ordered and escaped like the export entry, importing ./preview-src.md", () => {
  const render = (s) => `<r>${s}</r>`;
  assert.equal(sidecar.previewEntryContent(null), '---\nsrc: "./preview-src.md"\n---\n');
  for (const template of [BRAND, V2, { ...V2, header: "**H** {page}", titleSlide: true }]) {
    assert.equal(sidecar.previewEntryContent(template), exportEntryContent("./preview-src.md", false, template));
    assert.equal(sidecar.previewEntryContent(template, render), exportEntryContent("./preview-src.md", false, template, render));
  }
  const entry = sidecar.previewEntryContent(V2);
  assert.ok(entry.startsWith('---\nsrc: "./preview-src.md"\nmahfouz: '));
  assert.doesNotMatch(entry, /aspectRatio/);
  assert.equal(entry.split("\n").filter((l) => l === "---").length, 2, "a `---` inside the CSS can't end the headmatter");
});

test("pngSlides reads the PNGs in slide order (1, 2, 10), as base64", () => {
  const dir = tempDir("pngs");
  for (const n of [10, 2, 1]) fs.writeFileSync(path.join(dir, `${n}.png`), pngBytes(n));
  const slides = sidecar.pngSlides(dir);
  assert.deepEqual(slides, [1, 2, 10].map((n) => pngBytes(n).toString("base64")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pngSlides refuses a PNG whose name isn't a slide number", () => {
  assert.equal(typeof sidecar.pngSlides, "function");
  for (const name of ["cover.png", "1-1.png", "x2.png"]) {
    const dir = tempDir("pngs-bad");
    fs.writeFileSync(path.join(dir, "1.png"), pngBytes(1));
    fs.writeFileSync(path.join(dir, name), pngBytes(2));
    assert.throws(() => sidecar.pngSlides(dir), /slide number/, name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pngSlides refuses two PNGs for one slide, and an export with no PNGs", () => {
  const dir = tempDir("pngs-dup");
  fs.writeFileSync(path.join(dir, "1.png"), pngBytes(1));
  fs.writeFileSync(path.join(dir, "01.png"), pngBytes(2));
  assert.throws(() => sidecar.pngSlides(dir), /twice/);
  fs.rmSync(dir, { recursive: true, force: true });

  const empty = tempDir("pngs-empty");
  fs.writeFileSync(path.join(empty, "notes.txt"), "not a slide");
  assert.throws(() => sidecar.pngSlides(empty), /no slides/);
  fs.rmSync(empty, { recursive: true, force: true });
});

// The preview's tests run the sidecar's real spawn path against a stand-in
// Slidev CLI (at `cliEntry(ws)` in a temp workspace) that does what `slidev
// export` would: writes the PNGs (or, for a PDF, the file) named by
// `fixture.json` into `--output`. Each run records what it saw (its
// arguments, cwd, env, the entry and sample deck, the vault links) in
// `calls.jsonl`; with `block`, a PNG run waits for a `release` file, and
// with `blockExport`, so does a PDF run. Without `export` it stands in for
// Present's dev server: it answers on `--port` until it's stopped.
const STAND_IN_CLI = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const ws = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(ws, "fixture.json"), "utf8"));
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
if (args[0] !== "export") {
  http.createServer((_, res) => res.end("<html></html>")).listen(Number(at("--port")), "localhost");
} else {
const out = at("--output");
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const linksDir = path.join(ws, "vaults");
const links = {};
if (fs.existsSync(linksDir)) for (const name of fs.readdirSync(linksDir)) links[name] = fs.readlinkSync(path.join(linksDir, name));
fs.appendFileSync(
  path.join(ws, "calls.jsonl"),
  JSON.stringify({
    args,
    cwd: process.cwd(),
    env: { NO_COLOR: process.env.NO_COLOR, CI: process.env.CI },
    entry: read(args[1]),
    src: read(path.join(ws, "preview-src.md")),
    links,
  }) + "\\n"
);
if (at("--format") !== "png") {
  if (cfg.blockExport) while (!fs.existsSync(path.join(ws, "release"))) await new Promise((r) => setTimeout(r, 10));
  fs.writeFileSync(out, "%PDF-");
  process.exit(0);
}
if (cfg.block) while (!fs.existsSync(path.join(ws, "release"))) await new Promise((r) => setTimeout(r, 10));
fs.mkdirSync(out, { recursive: true });
for (const [name, spec] of Object.entries(cfg.pngs ?? {})) {
  const bytes = typeof spec === "number" ? Buffer.alloc(spec) : Buffer.from(spec, "base64");
  fs.writeFileSync(path.join(out, name), bytes);
}
if (cfg.fail) {
  console.error(cfg.fail);
  process.exit(1);
}
}
`;

/**
 * A fresh sidecar module whose workspace is a temp dir holding the stand-in
 * CLI, and a vault (real paths, so a resolved vault path is the same string).
 * The module is imported again per call, so its state starts empty.
 */
let instances = 0;
async function previewSidecar(fixture = { pngs: { "1.png": pngBytes(1).toString("base64") } }) {
  const ws = fs.realpathSync(tempDir("preview-ws"));
  const cli = sidecar.cliEntry(ws);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, STAND_IN_CLI);
  const vault = fs.realpathSync(tempDir("preview-vault"));
  fs.mkdirSync(path.join(vault, "files"));
  const setFixture = (f) => fs.writeFileSync(path.join(ws, "fixture.json"), JSON.stringify(f));
  setFixture(fixture);
  const saved = process.env.MAHFOUZ_PLUGIN_DIR;
  process.env.MAHFOUZ_PLUGIN_DIR = ws;
  try {
    const mod = await import(`./sidecar.js?preview=${++instances}`);
    const calls = () => {
      const file = path.join(ws, "calls.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    };
    return { mod, ws, vault, calls, setFixture, release: () => fs.writeFileSync(path.join(ws, "release"), "") };
  } finally {
    if (saved === undefined) delete process.env.MAHFOUZ_PLUGIN_DIR;
    else process.env.MAHFOUZ_PLUGIN_DIR = saved;
  }
}

/** `--output <dir>` from a run's arguments. */
function outputDir(args) {
  const i = args.indexOf("--output");
  assert.ok(i >= 0 && typeof args[i + 1] === "string", `--output in ${args.join(" ")}`);
  return args[i + 1];
}

const b64 = (n) => pngBytes(n).toString("base64");
const MB = 1024 * 1024;

async function until(cond, what) {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), what);
}

const LEFTOVERS = ["preview.md", "preview-src.md", "deck.md", "export.md", "export-src.md"];
const noLeftovers = (ws) => {
  for (const name of LEFTOVERS) assert.equal(fs.existsSync(path.join(ws, name)), false, `${name} is left in the workspace`);
};

test("preview renders the markdown with the template through slidev's PNG export and returns the slides in order", async () => {
  const { mod, ws, vault, calls } = await previewSidecar({ pngs: { "2.png": b64(2), "1.png": b64(1), "10.png": b64(10) } });
  const markdown = "# One\n\n---\n\n# Two\n";
  const template = { ...V2, header: undefined, footer: undefined };
  const result = await mod.methods.preview({ vaultPath: vault, markdown, template });
  assert.deepEqual(result, { slides: [{ png: b64(1) }, { png: b64(2) }, { png: b64(10) }] });

  const [run] = calls();
  assert.equal(calls().length, 1);
  // Export's command line, cwd and env (one runner for both).
  assert.deepEqual(run.args.slice(0, 2), ["export", path.join(ws, "preview.md")]);
  assert.equal(run.args[run.args.indexOf("--format") + 1], "png");
  assert.equal(run.cwd, ws);
  assert.deepEqual(run.env, { NO_COLOR: "1", CI: "1" });
  // While it ran: the entry, the sample deck, and the vault linked for `/files/` images.
  assert.equal(run.entry, mod.previewEntryContent(template, undefined, vaultLinkId(vault)));
  assert.equal(run.src, markdown);
  assert.equal(run.links[vaultLinkId(vault)], vault);

  const out = outputDir(run.args);
  assert.equal(path.dirname(out), os.tmpdir(), "a fresh dir directly under the OS temp dir");
  assert.equal(fs.existsSync(out), false, "the output dir is removed after a render");
  noLeftovers(ws);
});

test("preview renders a template's header and footer as Markdown, like export", withMarkdownIt, async () => {
  const { mod, vault, calls } = await previewSidecar();
  const template = { ...V2, header: "**H** {page}", footer: "*F*" };
  await mod.methods.preview({ vaultPath: vault, markdown: "# a", template });
  const run = calls()[0];
  assert.equal(run.entry, mod.previewEntryContent(template, inlineRenderer(MarkdownIt), vaultLinkId(vault)));
  const data = mahfouzLine(run.entry);
  assert.equal(data.header, "<strong>H</strong> {page}");
  assert.equal(data.footer, "<em>F</em>");
});

test("each preview renders into its own temp dir", async () => {
  const { mod, vault, calls } = await previewSidecar();
  await mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null });
  await mod.methods.preview({ vaultPath: vault, markdown: "# b", template: null });
  const [a, b] = calls().map((c) => outputDir(c.args));
  assert.notEqual(a, b);
});

test("preview refuses bad params before writing or rendering anything", async () => {
  const { mod, ws, vault, calls } = await previewSidecar();
  const aFile = path.join(vault, "note.md");
  fs.writeFileSync(aFile, "# n\n");
  const bad = [
    [{ vaultPath: vault, markdown: 42 }, /markdown/],
    [{ vaultPath: vault }, /markdown/],
    [{ vaultPath: vault, markdown: "x".repeat(64 * 1024 + 1) }, /markdown/],
    // 32 K characters, 64 KB + 2 bytes: the cap is on bytes.
    [{ vaultPath: vault, markdown: "é".repeat(32 * 1024 + 1) }, /markdown/],
    [{ vaultPath: "relative/vault", markdown: "# a" }, /vaultPath|absolute/],
    [{ vaultPath: 7, markdown: "# a" }, /vaultPath|absolute/],
    [{ markdown: "# a" }, /vaultPath|absolute/],
    [{ vaultPath: path.join(vault, "missing"), markdown: "# a" }, /vault/],
    [{ vaultPath: aFile, markdown: "# a" }, /vault/],
    [{ vaultPath: "/", markdown: "# a" }, /vault/],
    [{ vaultPath: vault, markdown: "# a", template: "Brand" }, /template/],
    [{ vaultPath: vault, markdown: "# a", template: 42 }, /template/],
    [{ vaultPath: vault, markdown: "# a", template: [] }, /template/],
    [{ vaultPath: vault, markdown: "# a", template: { stylesheet: 42 } }, /template|stylesheet/],
    [{ vaultPath: vault, markdown: "# a", template: { header: 1 } }, /template|header/],
    [{ vaultPath: vault, markdown: "# a", template: { footer: {} } }, /template|footer/],
    [{ vaultPath: vault, markdown: "# a", template: { stylesheet: "x".repeat(256 * 1024 + 1) } }, /template|stylesheet/],
  ];
  for (const [params, message] of bad) {
    await assert.rejects(mod.methods.preview({ template: null, ...params }), message, JSON.stringify(params).slice(0, 80));
  }
  assert.deepEqual(calls(), []);
  for (const name of ["preview.md", "preview-src.md", "vaults"]) assert.equal(fs.existsSync(path.join(ws, name)), false, name);
});

test("preview takes 64 KB of markdown, a 256 KB stylesheet, and a vault path that resolves to the vault", async () => {
  const { mod, vault, calls } = await previewSidecar();
  fs.mkdirSync(path.join(vault, "sub"));
  const ok = await mod.methods.preview({
    vaultPath: path.join(vault, "sub", ".."),
    markdown: "x".repeat(64 * 1024),
    template: { name: "T", stylesheet: "x".repeat(256 * 1024), header: "H", footer: "F" },
  });
  assert.equal(ok.slides.length, 1);
  assert.equal(calls()[0].links[vaultLinkId(vault)], vault, "the link id comes from the resolved path");
});

test("a failed render removes the output dir and the entries, and reports slidev's output", async () => {
  const { mod, ws, vault, calls } = await previewSidecar({ pngs: { "1.png": b64(1) }, fail: "chromium crashed" });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /chromium crashed/);
  assert.equal(calls().length, 1);
  assert.equal(fs.existsSync(outputDir(calls()[0].args)), false);
  noLeftovers(ws);
});

test("PNGs slidev didn't name by slide number fail the render and are removed with the output dir", async () => {
  const { mod, ws, vault, calls } = await previewSidecar({ pngs: { "1.png": b64(1), "1-1.png": b64(2) } });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /slide number/);
  assert.equal(calls().length, 1);
  assert.equal(fs.existsSync(outputDir(calls()[0].args)), false);
  noLeftovers(ws);
});

// The app takes a slide's data URL of at most 4 MiB characters
// (SLIDES_PREVIEW_MAX_PNG_BYTES in the app's slidesPreview.ts), prefix
// included: so a PNG may have as many bytes as base64 fits in what's left.
const APP_DATA_URL_MAX = 4 * MB;
const DATA_URL_PREFIX = "data:image/png;base64,";
const dataUrlLength = (bytes) => DATA_URL_PREFIX.length + 4 * Math.ceil(bytes / 3);
const PNG_CAP = Math.floor((APP_DATA_URL_MAX - DATA_URL_PREFIX.length) / 4) * 3;

test("the per-PNG cap is the largest PNG whose data URL the app takes", () => {
  assert.equal(sidecar.PREVIEW_PNG_CAP, PNG_CAP);
  assert.ok(dataUrlLength(PNG_CAP) <= APP_DATA_URL_MAX);
  assert.ok(dataUrlLength(PNG_CAP + 1) > APP_DATA_URL_MAX);
});

test("a PNG whose data URL would be over the app's 4 MB is refused, and the output dir removed", async () => {
  const { mod, vault, calls } = await previewSidecar({ pngs: { "1.png": b64(1), "2.png": PNG_CAP + 1 } });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /4 MB/);
  assert.equal(fs.existsSync(outputDir(calls()[0].args)), false);
});

test("a PNG at the cap is fine, and its data URL fits the app's limit", async () => {
  const { mod, vault } = await previewSidecar({ pngs: { "1.png": PNG_CAP } });
  const { slides } = await mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null });
  assert.equal(Buffer.from(slides[0].png, "base64").length, PNG_CAP);
  assert.ok(DATA_URL_PREFIX.length + slides[0].png.length <= APP_DATA_URL_MAX);
});

test("a render over 30 MB of PNGs in all is refused, and its output dir removed", async () => {
  const pngs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`${i + 1}.png`, PNG_CAP]));
  const { mod, vault, calls } = await previewSidecar({ pngs });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /30 MB/);
  assert.equal(fs.existsSync(outputDir(calls()[0].args)), false);
});

test("a preview asked for while one runs is refused at once as busy; the next one after it runs", async () => {
  const { mod, vault, calls, setFixture, release } = await previewSidecar({ pngs: { "1.png": b64(1) }, block: true, fail: "first fails" });
  const params = { vaultPath: vault, markdown: "# a", template: null };
  const first = mod.methods.preview(params);
  const firstSettled = assert.rejects(first, /first fails/);
  await until(() => calls().length === 1, "the first render started");
  await assert.rejects(mod.methods.preview(params), /busy/);
  // Refused without running.
  assert.equal(calls().length, 1);
  setFixture({ pngs: { "1.png": b64(2) } });
  release();
  await firstSettled;
  assert.deepEqual(await mod.methods.preview(params), { slides: [{ png: b64(2) }] }, "a failed preview doesn't block the next");
  assert.equal(calls().length, 2);
});

test("a preview keeps its vault linked through another vault's export, and unlinks it when done", async () => {
  const { mod, ws, vault, calls, setFixture, release } = await previewSidecar({ pngs: { "1.png": b64(1) }, block: true });
  const other = fs.realpathSync(tempDir("preview-other"));
  fs.writeFileSync(path.join(other, "a.md"), "# a\n");
  const link = (v) => path.join(ws, "vaults", vaultLinkId(v));

  const preview = mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null });
  await until(() => calls().length === 1, "the preview started");
  // The export prunes the links not in use; the preview's is in use.
  const pdf = await mod.methods.export({ vaultPath: other, relPath: "a.md", orientation: "landscape", template: null, format: "pdf" });
  fs.rmSync(pdf, { force: true });
  assert.equal(calls()[1].cwd, ws, "export runs slidev the same way");
  assert.deepEqual(calls()[1].env, calls()[0].env);
  assert.equal(fs.readlinkSync(link(vault)), vault, "still linked mid-render");
  release();
  await preview;
  assert.equal(fs.existsSync(link(vault)), false, "unlinked after the preview");

  // And after a failed one.
  fs.rmSync(path.join(ws, "release"));
  setFixture({ fail: "boom" });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /boom/);
  assert.equal(fs.existsSync(link(vault)), false, "unlinked after a failed preview");
});

// The bug these guard: one `public/files` link, repointed by every run, so
// Present for one vault and an export or preview for another served each
// other's /files/. Each run's entry now names its own vault, and the
// middleware (vault-files.js) serves /files/ from that one.
test("Present for one vault and a preview for another each name their own vault for /files/", async () => {
  const { mod, ws, vault, calls, release } = await previewSidecar({ pngs: { "1.png": b64(1) }, block: true });
  const other = fs.realpathSync(tempDir("present-vault"));
  fs.writeFileSync(path.join(other, "talk.md"), "# talk\n");
  try {
    await mod.methods.start({ vaultPath: other, relPath: "talk.md", template: null });
    const deck = () => fs.readFileSync(path.join(ws, "deck.md"), "utf8");
    assert.equal(entryVaultId(deck()), vaultLinkId(other));

    const preview = mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null });
    await until(() => calls().length === 1, "the preview started");
    assert.equal(entryVaultId(calls()[0].entry), vaultLinkId(vault), "the preview's run serves the preview's vault");
    assert.equal(entryVaultId(deck()), vaultLinkId(other), "Present still serves its own vault");
    assert.deepEqual(calls()[0].links, { [vaultLinkId(other)]: other, [vaultLinkId(vault)]: vault });
    assert.equal(fs.existsSync(path.join(ws, "public", "files")), false, "no shared files link");
    release();
    await preview;
    assert.equal(entryVaultId(deck()), vaultLinkId(other));
  } finally {
    mod.methods.stop();
  }
});

test("two exports of different vaults run at once from entries of their own, removed afterwards", async () => {
  const { mod, ws, vault, calls, release } = await previewSidecar({ blockExport: true });
  const other = fs.realpathSync(tempDir("export-other"));
  fs.writeFileSync(path.join(other, "b.md"), "# b\n");
  fs.writeFileSync(path.join(vault, "a.md"), "# a\n");
  const a = mod.methods.export({ vaultPath: vault, relPath: "a.md", orientation: "landscape", template: null, format: "pdf" });
  const b = mod.methods.export({ vaultPath: other, relPath: "b.md", orientation: "landscape", template: null, format: "pdf", content: "# b, with children\n" });
  await until(() => calls().length === 2, "both exports started");
  const [runA, runB] = [...calls()].sort((x, y) => (x.entry.includes(vaultLinkId(vault)) ? -1 : 1));
  assert.notEqual(runA.args[1], runB.args[1], "each export has its own entry");
  assert.equal(entryVaultId(runA.entry), vaultLinkId(vault));
  assert.equal(entryVaultId(runB.entry), vaultLinkId(other));
  assert.match(runA.entry, new RegExp(`src: "./vaults/${vaultLinkId(vault)}/a.md"`));
  // The content export reads its own source file, not a shared one.
  const srcB = /src: "\.\/([^"]+)"/.exec(runB.entry)[1];
  assert.match(srcB, /^export-src-[0-9a-f-]+\.md$/);
  assert.equal(fs.readFileSync(path.join(ws, srcB), "utf8"), "# b, with children\n");
  release();
  for (const pdf of await Promise.all([a, b])) fs.rmSync(pdf, { force: true });
  assert.deepEqual(
    fs.readdirSync(ws).filter((n) => n.startsWith("export")),
    [],
    "the export entries and sources are removed"
  );
});

test("null template fields are taken as absent", async () => {
  const { mod, vault, calls } = await previewSidecar();
  const template = { name: "T", logoPosition: "top-right", cover: {}, css: "", stylesheet: null, header: null, footer: null };
  const { slides } = await mod.methods.preview({ vaultPath: vault, markdown: "# a", template });
  assert.equal(slides.length, 1);
  assert.equal(calls()[0].entry, mod.previewEntryContent(template, undefined, vaultLinkId(vault)));
});

test("a preview whose temp dir can't be made leaves no vault linked and no entries behind", async () => {
  const { mod, ws, vault, calls } = await previewSidecar();
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = path.join(ws, "no-such-tmp");
  try {
    await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /ENOENT/);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  assert.deepEqual(calls(), []);
  assert.equal(fs.existsSync(path.join(ws, "vaults", vaultLinkId(vault))), false, "the vault isn't left linked");
  noLeftovers(ws);
  // Nothing is left counted either: the next one renders, and unlinks after.
  assert.equal((await mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null })).slides.length, 1);
  assert.equal(fs.existsSync(path.join(ws, "vaults", vaultLinkId(vault))), false);
});

// The app shows a failed render's first line only, so it names the cause:
// the last line of Slidev's output that isn't blank or a stack frame.
test("logCause is the last non-empty, non-stack line of the output, trimmed to 200 characters", () => {
  assert.equal(typeof sidecar.logCause, "function");
  assert.equal(sidecar.logCause("vite ready\nError: chromium crashed\n    at launch (x.js:1:2)\n    at async main\n\n"), "Error: chromium crashed");
  assert.equal(sidecar.logCause("  [slidev] Theme not found  \n"), "[slidev] Theme not found");
  assert.equal(sidecar.logCause(""), "");
  assert.equal(sidecar.logCause("\n    at a (b:1:1)\n"), "");
  const long = sidecar.logCause(`E${"x".repeat(500)}`);
  assert.ok(long.length <= 200, `${long.length} characters`);
  assert.ok(long.startsWith("Exxx"));
});

test("a failed render's first line carries the cause, and the full output follows", async () => {
  const fail = "warming up\nError: chromium crashed\n    at launch (/x/export.mjs:1:2)";
  const { mod, vault } = await previewSidecar({ pngs: {}, fail });
  const err = await mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }).then(
    () => assert.fail("the preview should fail"),
    (e) => e
  );
  const [first, ...rest] = err.message.split("\n");
  assert.equal(first, "slidev export failed (1): Error: chromium crashed");
  assert.ok(rest.join("\n").includes(fail), err.message);
});

test("a failed render with no output still has a first line", async () => {
  const { mod, vault } = await previewSidecar({ pngs: {}, fail: " " });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), (e) => {
    assert.equal(e.message.split("\n")[0], "slidev export failed (1)");
    return true;
  });
});

// ---- the deck: parts and links ---------------------------------------------------

test("a multi-part stub: one importer slide per part, each with its index and the links rev", () => {
  const stub = stubContent(["./vaults/v/a.md", './vaults/v/a/b "c".md'], null, undefined, "v", "abc123");
  assert.equal(
    stub,
    '---\nsrc: "./vaults/v/a.md"\nmahfouzVault: "v"\nmahfouzPart: 0\nmahfouzLinksRev: "abc123"\n---\n' +
      '\n---\nsrc: "./vaults/v/a/b \\"c\\".md"\nmahfouzPart: 1\nmahfouzLinksRev: "abc123"\n---\n'
  );
  // Only the first importer (the headmatter) carries the template.
  const branded = stubContent(["./a.md", "./b.md"], BRAND, undefined, null, "r");
  assert.equal(branded.match(/mahfouz: /g).length, 1);
  assert.ok(branded.indexOf("mahfouz: ") < branded.indexOf('src: "./b.md"'));
  // A single source without a rev is today's stub, byte for byte.
  assert.equal(stubContent(["./a.md"]), stubContent("./a.md"));
  assert.doesNotMatch(stubContent([]), /src:/);
});

test("note paths with control characters are refused", () => {
  const vault = tempDir("ctl");
  for (const name of ["a\nb.md", "a\rb.md", "a\u0000b.md", "a\u007fb.md", "a\tb.md", "a\u0085b.md", "a\u2028b.md"]) {
    assert.throws(() => checkNote(vault, name, "presented"), /control character/, JSON.stringify(name));
  }
  assert.throws(() => checkNote(vault, 42, "presented"), /non-empty string/);
  fs.rmSync(vault, { recursive: true, force: true });
});

test("deck links keep only the app's shapes, and __proto__ stays a key", () => {
  const links = JSON.parse('{"a":{"path":"a.md","title":"A"},"b":null,"c":{"path":"c.md","title":null},"d":{"path":1},"e":"x","__proto__":{"path":"p.md","title":"P"}}');
  const clean = cleanDeckLinks(links);
  assert.deepEqual({ ...clean }, { a: { path: "a.md", title: "A" }, b: null, c: { path: "c.md", title: null }, ["__proto__"]: { path: "p.md", title: "P" } });
  assert.equal(Object.getPrototypeOf(clean), null);
  assert.deepEqual({ ...cleanDeckLinks(["x"]) }, {});
  assert.deepEqual({ ...cleanDeckLinks(null) }, {});
});

function deckFixture() {
  const ws = tempDir("deck-ws");
  const vault = tempDir("deck-vault");
  fs.mkdirSync(path.join(vault, "talk"), { recursive: true });
  for (const f of ["talk/talk.md", "talk/one.md", "talk/two.md", "talk/a#b.md"]) fs.writeFileSync(path.join(vault, f), "# x");
  return { ws, vault, done: () => [ws, vault].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

test("writeDeck writes the links file, then the stub, both naming the same parts and rev", () => {
  const { ws, vault, done } = deckFixture();
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    const links = { one: { path: "talk/one.md", title: "One" }, gone: null };
    const parts = ["talk/talk.md", "talk/one.md", "talk/missing.md", "talk/a#b.md", "talk/x\ny.md", "../out.md", "talk/two.md", "talk/one.md"];
    const { parts: used, rev } = writeDeck(ws, vault, "vid", { relPath: "talk/talk.md", parts, links });
    assert.deepEqual(used, ["talk/talk.md", "talk/one.md", "talk/two.md"]);
    assert.equal(warnings.length, 4, warnings.join("\n"));
    const file = JSON.parse(fs.readFileSync(path.join(ws, DECK_LINKS_FILE), "utf8"));
    assert.deepEqual(file, { rev, parts: used, links });
    assert.equal(rev, deckRev(used, cleanDeckLinks(links)));
    const stub = fs.readFileSync(path.join(ws, "deck.md"), "utf8");
    assert.deepEqual([...stub.matchAll(/src: "([^"]*)"/g)].map((m) => m[1]), used.map((p) => `./vaults/vid/${p}`));
    assert.deepEqual([...stub.matchAll(/mahfouzPart: (\d+)/g)].map((m) => Number(m[1])), [0, 1, 2]);
    assert.equal([...stub.matchAll(new RegExp(`mahfouzLinksRev: "${rev}"`, "g"))].length, 3);
    assert.deepEqual(fs.readdirSync(ws).sort(), [DECK_LINKS_FILE, "deck.md"]);
    // The transformer reads back what was written, for the stub's runs only.
    assert.deepEqual(deckLinksFor(path.join(ws, "deck.md"), rev), { parts: used, links });
    assert.deepEqual(deckLinksFor(path.join(ws, "export-1.md"), rev), {});
  } finally {
    console.warn = warn;
    done();
  }
});

test("writeDeck: a new deck changes the rev; an older app's start presents the note alone", () => {
  const { ws, vault, done } = deckFixture();
  try {
    const a = writeDeck(ws, vault, "v", { relPath: "talk/talk.md", parts: ["talk/talk.md", "talk/one.md"], links: {} });
    const b = writeDeck(ws, vault, "v", { relPath: "talk/talk.md", parts: ["talk/talk.md", "talk/two.md"], links: {} });
    const c = writeDeck(ws, vault, "v", { relPath: "talk/talk.md", parts: ["talk/talk.md", "talk/one.md"], links: { x: null } });
    assert.equal(new Set([a.rev, b.rev, c.rev]).size, 3);
    assert.deepEqual(deckLinksFor(path.join(ws, "deck.md"), c.rev).links, { x: null });
    const old = writeDeck(ws, vault, "v", { relPath: "talk/talk.md" });
    assert.deepEqual(old.parts, ["talk/talk.md"]);
    assert.match(fs.readFileSync(path.join(ws, "deck.md"), "utf8"), /mahfouzPart: 0/);
  } finally {
    done();
  }
});

test("writeDeck refuses a bad presented note and writes nothing", () => {
  const { ws, vault, done } = deckFixture();
  try {
    assert.throws(() => writeDeck(ws, vault, "v", { relPath: "talk/a#b.md", parts: [] }), /can't be presented/);
    assert.throws(() => writeDeck(ws, vault, "v", { relPath: "talk/\u0007.md", parts: [] }), /control character/);
    assert.deepEqual(fs.readdirSync(ws), []);
  } finally {
    done();
  }
});

test("writeDeck presents the note alone when the parts don't start with it", () => {
  const { ws, vault, done } = deckFixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(writeDeck(ws, vault, "v", { relPath: "talk/talk.md", parts: ["talk/one.md", "talk/two.md"] }).parts, ["talk/talk.md"]);
  } finally {
    console.warn = warn;
    done();
  }
});
