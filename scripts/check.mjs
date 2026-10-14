#!/usr/bin/env node
// Checks the registry before anything reaches `main` — which is what every
// Mahfouz install pulls at launch, so `main` is the release.
//
//   node scripts/check.mjs                  manifests and files
//   node scripts/check.mjs --base <ref>     …plus: every plugin changed since
//                                           <ref> raised its version above
//                                           <ref>'s. Pass the release line
//                                           (origin/main), never a stacked
//                                           PR's base: a plugin that isn't on
//                                           main yet needs no bump, one that
//                                           is must go above main's version
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
// Rust's `char::is_whitespace` (Unicode White_Space) as a regex class. JS's
// `\s` isn't the same set — notably it also matches U+FEFF (BOM/ZWNBSP),
// which Rust does not treat as whitespace, so a stray BOM inside an SVG
// prolog would be silently skipped by `\s*` here but not by the app's own
// parser. Built from the same code points Rust's std lists for White_Space.
const RUST_WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

// Top-level fields newer than the app's first plugin release, and the first
// app version that understands each. An older app rejects an unknown field, so
// the plugin's `mahfouz` range must start at that version or later.
export const FIELD_SINCE = {
  node: "0.9.0",
  icon: "0.8.0",
  logo: "0.8.0",
  network: "0.12.0",
  secrets: "0.12.0",
  // The app's plugin host APIs (`config.read/write`, limited to the
  // plugin's own `.config/<configFile>`) arrive in 0.12.0 with it; an app
  // that doesn't parse it rejects the field like any unknown one.
  configFile: "0.12.0",
  // A Markdown file in the plugin the user accepts before installing or
  // enabling it (the app's install and enable dialogs show it).
  terms: "0.13.0",
};
// A file directly under the vault's `.config/`: a lowercase name ending in
// `.md`, no directory part, so a plugin can only name its own file there.
const CONFIG_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
// The same for fields of a download step's artifact.
export const ARTIFACT_FIELD_SINCE = { extract: "0.9.0" };
const EXTRACTS = ["none", "tar.gz", "zip"];

// ---- helpers --------------------------------------------------------------------

/** A lowercase DNS name of at least two labels whose last label isn't all
 * digits (no IPv4 literal; IPv6 fails the charset): `is_dns_name` in
 * manifest.rs. */
function isDnsName(s) {
  const labels = s.split(".");
  return (
    s.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => l.length >= 1 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-")) &&
    !/^\d+$/.test(labels[labels.length - 1])
  );
}

/** A host a manifest's `network`/`secrets` may name: an exact DNS name, or
 * `*.` followed by one (any subdomain, on a dot boundary). No scheme, port,
 * path, uppercase, IP literal, bare `*` or `*.<tld>`: `is_host_pattern` in
 * manifest.rs. */
export function isHostPattern(s) {
  return typeof s === "string" && isDnsName(s.startsWith("*.") ? s.slice(2) : s);
}

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

/** The lowest app version (x.y.z, prerelease ignored) a range can admit:
 * the highest lower bound among its comparators, or 0.0.0 without one. A
 * bare version means `^` in Rust's `semver`, so it's a lower bound too. */
