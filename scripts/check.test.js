// Run with `npm test` (node --test) from the repo root.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { check, compareVersions, FIELD_SINCE, FLOOR_BUMP, LENIENT_SINCE, requiredFloor, isContained, isHostPattern, isVersionRange, rangeFloor, RESERVED_EXPORT_FORMATS, RESERVED_LANGUAGES, validateManifest, versionBumpError } from "./check.mjs";

const quiet = () => {};

function tempRegistry(plugins, { name = "acme" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mahfouz-check-"));
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ schema: 1, name }));
  for (const [id, { manifest, files = {} }] of Object.entries(plugins)) {
    const dir = path.join(root, "plugins", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
  }
  return root;
}

const minimal = (id, over = {}) => ({
  schema: 1,
  id,
  version: "1.0.0",
  label: id,
  description: "",
  mahfouz: ">=0.3.0",
  apiVersion: 1,
  ...over,
});

function validate(manifest, files = {}, id = manifest.id ?? "p", pluginIds = [id]) {
  const root = tempRegistry({ [id]: { manifest, files } });
  try {
    return validateManifest(manifest, { dir: path.join(root, "plugins", id), id, registry: "acme", pluginIds });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("version ranges: what Rust's semver crate accepts, not npm's grammar", () => {
  for (const ok of [">=0.3.0", ">=0.3.0, <1.0.0", ">= 0.3.0", "*", "^1", "~1.2", "1.x", "0.3.*", "=1.2.3", "1.2.3-beta.1", ">=1.0.0,<2"]) {
    assert.equal(isVersionRange(ok), true, ok);
  }
  for (const bad of [">=0.3.0 <1.0.0", ">=0.3.0 || <0.1", "v1.2.3", "", "latest", 3]) {
    assert.equal(isVersionRange(bad), false, String(bad));
  }
});

test("versions compare as semver, prereleases first", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), null);
});

test("paths must be relative and stay inside the plugin", () => {
  assert.equal(isContained("bin/x"), true);
  assert.equal(isContained("./a"), true);
  for (const bad of ["", "/usr/bin", "../x", "a/../../b", "a\\..\\b"]) assert.equal(isContained(bad), false, bad);
});

test("a complete manifest passes", () => {
  const sha = "a".repeat(64);
  const errors = validate(
    minimal("full", {
      dependencies: ["acme/other", "elsewhere/thing"],
      install: [
        { type: "npm", dir: ".", progress: "npm-fetch" },
        { type: "download", extract: "zip", to: "bin", include: ["x/y"], artifacts: { "darwin-arm64": { url: "https://e.x/a.zip", sha256: sha }, any: { url: "https://e.x/b", sha256: sha } } },
      ],
      gitPath: ["bin"],
      frontend: "index.js",
      sidecar: { runtime: "node", entry: "sidecar.js" },
    }),
    { "index.js": "", "sidecar.js": "", "package.json": "{}", "package-lock.json": "{}" },
    "full",
    ["full", "other"]
  );
  assert.deepEqual(errors, []);
});

test("what the app would reject, or users would trip on, is reported", () => {
  const errors = validate(
    minimal("bad", {
      surprise: 1,
      version: "one",
      mahfouz: ">=0.3.0 <1.0.0",
      apiVersion: 2,
      dependencies: ["acme/missing", "noslash"],
      install: [
        { type: "npm" },
        { type: "download", to: "../out", extract: "rar", artifacts: { "darwin-arm65": { url: "http://e.x/a", sha256: "abc" } } },
        { type: "pip" },
      ],
      frontend: "missing.js",
      sidecar: { runtime: "python", entry: "x.py" },
    })
  );
  const expected = [
    'unknown field "surprise"',
    'version "one" isn\'t semver',
    'mahfouz ">=0.3.0 <1.0.0" isn\'t a version range',
    "apiVersion 2 isn't supported",
    'dependency "acme/missing" isn\'t in this registry',
    'dependency "noslash" must be <registry>/<id>',
    "package-lock.json is missing",
    'extract must be "none", "tar.gz" or "zip"',
    'artifacts["darwin-arm65"]: unknown platform',
    "url must be https://",
    "sha256 must be 64 hex characters",
    'type must be "npm" or "download"',
    "frontend missing.js doesn't exist",
    'sidecar.runtime must be "node" or "native"',
    'path "../out" must be relative and stay inside the plugin',
  ];
  for (const fragment of expected) {
    assert.ok(errors.some((e) => e.includes(fragment)), `expected an error containing: ${fragment}\n${errors.join("\n")}`);
  }
  // The manifest says "y", but it lives in plugins/x/.
  assert.ok(validate(minimal("x", { id: "y" }), {}, "x").some((e) => e.includes('must match its directory "x"')));
});

