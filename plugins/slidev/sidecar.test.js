// Run with `npm test` (node --test) from the repo root. The sidecar's pure
// parts (ported from the app's former slidev.rs tests); the server and
// export need a real install, see the README's smoke test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { layerHtml } from "./header-footer.js";
import {
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
} from "./sidecar.js";
import * as sidecar from "./sidecar.js";

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

test("vault and files links are created, kept, and repointed", () => {
  const base = tempDir("links");
  const ws = path.join(base, "ws");
  const v1 = path.join(base, "v1");
  const v2 = path.join(base, "v2");
  for (const d of [ws, path.join(v1, "files"), path.join(v2, "files")]) fs.mkdirSync(d, { recursive: true });

  const id = linkVault(ws, v1);
  assert.equal(fs.readlinkSync(path.join(ws, "vaults", id)), v1);
  assert.equal(fs.readlinkSync(path.join(ws, "public", "files")), path.join(v1, "files"));
  assert.equal(linkVault(ws, v1), id);
  linkVault(ws, v2);
  assert.equal(fs.readlinkSync(path.join(ws, "public", "files")), path.join(v2, "files"));

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
    assert.throws(() => sidecar.pngSlides(dir), undefined, name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A fresh sidecar module whose workspace is a temp dir (with a stand-in
 * Slidev CLI, so it counts as installed), and a vault. The module is
 * imported again per call, so the preview queue and vault links start empty.
 */
let instances = 0;
async function previewSidecar() {
  const ws = tempDir("preview-ws");
  const cli = sidecar.cliEntry(ws);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "");
  const vault = tempDir("preview-vault");
  fs.mkdirSync(path.join(vault, "files"));
  const saved = process.env.MAHFOUZ_PLUGIN_DIR;
  process.env.MAHFOUZ_PLUGIN_DIR = ws;
  try {
    const mod = await import(`./sidecar.js?preview=${++instances}`);
    return { mod, ws, vault };
  } finally {
    if (saved === undefined) delete process.env.MAHFOUZ_PLUGIN_DIR;
    else process.env.MAHFOUZ_PLUGIN_DIR = saved;
  }
}

/** `--output <dir>` from the export runner's arguments. */
function outputDir(args) {
  const i = args.indexOf("--output");
  assert.ok(i >= 0 && typeof args[i + 1] === "string", `--output in ${args.join(" ")}`);
  return args[i + 1];
}

/** An export runner stand-in that writes `files` (name → bytes) where slidev would. */
function writesPngs(calls, files) {
  return async (entry, args, log) => {
    calls.push({ entry, args, log });
    const dir = outputDir(args);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  };
}

test("preview renders the markdown with the template through a PNG export and returns the slides in order", async () => {
  const { mod, ws, vault } = await previewSidecar();
  const calls = [];
  const markdown = "# One\n\n---\n\n# Two\n";
  const template = { ...V2, header: undefined, footer: undefined };
  mod.hooks.runSlidevExport = async (entry, args, log) => {
    // While it runs: the entry and the sample deck are written, and the
    // vault is linked for `/files/` images.
    assert.equal(entry, path.join(ws, "preview.md"));
    assert.equal(fs.readFileSync(entry, "utf8"), mod.previewEntryContent(template));
    assert.equal(fs.readFileSync(path.join(ws, "preview-src.md"), "utf8"), markdown);
    assert.equal(fs.readlinkSync(path.join(ws, "vaults", vaultLinkId(vault))), vault);
    assert.equal(fs.readlinkSync(path.join(ws, "public", "files")), path.join(vault, "files"));
    return writesPngs(calls, { "2.png": pngBytes(2), "1.png": pngBytes(1) })(entry, args, log);
  };
  const result = await mod.methods.preview({ vaultPath: vault, markdown, template });
  assert.deepEqual(result, { slides: [{ png: pngBytes(1).toString("base64") }, { png: pngBytes(2).toString("base64") }] });
  assert.equal(calls.length, 1);
  const { args } = calls[0];
  assert.equal(args[args.indexOf("--format") + 1], "png");
  const out = outputDir(args);
  assert.ok(path.isAbsolute(out));
  for (const root of [ws, vault]) assert.ok(!path.resolve(out).startsWith(path.resolve(root) + path.sep), `${out} is inside ${root}`);
  assert.equal(fs.existsSync(out), false, "the output dir is removed after a render");
  // Present's and Export's entries are never touched.
  for (const name of ["deck.md", "export.md", "export-src.md"]) assert.equal(fs.existsSync(path.join(ws, name)), false, name);
});

test("preview refuses bad params before writing or rendering anything", async () => {
  const { mod, ws, vault } = await previewSidecar();
  const calls = [];
  mod.hooks.runSlidevExport = writesPngs(calls, { "1.png": pngBytes(1) });
  const bad = [
    [{ vaultPath: vault, markdown: 42 }, /markdown/],
    [{ vaultPath: vault }, /markdown/],
    [{ vaultPath: vault, markdown: "x".repeat(64 * 1024 + 1) }, /markdown/],
    [{ vaultPath: "relative/vault", markdown: "# a" }, /vaultPath|absolute/],
    [{ vaultPath: 7, markdown: "# a" }, /vaultPath|absolute/],
    [{ markdown: "# a" }, /vaultPath|absolute/],
  ];
  for (const [params, message] of bad) {
    await assert.rejects(mod.methods.preview({ template: null, ...params }), message, JSON.stringify(params).slice(0, 80));
  }
  assert.equal(calls.length, 0);
  for (const name of ["preview.md", "preview-src.md", "vaults"]) assert.equal(fs.existsSync(path.join(ws, name)), false, name);
  // 64 KB itself is fine.
  const ok = await mod.methods.preview({ vaultPath: vault, markdown: "x".repeat(64 * 1024), template: null });
  assert.equal(ok.slides.length, 1);
});

test("a failed render removes the output dir and reports the runner's error", async () => {
  const { mod, vault } = await previewSidecar();
  const calls = [];
  mod.hooks.runSlidevExport = async (entry, args, log) => {
    await writesPngs(calls, { "1.png": pngBytes(1) })(entry, args, log);
    throw new Error("slidev export failed (1):\nchromium crashed");
  };
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /chromium crashed/);
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(outputDir(calls[0].args)), false);
});