export function rangeFloor(range) {
  let floor = [0, 0, 0];
  for (const c of String(range).split(",")) {
    const m = /^\s*(>=|>|=|\^|~)?\s*(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/.exec(c);
    if (!m) continue; // "*", "<…", "<=…": no lower bound
    const v = [m[2], m[3], m[4]].map((n) => (n && /^\d+$/.test(n) ? Number(n) : 0));
    const i = v.findIndex((n, k) => n !== floor[k]);
    if (i >= 0 && v[i] > floor[i]) floor = v;
  }
  return floor.join(".");
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
  // [where it's used, field, first app version that understands it]
  const newer = Object.entries(FIELD_SINCE)
    .filter(([field]) => field in m)
    .map(([field, since]) => [where, field, since]);

  onlyKeys(
    m,
    ["schema", "id", "version", "label", "description", "mahfouz", "apiVersion", "dependencies", "install", "gitPath", "frontend", "sidecar", "node", "icon", "logo", "network", "secrets", "configFile", "terms"],
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
          if ("extract" in step && !EXTRACTS.includes(step.extract)) {
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
              onlyKeys(artifact, ["url", "sha256", "extract"], aat, errors);
              if ("extract" in artifact && !EXTRACTS.includes(artifact.extract)) {
                errors.push(`${aat}: extract must be "none", "tar.gz" or "zip"`);
              }
              for (const [field, since] of Object.entries(ARTIFACT_FIELD_SINCE)) {
                if (field in artifact) newer.push([aat, field, since]);
              }
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

  if ("terms" in m) {
    if (typeof m.terms !== "string" || !m.terms.endsWith(".md")) errors.push(`${where}: terms must be a .md file`);
    else {
      paths.push(m.terms);
      if (isContained(m.terms) && !fs.existsSync(path.join(dir, m.terms))) errors.push(`${where}: terms ${m.terms} doesn't exist`);
    }
  }

  for (const field of ["icon", "logo"]) {
    if (!(field in m)) continue;
    const rel = m[field];
    if (typeof rel !== "string" || !rel.endsWith(".svg")) {
      errors.push(`${where}: ${field} must be an .svg file`);
      continue;
    }
    paths.push(rel);
    if (!isContained(rel)) continue;
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) {
      errors.push(`${where}: ${field} ${rel} doesn't exist`);
      continue;
    }
    if (!fs.lstatSync(file).isFile()) {
      errors.push(`${where}: ${field} ${rel} isn't a regular file`);
      continue;
    }
    const buf = fs.readFileSync(file);
    if (buf.length > 32 * 1024) errors.push(`${where}: ${field} ${rel} is larger than 32 KB`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      errors.push(`${where}: ${field} ${rel} isn't UTF-8`);
      continue;
    }
    const body = text
      .replace(/^﻿/, "")
      .replace(new RegExp(`^([${RUST_WS}]*(<\\?[\\s\\S]*?\\?>|<!--[\\s\\S]*?-->))*[${RUST_WS}]*`), "");
    if (!new RegExp(`^<svg[${RUST_WS}>/]`).test(body)) errors.push(`${where}: ${field} ${rel} isn't an SVG`);
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

  if ("node" in m) {
    if (!isObject(m.node)) errors.push(`${where}: node must map platforms to paths`);
    else {
      // Platforms some download step can provide a binary for.
      const provided = new Set(
        (Array.isArray(m.install) ? m.install : [])
          .filter((s) => s?.type === "download" && isObject(s.artifacts))
          .flatMap((s) => Object.keys(s.artifacts))
      );
      for (const [platform, rel] of Object.entries(m.node)) {
        const at = `${where}: node["${platform}"]`;
        if (!PLATFORMS.includes(platform)) errors.push(`${at}: unknown platform (use ${PLATFORMS.join(", ")})`);
        if (typeof rel !== "string") {
          errors.push(`${at}: must be a path`);
          continue;
        }
        paths.push(rel);
        if (!provided.has(platform) && !provided.has(ANY_PLATFORM)) {
          errors.push(`${at}: no download step has an artifact for this platform, so nothing installs that binary`);
        }
      }
    }
  }

  if ("configFile" in m && (typeof m.configFile !== "string" || !CONFIG_FILE.test(m.configFile))) {
    errors.push(`${where}: configFile must be a file name under the vault's .config/ (lowercase letters, digits and dashes, ending in .md)`);
  }

  // `network` and `secrets`, as `validate_network` in manifest.rs reads them.
  let network = [];
  if ("network" in m) {
    if (!isObject(m.network)) errors.push(`${where}: network must be { "hosts": [...] }`);
    else {
      onlyKeys(m.network, ["hosts"], `${where}: network`, errors);
      if (!Array.isArray(m.network.hosts)) errors.push(`${where}: network.hosts must be an array`);
      else {
        network = m.network.hosts;
        if (network.length === 0) errors.push(`${where}: network.hosts must not be empty`);
        for (const h of network) {
          if (!isHostPattern(h)) {
            errors.push(`${where}: network host ${JSON.stringify(h)} must be a lowercase DNS name, or *. followed by one`);
          }
        }
      }
    }
  }
  if ("secrets" in m) {
    if (!isObject(m.secrets)) errors.push(`${where}: secrets must map names to { "hosts": [...] }`);
    else
      for (const [name, spec] of Object.entries(m.secrets)) {
        const at = `${where}: secrets["${name}"]`;
        if (!SLUG.test(name)) errors.push(`${at}: name must be lowercase letters, digits and dashes (max 32)`);
        if (!isObject(spec)) {
          errors.push(`${at}: must be { "hosts": [...] }`);
          continue;
        }
        onlyKeys(spec, ["hosts"], at, errors);
        if (!Array.isArray(spec.hosts) || spec.hosts.length === 0) {
          errors.push(`${at}: must name at least one host`);
          continue;
        }
        for (const h of spec.hosts) {
          if (!network.includes(h)) errors.push(`${at}: host ${JSON.stringify(h)} must also be in network.hosts`);
        }
      }
  }

  for (const [at, field, since] of newer) {
    if (isVersionRange(m.mahfouz) && compareVersions(rangeFloor(m.mahfouz), since) < 0) {
      errors.push(`${at}: "${field}" needs Mahfouz ${since} or later, so mahfouz must start there (e.g. ">=${since}"); older apps reject the manifest`);
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

/** The error for a plugin that changed since `base` (the release line,
 * `origin/main`) without raising its version above the one released there,
 * or null. `baseVersion` is null for a plugin `base` doesn't have yet: it's
 * unreleased, so the PRs that build it up need no bump of their own. */
export function versionBumpError(id, changed, baseVersion, version, base = "main") {
  if (!changed || baseVersion === null) return null;
  const cmp = compareVersions(version, baseVersion);
  if (cmp === null) return null; // reported by the manifest check
  if (cmp <= 0) {
    return `plugins/${id}: changed since ${base}, so its version must go above ${baseVersion}, the released one (it's ${version}) — users only get an update when the version changes`;
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
      const error = versionBumpError(id, touched, before?.version ?? null, m.version, base);
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