test("a range's floor is the lowest app version it can admit", () => {
  assert.equal(rangeFloor(">=0.9.0"), "0.9.0");
  assert.equal(rangeFloor(">= 0.9.1, <1.0.0"), "0.9.1");
  assert.equal(rangeFloor("^0.9"), "0.9.0");
  assert.equal(rangeFloor("0.10.x"), "0.10.0");
  assert.equal(rangeFloor(">=0.9.0-beta.1"), "0.9.0");
  assert.equal(rangeFloor("<1.0.0"), "0.0.0");
  assert.equal(rangeFloor("*"), "0.0.0");
});

test("node: maps platforms to a bundled node binary a download step provides", () => {
  const sha = "a".repeat(64);
  const download = (platforms) => ({
    type: "download",
    extract: "tar.gz",
    to: "runtime",
    artifacts: Object.fromEntries(platforms.map((p) => [p, { url: `https://e.x/${p}.tar.gz`, sha256: sha }])),
  });
  const files = { "package.json": "{}", "package-lock.json": "{}", "sidecar.js": "" };
  const withNode = (node, over = {}) =>
    minimal("n", {
      mahfouz: ">=0.9.0",
      install: [download(["darwin-arm64", "darwin-x64"]), { type: "npm" }],
      node,
      sidecar: { runtime: "node", entry: "sidecar.js" },
      ...over,
    });

  assert.deepEqual(validate(withNode({ "darwin-arm64": "runtime/a/bin/node", "darwin-x64": "runtime/b/bin/node" }), files), []);
  // An "any" artifact covers every platform.
  assert.deepEqual(validate(withNode({ "linux-x64": "runtime/bin/node" }, { install: [download(["any"])] }), files), []);

  const cases = [
    [withNode(["runtime/bin/node"]), "node must map platforms to paths"],
    [withNode({ "darwin-arm65": "runtime/bin/node" }), 'node["darwin-arm65"]: unknown platform'],
    [withNode({ "darwin-arm64": 3 }), 'node["darwin-arm64"]: must be a path'],
    [withNode({ "darwin-arm64": "../node" }), 'path "../node" must be relative and stay inside the plugin'],
    [withNode({ "darwin-arm64": "/usr/local/bin/node" }), 'path "/usr/local/bin/node" must be relative'],
    [withNode({ "linux-x64": "runtime/bin/node" }), 'node["linux-x64"]: no download step has an artifact for this platform'],
    [withNode({ "darwin-arm64": "runtime/bin/node" }, { mahfouz: ">=0.5.0" }), '"node" needs Mahfouz 0.9.0'],
    [withNode({ "darwin-arm64": "runtime/bin/node" }, { mahfouz: "<1.0.0" }), '"node" needs Mahfouz 0.9.0'],
  ];
  for (const [manifest, fragment] of cases) {
    const errors = validate(manifest, files);
    assert.ok(errors.some((e) => e.includes(fragment)), `expected an error containing: ${fragment}\n${errors.join("\n")}`);
  }
});

test("an artifact can override its step's extract, from Mahfouz 0.9.0", () => {
  const sha = "a".repeat(64);
  const step = (artifact) => ({
    type: "download",
    extract: "tar.gz",
    to: "runtime",
    artifacts: { "linux-x64": { url: "https://e.x/a.tar.gz", sha256: sha }, "windows-x64": { url: "https://e.x/a.zip", sha256: sha, ...artifact } },
  });
  const manifest = (artifact, mahfouz = ">=0.9.0") => minimal("e", { mahfouz, install: [step(artifact)] });

  for (const extract of ["none", "tar.gz", "zip"]) assert.deepEqual(validate(manifest({ extract })), [], extract);
  const cases = [
    [manifest({ extract: "rar" }), 'artifacts["windows-x64"]: extract must be "none", "tar.gz" or "zip"'],
    [manifest({ extract: "zip" }, ">=0.5.0"), 'artifacts["windows-x64"]: "extract" needs Mahfouz 0.9.0'],
  ];
  for (const [m, fragment] of cases) {
    const errors = validate(m);
    assert.ok(errors.some((e) => e.includes(fragment)), `expected an error containing: ${fragment}\n${errors.join("\n")}`);
  }
  // Without the override, older ranges stay fine.
  assert.deepEqual(validate(manifest({}, ">=0.5.0")), []);
});

