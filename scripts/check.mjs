#!/usr/bin/env node
// Checks the registry before anything reaches `main` — which is what every
// Mahfouz install pulls at launch, so `main` is the release.
//
//   node scripts/check.mjs                  manifests and files
//   node scripts/check.mjs --base <ref>     …plus: every plugin changed since
//                                           <ref> raised its version
//   node scripts/check.mjs --artifacts      …plus: every download artifact
//                                           exists and matches its sha256
//                                           (with --base: only the plugins
//                                           whose plugin.json changed)
//
// The manifest rules mirror the app's parser (src-tauri/src/plugins/
// manifest.rs in mahfouz-app/app): a manifest the app rejects shows up as a
// broken plugin for everyone, so it must fail here first.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = 1;
export const API_VERSION = 1;
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"];
const ANY_PLATFORM = "any";

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// One comparator as Rust's `semver` crate reads it: an optional operator
// (a space after it is fine), then a version that may use x / * wildcards.
const COMPARATOR = /^(?:\*|x|X|(?:(?:[<>]=?|=|\^|~)\s*)?\d+(?:\.(?:\d+|x|X|\*)){0,2}(?:-[0-9A-Za-z.-]+)?)$/;
const SHA256 = /^[0-9a-f]{64}$/i;

// ---- helpers --------------------------------------------------------------------

/** -1 / 0 / 1; a prerelease sorts before its release. Null if not semver. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

/** A range the app's `semver::VersionReq` accepts: comparators joined by
 * commas. Unlike npm, a space-separated list, `||` and a `v` prefix are all
 * errors there (checked against the crate: `">=0.3.0 <1.0.0"` fails,
 * `">=0.3.0, <1.0.0"` parses). */
export function isVersionRange(range) {
  if (typeof range !== "string" || !range.trim()) return false;
  return range.split(",").every((c) => COMPARATOR.test(c.trim()));
}

/** Relative, non-empty, and can't climb out of the directory it's joined to. */
export function isContained(rel) {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).every((part) => part !== "..");
}

function onlyKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown field "${key}"`);
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- manifests --------------------------------------------------------------------

/**
 * Everything wrong with one plugin's manifest. `dir` is the plugin's
 * directory (for files the manifest names); `registry` is this registry's
 * name and `pluginIds` the plugins it contains (for dependencies).
 */
export function validateManifest(m, { dir, id, registry, pluginIds }) {
  const errors = [];
  const where = `plugins/${id}/plugin.json`;
  if (!isObject(m)) return [`${where}: not a JSON object`];

  onlyKeys(
    m,
    ["schema", "id", "version", "label", "description", "mahfouz", "apiVersion", "dependencies", "install", "gitPath", "frontend", "sidecar"],
    where,
    errors
  );
  for (const key of ["schema", "id", "version", "label", "description", "mahfouz", "apiVersion"]) {
    if (!(key in m)) errors.push(`${where}: missing "${key}"`);
  }
  if ("schema" in m && m.schema !== SCHEMA) errors.push(`${where}: schema must be ${SCHEMA}`);
  if ("id" in m && m.id !== id) errors.push(`${where}: id "${m.id}" must match its directory "${id}"`);
  if (!SLUG.test(id)) errors.push(`${where}: "${id}" isn't a valid id (lowercase letters, digits, dashes; max 32)`);
  if ("version" in m && (typeof m.version !== "string" || !SEMVER.test(m.version))) {
    errors.push(`${where}: version "${m.version}" isn't semver (x.y.z)`);
  }
  for (const key of ["label", "description"]) {
    if (key in m && typeof m[key] !== "string") errors.push(`${where}: ${key} must be a string`);
  }
  if ("label" in m && typeof m.label === "string" && !m.label.trim()) errors.push(`${where}: label is empty`);
  if ("mahfouz" in m && !isVersionRange(m.mahfouz)) errors.push(`${where}: mahfouz "${m.mahfouz}" isn't a version range`);
  if ("apiVersion" in m && m.apiVersion !== API_VERSION) {
    errors.push(`${where}: apiVersion ${m.apiVersion} isn't supported (the app supports ${API_VERSION})`);
  }

  const paths = [];

  if ("dependencies" in m) {
    if (!Array.isArray(m.dependencies)) errors.push(`${where}: dependencies must be an array`);
    else
      for (const dep of m.dependencies) {
        const [reg, depId, ...rest] = String(dep).split("/");
        if (rest.length || !SLUG.test(reg ?? "") || !SLUG.test(depId ?? "")) {
          errors.push(`${where}: dependency "${dep}" must be <registry>/<id>`);
        } else if (reg === registry && !pluginIds.includes(depId)) {
          errors.push(`${where}: dependency "${dep}" isn't in this registry`);
        } else if (reg === registry && depId === id) {
          errors.push(`${where}: a plugin can't depend on itself`);
        }
      }
  }

  if ("install" in m) {
    if (!Array.isArray(m.install)) errors.push(`${where}: install must be an array`);
    else
      m.install.forEach((step, i) => {
        const at = `${where}: install[${i}]`;
        if (!isObject(step)) return errors.push(`${at}: must be an object`);
        if (step.type === "npm") {
          onlyKeys(step, ["type", "dir", "progress"], at, errors);
          const rel = step.dir ?? ".";
          paths.push(rel);
          if ("progress" in step && step.progress !== "npm-fetch") errors.push(`${at}: progress must be "npm-fetch"`);
          if (isContained(rel)) {
            for (const f of ["package.json", "package-lock.json"]) {
              if (!fs.existsSync(path.join(dir, rel, f))) errors.push(`${at}: ${path.join(rel, f)} is missing`);
            }
          }
        } else if (step.type === "download") {
          onlyKeys(step, ["type", "artifacts", "extract", "to", "include"], at, errors);
          if (!("to" in step)) errors.push(`${at}: missing "to"`);
          else paths.push(step.to);
          if ("extract" in step && !["none", "tar.gz", "zip"].includes(step.extract)) {
            errors.push(`${at}: extract must be "none", "tar.gz" or "zip"`);
          }
          if ("include" in step) {
            if (!Array.isArray(step.include)) errors.push(`${at}: include must be an array`);
            else paths.push(...step.include);
          }
          if (!isObject(step.artifacts) || !Object.keys(step.artifacts).length) {
            errors.push(`${at}: artifacts must map platforms to { url, sha256 }`);
          } else
            for (const [platform, artifact] of Object.entries(step.artifacts)) {
              const aat = `${at}.artifacts["${platform}"]`;
              if (platform !== ANY_PLATFORM && !PLATFORMS.includes(platform)) {
                errors.push(`${aat}: unknown platform (use ${[...PLATFORMS, ANY_PLATFORM].join(", ")})`);
              }
              if (!isObject(artifact)) {
                errors.push(`${aat}: must be { url, sha256 }`);
                continue;
              }
              onlyKeys(artifact, ["url", "sha256"], aat, errors);
              if (typeof artifact.url !== "string" || !/^(https:\/\/|file:\/\/)/.test(artifact.url)) {
                errors.push(`${aat}: url must be https://`);
              }
              if (!SHA256.test(artifact.sha256 ?? "")) errors.push(`${aat}: sha256 must be 64 hex characters`);
            }
        } else {
          errors.push(`${at}: type must be "npm" or "download"`);
        }
      });
  }

  if ("gitPath" in m) {
    if (!Array.isArray(m.gitPath)) errors.push(`${where}: gitPath must be an array`);
    else paths.push(...m.gitPath);
  }

  if ("frontend" in m) {
    paths.push(m.frontend);
    if (isContained(m.frontend) && !fs.existsSync(path.join(dir, m.frontend))) {
      errors.push(`${where}: frontend ${m.frontend} doesn't exist`);
    }
  }

  if ("sidecar" in m) {
    const s = m.sidecar;
    if (!isObject(s)) errors.push(`${where}: sidecar must be an object`);
    else if (s.runtime === "node") {
      onlyKeys(s, ["runtime", "entry"], `${where}: sidecar`, errors);
      paths.push(s.entry);
      if (isContained(s.entry) && !fs.existsSync(path.join(dir, s.entry))) {
        errors.push(`${where}: sidecar entry ${s.entry} doesn't exist`);
      }
    } else if (s.runtime === "native") {
      onlyKeys(s, ["runtime", "entry"], `${where}: sidecar`, errors);
      if (!isObject(s.entry)) errors.push(`${where}: a native sidecar's entry maps platforms to paths`);
      else paths.push(...Object.values(s.entry));
    } else {
      errors.push(`${where}: sidecar.runtime must be "node" or "native"`);
    }
  }

  for (const p of paths) {
    if (!isContained(p)) errors.push(`${where}: path ${JSON.stringify(p)} must be relative and stay inside the plugin`);
  }
  return errors;
}

