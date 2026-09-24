// Run with `npm test` (node --test) from the repo root.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { check, compareVersions, isContained, isVersionRange, validateManifest, versionBumpError } from "./check.mjs";

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

test("a changed plugin must raise its version", () => {
  assert.equal(versionBumpError("p", true, null, "1.0.0"), null, "new plugins are fine");
  assert.equal(versionBumpError("p", false, "1.0.0", "1.0.0"), null, "untouched plugins are fine");
  assert.equal(versionBumpError("p", true, "1.0.0", "1.0.1"), null);
  assert.match(versionBumpError("p", true, "1.0.0", "1.0.0"), /must go above 1\.0\.0/);
  assert.match(versionBumpError("p", true, "1.2.0", "1.1.9"), /must go above 1\.2\.0/);
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
  assert.match(errors[0], /^plugins\/a: changed since the base branch/);

  fs.writeFileSync(path.join(root, "plugins", "a", "plugin.json"), JSON.stringify(minimal("a", { version: "1.0.1" })));
  git(root, "commit", "-qam", "bump");
  assert.deepEqual(await check(root, { base: "main", log: quiet }), []);
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