test("a changed plugin must raise its version", () => {
  assert.equal(versionBumpError("p", true, null, "1.0.0"), null, "new plugins are fine");
  assert.equal(versionBumpError("p", false, "1.0.0", "1.0.0"), null, "untouched plugins are fine");
  assert.equal(versionBumpError("p", true, "1.0.0", "1.0.1"), null);
  assert.match(versionBumpError("p", true, "1.0.0", "1.0.0"), /must go above 1\.0\.0/);
  assert.match(versionBumpError("p", true, "1.2.0", "1.1.9"), /must go above 1\.2\.0/);
  assert.match(versionBumpError("p", true, "1.0.0", "1.0.0", "origin/main"), /^plugins\/p: changed since origin\/main/);
});

function git(root, ...args) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
}

test("--base finds changed plugins through git", async () => {
  const root = tempRegistry({ a: { manifest: minimal("a"), files: {} }, b: { manifest: minimal("b") } });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-q", "-b", "change");
  fs.writeFileSync(path.join(root, "plugins", "a", "index.js"), "changed");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "change a without a bump");

  const errors = await check(root, { base: "main", log: quiet });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^plugins\/a: changed since main/);

  fs.writeFileSync(path.join(root, "plugins", "a", "plugin.json"), JSON.stringify(minimal("a", { version: "1.0.1" })));
  git(root, "commit", "-qam", "bump");
  assert.deepEqual(await check(root, { base: "main", log: quiet }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("--base main: a stack of PRs bumps against the release, not each other", async () => {
  const root = tempRegistry({ a: { manifest: minimal("a") } });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "release");
  // First PR of a stack: a new plugin, and a bump of the released one.
  git(root, "checkout", "-q", "-b", "pr1");
  fs.mkdirSync(path.join(root, "plugins", "n"));
  fs.writeFileSync(path.join(root, "plugins", "n", "plugin.json"), JSON.stringify(minimal("n")));
  fs.writeFileSync(path.join(root, "plugins", "a", "plugin.json"), JSON.stringify(minimal("a", { version: "1.1.0" })));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "pr1");
  // Second PR, stacked on the first, changes both again with no bump.
  git(root, "checkout", "-q", "-b", "pr2");
  fs.writeFileSync(path.join(root, "plugins", "n", "index.js"), "more");
  fs.writeFileSync(path.join(root, "plugins", "a", "index.js"), "more");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "pr2");

  // Against the release line: n isn't on main yet, a is above main's 1.0.0.
  assert.deepEqual(await check(root, { base: "main", log: quiet }), []);
  // Against the stacked base, both would have to bump again.
  const stacked = await check(root, { base: "pr1", log: quiet });
  assert.deepEqual(stacked.map((e) => e.split(",")[0]), ["plugins/a: changed since pr1", "plugins/n: changed since pr1"]);

  // A plugin on main still needs its bump: put a back to main's version.
  fs.writeFileSync(path.join(root, "plugins", "a", "plugin.json"), JSON.stringify(minimal("a")));
  git(root, "commit", "-qam", "undo the bump");
  const errors = await check(root, { base: "main", log: quiet });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^plugins\/a: changed since main, so its version must go above 1\.0\.0/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("--artifacts downloads each artifact and compares its sha256", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mahfouz-artifact-"));
  const file = path.join(dir, "tool.bin");
  fs.writeFileSync(file, "binary");
  const sha = createHash("sha256").update("binary").digest("hex");
  const url = pathToFileURL(file).href;
  const step = (sha256) => ({ type: "download", to: "bin/tool", artifacts: { any: { url, sha256 } } });

  const good = tempRegistry({ t: { manifest: minimal("t", { install: [step(sha)] }) } });
  assert.deepEqual(await check(good, { artifacts: true, log: quiet }), []);

  const bad = tempRegistry({ t: { manifest: minimal("t", { install: [step("0".repeat(64))] }) } });
  const errors = await check(bad, { artifacts: true, log: quiet });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sha256 mismatch/);

  fs.rmSync(file);
  assert.match((await check(good, { artifacts: true, log: quiet }))[0], /couldn't be downloaded/);
  for (const d of [dir, good, bad]) fs.rmSync(d, { recursive: true, force: true });
});