/** The registry's own file. */
export function validateRegistry(info) {
  const errors = [];
  if (!isObject(info)) return ["registry.json: not a JSON object"];
  onlyKeys(info, ["schema", "name", "description"], "registry.json", errors);
  if (info.schema !== SCHEMA) errors.push(`registry.json: schema must be ${SCHEMA}`);
  if (!SLUG.test(info.name ?? "")) errors.push("registry.json: name must be a slug");
  return errors;
}

// ---- versions ---------------------------------------------------------------------

/** The error for a plugin that changed since `base` without raising its
 * version, or null. `baseVersion` is null for a plugin new since `base`. */
export function versionBumpError(id, changed, baseVersion, version) {
  if (!changed || baseVersion === null) return null;
  const cmp = compareVersions(version, baseVersion);
  if (cmp === null) return null; // reported by the manifest check
  if (cmp <= 0) {
    return `plugins/${id}: changed since the base branch, so its version must go above ${baseVersion} (it's ${version}) — users only get an update when the version changes`;
  }
  return null;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function changedPaths(root, base) {
  return git(root, ["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
}

function baseManifest(root, base, id) {
  try {
    return JSON.parse(git(root, ["show", `${base}:plugins/${id}/plugin.json`]));
  } catch {
    return null;
  }
}

// ---- artifacts --------------------------------------------------------------------

async function sha256Of(url) {
  if (url.startsWith("file://")) {
    return createHash("sha256").update(fs.readFileSync(fileURLToPath(url))).digest("hex");
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hash = createHash("sha256");
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest("hex");
}

/** Downloads every artifact once and compares its sha256. */
export async function checkArtifacts(manifests, log = console.log) {
  const errors = [];
  const seen = new Map();
  for (const [id, m] of manifests) {
    for (const [i, step] of (m.install ?? []).entries()) {
      if (step?.type !== "download" || !isObject(step.artifacts)) continue;
      for (const [platform, a] of Object.entries(step.artifacts)) {
        if (!a?.url) continue;
        const where = `plugins/${id}/plugin.json: install[${i}].artifacts["${platform}"]`;
        if (!seen.has(a.url)) {
          log(`  downloading ${a.url}`);
          seen.set(a.url, await sha256Of(a.url).catch((err) => err));
        }
        const got = seen.get(a.url);
        if (got instanceof Error) errors.push(`${where}: ${a.url} couldn't be downloaded: ${got.message}`);
        else if (got !== String(a.sha256).toLowerCase()) {
          errors.push(`${where}: sha256 mismatch for ${a.url} — the manifest says ${a.sha256}, the file is ${got}`);
        }
      }
    }
  }
  return errors;
}

// ---- main -------------------------------------------------------------------------

export async function check(root, { base = null, artifacts = false, log = console.log } = {}) {
  const errors = [];
  const readJson = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    } catch (err) {
      errors.push(`${rel}: ${err.code === "ENOENT" ? "missing" : `invalid JSON (${err.message})`}`);
      return null;
    }
  };

  const info = readJson("registry.json");
  if (info) errors.push(...validateRegistry(info));
  const registry = info?.name ?? "";

  const pluginsDir = path.join(root, "plugins");
  const ids = fs.existsSync(pluginsDir)
    ? fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  const manifests = new Map();
  for (const id of ids) {
    const m = readJson(`plugins/${id}/plugin.json`);
    if (!m) continue;
    manifests.set(id, m);
    errors.push(...validateManifest(m, { dir: path.join(pluginsDir, id), id, registry, pluginIds: ids }));
  }
  log(`checked registry "${registry}": ${manifests.size} plugin(s)`);

  let changed = null;
  if (base) {
    changed = changedPaths(root, base);
    for (const [id, m] of manifests) {
      const touched = changed.some((p) => p.startsWith(`plugins/${id}/`));
      const before = touched ? baseManifest(root, base, id) : null;
      const error = versionBumpError(id, touched, before?.version ?? null, m.version);
      if (error) errors.push(error);
    }
    log(`checked version bumps against ${base}`);
  }

  if (artifacts) {
    const toCheck = changed
      ? new Map([...manifests].filter(([id]) => changed.includes(`plugins/${id}/plugin.json`)))
      : manifests;
    log(`checking artifacts of ${toCheck.size} plugin(s)`);
    errors.push(...(await checkArtifacts(toCheck, log)));
  }
  return errors;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf("--base");
  const base = baseAt >= 0 ? args[baseAt + 1] : null;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = await check(root, { base, artifacts: args.includes("--artifacts") });
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log("all good");
}
