// Run with `npm test` (node --test) from the repo root. The sidecar's pure
// parts (ported from the app's former slidev.rs tests); the server and
// export need a real install, see the README's smoke test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  deckUrl,
  entryModuleSrc,
  ensureLink,
  exportEntryContent,
  slidevExportFormat,
  linkVault,
  methods,
  nodeVersionOk,
  safeJoin,
  stubContent,
  templateCss,
  templateHeadmatter,
  vaultLinkId,
} from "./sidecar.js";

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