test("the registry file itself is checked", async () => {
  const root = tempRegistry({}, { name: "Not A Slug" });
  assert.match((await check(root, { log: quiet }))[0], /registry\.json: name must be a slug/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("icon and logo: optional .svg files inside the plugin, under 32 KB, with an <svg> root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icons-"));
  fs.writeFileSync(path.join(dir, "icon.svg"), '<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>');
  fs.writeFileSync(path.join(dir, "bad.svg"), "<html></html>");
  fs.writeFileSync(path.join(dir, "big.svg"), `<svg>${"a".repeat(33 * 1024)}</svg>`);
  const base = { schema: 1, id: "p", version: "1.0.0", label: "P", description: "", mahfouz: ">=0.8.0", apiVersion: 1 };
  const ctx = { dir, id: "p", registry: "mahfouz", pluginIds: ["p"] };
  assert.deepEqual(validateManifest({ ...base, icon: "icon.svg" }, ctx), []);
  const errs = (m) => validateManifest({ ...base, ...m }, ctx).join("\n");
  assert.match(errs({ icon: "../icon.svg" }), /inside the plugin/);
  assert.match(errs({ logo: "logo.png" }), /must be an \.svg/);
  assert.match(errs({ logo: "missing.svg" }), /doesn't exist/);
  assert.match(errs({ icon: "bad.svg" }), /isn't an SVG/);
  assert.match(errs({ icon: "big.svg" }), /larger than 32 KB/);

  fs.symlinkSync(path.join(dir, "icon.svg"), path.join(dir, "icon-link.svg"));
  assert.match(errs({ icon: "icon-link.svg" }), /isn't a regular file/);
});

test("icon and logo: a leading XML declaration or comment before <svg> is allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icons-decl-"));
  fs.writeFileSync(path.join(dir, "decl.svg"), '<?xml version="1.0"?><svg viewBox="0 0 24 24"><path d="M1 1"/></svg>');
  fs.writeFileSync(path.join(dir, "comment.svg"), '<!-- c --><svg viewBox="0 0 24 24"><path d="M1 1"/></svg>');
  fs.writeFileSync(path.join(dir, "svgx.svg"), '<svgx viewBox="0 0 24 24"></svgx>');
  fs.writeFileSync(path.join(dir, "html.svg"), "<html></html>");
  const base = { schema: 1, id: "p", version: "1.0.0", label: "P", description: "", mahfouz: ">=0.8.0", apiVersion: 1 };
  const ctx = { dir, id: "p", registry: "mahfouz", pluginIds: ["p"] };
  const errs = (m) => validateManifest({ ...base, ...m }, ctx).join("\n");
  assert.deepEqual(validateManifest({ ...base, icon: "decl.svg" }, ctx), []);
  assert.deepEqual(validateManifest({ ...base, icon: "comment.svg" }, ctx), []);
  assert.match(errs({ icon: "svgx.svg" }), /isn't an SVG/);
  assert.match(errs({ icon: "html.svg" }), /isn't an SVG/);
});

test("icon and logo: a stray BOM between the prolog and <svg> is not whitespace (matches Rust, not JS \\s)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icons-bom-"));
  fs.writeFileSync(path.join(dir, "bom.svg"), '<?xml version="1.0"?>﻿<svg/>');
  const base = { schema: 1, id: "p", version: "1.0.0", label: "P", description: "", mahfouz: ">=0.8.0", apiVersion: 1 };
  const ctx = { dir, id: "p", registry: "mahfouz", pluginIds: ["p"] };
  assert.match(validateManifest({ ...base, icon: "bom.svg" }, ctx).join("\n"), /isn't an SVG/);
});

test("icon and logo: invalid UTF-8 is rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icons-utf8-"));
  fs.writeFileSync(path.join(dir, "bad-utf8.svg"), Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x3e, 0xff, 0x3c, 0x2f, 0x73, 0x76, 0x67, 0x3e]));
  const base = { schema: 1, id: "p", version: "1.0.0", label: "P", description: "", mahfouz: ">=0.8.0", apiVersion: 1 };
  const ctx = { dir, id: "p", registry: "mahfouz", pluginIds: ["p"] };
  const errs = (m) => validateManifest({ ...base, ...m }, ctx).join("\n");
  assert.match(errs({ icon: "bad-utf8.svg" }), /isn't UTF-8/);
});