test("PNGs slidev didn't name by slide number fail the render and are removed with the output dir", async () => {
  const { mod, vault } = await previewSidecar();
  const calls = [];
  mod.hooks.runSlidevExport = writesPngs(calls, { "1.png": pngBytes(1), "1-1.png": pngBytes(2) });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }));
  assert.equal(fs.existsSync(outputDir(calls[0].args)), false);
});

test("a render over 30 MB of PNGs in all is refused, and its output dir removed", async () => {
  const { mod, vault } = await previewSidecar();
  const calls = [];
  const tenMb = Buffer.alloc(10 * 1024 * 1024 + 1);
  mod.hooks.runSlidevExport = writesPngs(calls, { "1.png": tenMb, "2.png": tenMb, "3.png": tenMb });
  await assert.rejects(mod.methods.preview({ vaultPath: vault, markdown: "# a", template: null }), /30 MB/);
  assert.equal(fs.existsSync(outputDir(calls[0].args)), false);
});

test("previews run one at a time, and a failed one doesn't block the next", async () => {
  const { mod, vault } = await previewSidecar();
  let active = 0;
  let most = 0;
  const releases = [];
  const order = [];
  mod.hooks.runSlidevExport = async (entry, args) => {
    const n = order.length + 1;
    order.push(`start ${n}`);
    active += 1;
    most = Math.max(most, active);
    await new Promise((resolve) => releases.push(resolve));
    const dir = outputDir(args);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "1.png"), pngBytes(n));
    active -= 1;
    order.push(`end ${n}`);
    if (n === 1) throw new Error("first fails");
  };
  const params = { vaultPath: vault, markdown: "# a", template: null };
  const first = mod.methods.preview(params);
  const second = mod.methods.preview(params);
  const firstSettled = assert.rejects(first, /first fails/);
  for (let i = 0; i < 20 && releases.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  // Give a second render every chance to start alongside the first.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(order, ["start 1"]);
  releases[0]();
  await firstSettled;
  for (let i = 0; i < 20 && releases.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(releases.length, 2, "the second render starts once the first is done");
  releases[1]();
  assert.deepEqual(await second, { slides: [{ png: pngBytes(2).toString("base64") }] });
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]);
  assert.equal(most, 1);
});