test("icon/logo require a mahfouz range that excludes versions before 0.8.0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icons-since-"));
  fs.writeFileSync(path.join(dir, "icon.svg"), '<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>');
  const base = { schema: 1, id: "p", version: "1.0.0", label: "P", description: "", apiVersion: 1 };
  const ctx = { dir, id: "p", registry: "mahfouz", pluginIds: ["p"] };
  const errs = (mahfouz) => validateManifest({ ...base, mahfouz, icon: "icon.svg" }, ctx).join("\n");

  assert.equal(errs(">=0.8.0"), "");
  for (const bad of [">=0.5.0", "*", "^0.7.0"]) {
    assert.match(errs(bad), /"icon" needs Mahfouz 0\.8\.0/, bad);
  }
  // No icon/logo set: the guard doesn't apply, even on an old range.
  assert.deepEqual(validateManifest({ ...base, mahfouz: ">=0.4.0" }, ctx), []);
});

test("host patterns: what manifest.rs's is_host_pattern accepts", () => {
  for (const ok of ["api.notion.com", "file.notion.so", "*.notion.so", "a-b.c1.example", "prod-files-secure.s3.us-west-2.amazonaws.com"]) {
    assert.equal(isHostPattern(ok), true, ok);
  }
  for (const bad of ["*", "*.com", "com", "API.notion.com", "https://api.notion.com", "api.notion.com:443", "api.notion.com/v1",
    "127.0.0.1", "[::1]", "::1", "-a.example.com", "a-.example.com", "a..example.com", "*.*.example.com", "a.*.example.com", "", 42]) {
    assert.equal(isHostPattern(bad), false, String(bad));
  }
});

test("network and secrets: checked as manifest.rs does, from Mahfouz 0.12.0", () => {
  const base = minimal("p", { mahfouz: ">=0.12.0" });
  const errs = (over) => validate({ ...base, ...over }).join("\n");
  const ok = { network: { hosts: ["api.notion.com", "*.s3.amazonaws.com"] }, secrets: { token: { hosts: ["api.notion.com"] } } };
  assert.equal(errs(ok), "");
  assert.equal(errs({ network: { hosts: ["api.notion.com"] } }), "");

  assert.match(errs({ network: { hosts: [] } }), /network.hosts must not be empty/);
  assert.match(errs({ network: ["api.notion.com"] }), /network must be/);
  assert.match(errs({ network: { hosts: ["api.notion.com"], extra: 1 } }), /network: unknown field "extra"/);
  assert.match(errs({ network: { hosts: ["*.com"] } }), /network host "\*\.com"/);
  assert.match(errs({ network: { hosts: ["10.0.0.1"] } }), /network host "10\.0\.0\.1"/);
  assert.match(errs({ ...ok, secrets: { token: { hosts: ["file.notion.so"] } } }), /host "file\.notion\.so" must also be in network.hosts/);
  assert.match(errs({ ...ok, secrets: { token: { hosts: [] } } }), /must name at least one host/);
  assert.match(errs({ ...ok, secrets: { Token: { hosts: ["api.notion.com"] } } }), /name must be lowercase/);
  assert.match(errs({ ...ok, secrets: { token: { hosts: ["api.notion.com"], header: "x" } } }), /unknown field "header"/);
  assert.match(errs({ secrets: { token: { hosts: ["api.notion.com"] } } }), /must also be in network.hosts/);

  // Older apps reject the unknown fields: the range must start at 0.12.0.
  const old = (over) => validate({ ...minimal("p", { mahfouz: ">=0.11.0" }), ...over }).join("\n");
  assert.match(old({ network: ok.network }), /"network" needs Mahfouz 0\.12\.0/);
  assert.match(old(ok), /"secrets" needs Mahfouz 0\.12\.0/);
});

test("terms: a .md file inside the plugin, from Mahfouz 0.12.0", () => {
  const errs = (over, files = { "terms.md": "## Terms\n" }, mahfouz = ">=0.12.0") => validate({ ...minimal("p", { mahfouz }), ...over }, files).join("\n");
  assert.equal(errs({ terms: "terms.md" }), "");
  assert.match(errs({ terms: "terms.txt" }), /terms must be a \.md file/);
  assert.match(errs({ terms: 3 }), /terms must be a \.md file/);
  assert.match(errs({ terms: "missing.md" }), /terms missing\.md doesn't exist/);
  assert.match(errs({ terms: "../terms.md" }), /must be relative and stay inside the plugin/);
  // Older apps reject the unknown field: the range must start at 0.12.0.
  assert.match(errs({ terms: "terms.md" }, undefined, ">=0.11.0"), /"terms" needs Mahfouz 0\.12\.0/);
});

test("configFile: a .md file name under the vault's .config/, from Mahfouz 0.12.0", () => {
  const errs = (over, mahfouz = ">=0.12.0") => validate({ ...minimal("p", { mahfouz }), ...over }).join("\n");
  assert.equal(errs({ configFile: "encryption.md" }), "");
  assert.equal(errs({ configFile: "key-groups2.md" }), "");
  for (const bad of ["../settings.md", "sub/encryption.md", "Encryption.md", "encryption.txt", ".md", "", 3]) {
    assert.match(errs({ configFile: bad }), /configFile must be a file name/, String(bad));
  }
  // Older apps reject the unknown field: the range must start at 0.12.0.
  assert.match(errs({ configFile: "encryption.md" }, ">=0.11.0"), /"configFile" needs Mahfouz 0\.12\.0/);
});

test("contributes: checked as manifest.rs's Contributes::validate does, from Mahfouz 0.21.0", () => {
  const errs = (contributes, over = {}, mahfouz = ">=0.21.0") => validate({ ...minimal("p", { mahfouz }), ...over, contributes }).join("\n");
  const lfs = { gitPath: ["bin"] };
  // Every field, as the app's contributes.json fixture has it.
  assert.equal(
    errs(
      {
        languages: ["excalidraw", "drawio-2"],
        detect: { attributes: [{ key: "type", includes: "presentation" }, { key: "slides" }], attachments: { totalOverBytes: 1048576 } },
        exportFormats: [{ id: "pdf", label: "PDF", description: "The note's slides as a PDF" }],
        programs: ["git-lfs", "node_1.2"],
      },
      lfs
    ),
    ""
  );
  assert.equal(errs({}), "");
  assert.equal(errs(null), "");
  assert.equal(errs({ detect: null, languages: ["mermaid"] }), "");
  assert.equal(errs({ detect: { attachments: { largestOverBytes: Number.MAX_SAFE_INTEGER, totalOverBytes: null } } }), "");
  assert.equal(errs({ exportFormats: [{ id: "p", label: "L".repeat(64), description: "d".repeat(200) }] }), "");

  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  for (const [contributes, want, over] of [
    [[], /contributes must be an object/],
    [{ themes: ["dark"] }, /contributes: unknown field "themes"/],
    [{ languages: "mermaid" }, /languages must be an array/],
    [{ languages: null }, /languages must be an array/],
    [{ languages: ["Excalidraw"] }, /languages "Excalidraw" must be lowercase/],
    [{ languages: ["mermaid", "mermaid"] }, /languages lists "mermaid" twice/],
    [{ languages: many(17, (i) => `l${i}`) }, /languages lists more than 16/],
    [{ languages: ["day-tasks"] }, /languages "day-tasks" is the app's own/],
    [{ detect: {} }, /detect must name attributes or attachments/],
    [{ detect: { attributes: [] } }, /detect must name attributes or attachments/],
    [{ detect: { x: 1, attributes: [{ key: "t" }] } }, /detect: unknown field "x"/],
    [{ detect: { attributes: [{ key: "" }] } }, /attributes key "" must be 1 to 64/],
    [{ detect: { attributes: [{ key: "k".repeat(65) }] } }, /attributes key "k+" must be 1 to 64/],
    [{ detect: { attributes: [{ key: "t", includes: "" }] } }, /"t" includes must be 1 to 64/],
    [{ detect: { attributes: [{ key: "t" }, { key: "t", includes: null }] } }, /attributes lists "t" twice/],
    [{ detect: { attributes: [{ key: "t", x: 1 }] } }, /attributes: unknown field "x"/],
    [{ detect: { attributes: many(9, (i) => ({ key: `k${i}` })) } }, /attributes lists more than 8/],
    [{ detect: { attachments: {} } }, /must name totalOverBytes or largestOverBytes/],
    [{ detect: { attachments: { totalOverBytes: 0 } } }, /totalOverBytes 0 must be an integer from 1/],
    [{ detect: { attachments: { largestOverBytes: -1 } } }, /largestOverBytes -1 must be an integer/],
    [{ detect: { attachments: { totalOverBytes: 1.5 } } }, /totalOverBytes 1\.5 must be an integer/],
    [{ detect: { attachments: { totalOverBytes: 2 ** 53 } } }, /must be an integer from 1 to 9007199254740991/],
    [{ detect: { attachments: { totalOverBytes: "1" } } }, /must be an integer/],
    [{ exportFormats: [{ id: "PDF", label: "P", description: "d" }] }, /exportFormats id "PDF" must be lowercase/],
    [{ exportFormats: [{ id: "docx", label: "P", description: "d" }] }, /exportFormats id "docx" is the app's own/],
    [{ exportFormats: [{ id: "p", label: "", description: "d" }] }, /"p" label must be 1 to 64/],
    [{ exportFormats: [{ id: "p", label: "L".repeat(65), description: "d" }] }, /"p" label must be 1 to 64/],
    [{ exportFormats: [{ id: "p", label: "P", description: "d".repeat(201) }] }, /"p" description must be 1 to 200/],
    [{ exportFormats: [{ id: "p", label: "P" }] }, /"p" description must be 1 to 200/],
    [{ exportFormats: [{ id: "p", label: "P", description: "d", icon: "x" }] }, /exportFormats: unknown field "icon"/],
    [{ exportFormats: many(2, () => ({ id: "p", label: "P", description: "d" })) }, /exportFormats lists "p" twice/],
    [{ exportFormats: many(9, (i) => ({ id: `f${i}`, label: "P", description: "d" })) }, /exportFormats lists more than 8/],
    [{ programs: ["Git LFS"] }, /programs "Git LFS" must be lowercase/, lfs],
    [{ programs: ["-x"] }, /programs "-x" must be lowercase/, lfs],
    [{ programs: many(9, (i) => `p${i}`) }, /programs lists more than 8/, lfs],
    [{ programs: ["git-lfs"] }, /programs needs a gitPath/],
    [{ programs: ["git-lfs"] }, /programs needs a gitPath/, { gitPath: [] }],
  ]) {
    assert.match(errs(contributes, over), want, JSON.stringify(contributes));
  }
  // Older apps reject the unknown field: the range must start at 0.21.0.
  assert.match(errs({ languages: ["mermaid"] }, {}, ">=0.20.0"), /"contributes" needs Mahfouz 0\.21\.0/);
});

test("contributes: the reserved names are the app's", () => {
  // Kept in step with the app's fixtures/plugin-manifests/reserved-contributes.json.
  assert.deepEqual(RESERVED_LANGUAGES, ["database", "database-view", "day-tasks"]);
  assert.deepEqual(RESERVED_EXPORT_FORMATS, ["docx", "markdown"]);
});

test("floor bumps: a field that grants or changes behaviour needs its own release as the floor; a declarative one only the lenient release", () => {
  // Everything up to the lenient release keeps its own floor: earlier apps reject any unknown key.
  for (const [field, since] of Object.entries(FIELD_SINCE)) {
    if (compareVersions(since, LENIENT_SINCE) <= 0) assert.equal(requiredFloor(field, since), since, field);
  }
  assert.equal(requiredFloor("contributes", FIELD_SINCE.contributes), "0.21.0");
  assert.equal(FLOOR_BUMP.has("contributes"), false);
  for (const field of ["network", "secrets", "roles", "extract", "node", "configFile", "terms"]) assert.ok(FLOOR_BUMP.has(field), field);
  assert.equal(FIELD_SINCE.roles, "0.21.0");
  // A later field: declarative ones are ignored from the lenient release on, a floor-bump one isn't safe to ignore.
  assert.equal(requiredFloor("someDeclarativeField", "0.24.0"), LENIENT_SINCE);
  assert.equal(requiredFloor("roles", "0.24.0"), "0.24.0");
  assert.equal(requiredFloor("extract", "0.9.0"), "0.9.0");
  // Through validateManifest: a floor-bump field still names its own release.
  const errs = (over, mahfouz) => validate({ ...minimal("p", { mahfouz }), ...over }).join("\n");
  assert.match(errs({ network: { hosts: ["api.example.com"] } }, ">=0.11.0"), /"network" needs Mahfouz 0\.12\.0.*would ignore or refuse it/);
  assert.match(errs({ contributes: { languages: ["x"] } }, ">=0.20.0"), /"contributes" needs Mahfouz 0\.21\.0.*older apps reject the manifest/);
});
