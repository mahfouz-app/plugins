// Run with `npm test` (node --test) from the repo root. The `/files/`
// route (vault-files.js): each run serves the vault its own entry names,
// and nothing outside that vault's `files/`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { entryVaultId, resolveVaultFile, vaultFilesPlugin, VAULT_KEY } from "./vault-files.js";

const ID_A = "aaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbb";

/** A workspace with vaults A and B linked as `vaults/<id>`, each holding
 * `files/logo.png` with its own bytes, plus an entry naming `id`. */
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mahfouz-vault-files-")));
  const ws = path.join(base, "ws");
  fs.mkdirSync(path.join(ws, "vaults"), { recursive: true });
  const vaults = {};
  for (const [id, name] of [
    [ID_A, "A"],
    [ID_B, "B"],
  ]) {
    const vault = path.join(base, `vault-${name}`);
    fs.mkdirSync(path.join(vault, "files", "sub"), { recursive: true });
    fs.writeFileSync(path.join(vault, "files", "logo.png"), `logo of ${name}`);
    fs.writeFileSync(path.join(vault, "files", "sub", "a b.svg"), `<svg>${name}</svg>`);
    fs.writeFileSync(path.join(vault, "secret.md"), "not an attachment");
    fs.symlinkSync(vault, path.join(ws, "vaults", id), "dir");
    vaults[name] = vault;
  }
  const entry = (id, name = "deck.md") => {
    const file = path.join(ws, name);
    fs.writeFileSync(file, `---\nsrc: "./vaults/${id}/n.md"\n${VAULT_KEY}: "${id}"\n---\n`);
    return file;
  };
  return { base, ws, vaults, entry, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("the entry's vault id is read from its headmatter, and only a link id counts", () => {
  assert.equal(entryVaultId(`---\nsrc: "x"\n${VAULT_KEY}: "${ID_A}"\n---\n`), ID_A);
  assert.equal(entryVaultId(`---\n${VAULT_KEY}: "${ID_A}"\nmahfouz: {}\n---\n\n# x\n`), ID_A);
  assert.equal(entryVaultId("---\ntitle: Mahfouz\n---\n\n# Mahfouz\n"), null, "the idle placeholder names none");
  assert.equal(entryVaultId(`---\n${VAULT_KEY}: "../x"\n---\n`), null);
  assert.equal(entryVaultId(`---\n${VAULT_KEY}: "${ID_A.toUpperCase()}"\n---\n`), null);
  // Only the headmatter: a slide body can't name a vault.
  assert.equal(entryVaultId(`---\ntitle: x\n---\n\n${VAULT_KEY}: "${ID_A}"\n`), null);
});

test("a run serves /files/ from the vault its own entry names", () => {
  const f = fixture();
  try {
    assert.equal(fs.readFileSync(resolveVaultFile(f.ws, f.entry(ID_A, "deck.md"), "logo.png"), "utf8"), "logo of A");
    assert.equal(fs.readFileSync(resolveVaultFile(f.ws, f.entry(ID_B, "export-1.md"), "logo.png"), "utf8"), "logo of B");
    // Present's entry still names A while B's export runs.
    assert.equal(fs.readFileSync(resolveVaultFile(f.ws, path.join(f.ws, "deck.md"), "logo.png"), "utf8"), "logo of A");
    assert.equal(fs.readFileSync(resolveVaultFile(f.ws, path.join(f.ws, "deck.md"), "sub/a b.svg"), "utf8"), "<svg>A</svg>");
  } finally {
    f.done();
  }
});

test("nothing outside the vault's files/ is served", () => {
  const f = fixture();
  try {
    const entry = f.entry(ID_A);
    for (const name of ["", "sub", "../secret.md", "sub/../../secret.md", "./logo.png", "sub//a b.svg", "..\\secret.md", "logo.png\0", "missing.png"]) {
      assert.equal(resolveVaultFile(f.ws, entry, name), null, JSON.stringify(name));
    }
    // A symlink inside files/ that leads out of it.
    fs.symlinkSync(path.join(f.vaults.A, "secret.md"), path.join(f.vaults.A, "files", "leak.md"));
    fs.symlinkSync(f.vaults.B, path.join(f.vaults.A, "files", "other"), "dir");
    assert.equal(resolveVaultFile(f.ws, entry, "leak.md"), null);
    assert.equal(resolveVaultFile(f.ws, entry, "other/files/logo.png"), null);
    // One that stays inside it is fine.
    fs.symlinkSync(path.join(f.vaults.A, "files", "logo.png"), path.join(f.vaults.A, "files", "alias.png"));
    assert.equal(fs.readFileSync(resolveVaultFile(f.ws, entry, "alias.png"), "utf8"), "logo of A");
    // files/ itself a symlink out of the vault.
    fs.rmSync(path.join(f.vaults.B, "files"), { recursive: true });
    fs.symlinkSync(path.join(f.vaults.A, "files"), path.join(f.vaults.B, "files"), "dir");
    assert.equal(resolveVaultFile(f.ws, f.entry(ID_B), "logo.png"), null);
    // A vault that isn't linked, an entry naming none, a missing entry.
    assert.equal(resolveVaultFile(f.ws, f.entry("cccccccccccccccc"), "logo.png"), null);
    fs.writeFileSync(entry, "---\ntitle: Mahfouz\n---\n");
    assert.equal(resolveVaultFile(f.ws, entry, "logo.png"), null);
    assert.equal(resolveVaultFile(f.ws, path.join(f.ws, "gone.md"), "logo.png"), null);
  } finally {
    f.done();
  }
});

/** Runs the plugin's middleware on a request, returning what it sent (or
 * `next` when it passed the request on). */
function request(plugin, url, method = "GET") {
  const stack = [];
  plugin.configureServer({ middlewares: { stack } });
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => (headers[k.toLowerCase()] = v),
      end: (body) => resolve({ status: res.statusCode, headers, body: body === undefined ? "" : String(body) }),
    };
    stack[0].handle({ method, url }, res, () => resolve("next"));
  });
}

test("the middleware serves /files/<name> from the run's vault, 404s anything else under /files/, and passes the rest on", async () => {
  const f = fixture();
  try {
    const a = vaultFilesPlugin({ entry: f.entry(ID_A, "deck.md"), userRoot: f.ws });
    const b = vaultFilesPlugin({ entry: f.entry(ID_B, "export-1.md"), userRoot: f.ws });
    const got = await request(a, "/files/logo.png?import");
    assert.equal(got.status, 200);
    assert.equal(got.body, "logo of A");
    assert.equal(got.headers["content-type"], "image/png");
    assert.equal(got.headers["x-content-type-options"], "nosniff");
    assert.equal((await request(b, "/files/logo.png")).body, "logo of B");
    assert.equal((await request(a, "/files/sub/a%20b.svg")).body, "<svg>A</svg>");
    assert.equal((await request(a, "/files/sub/a%20b.svg")).headers["content-type"], "image/svg+xml");
    const head = await request(a, "/files/logo.png", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    for (const url of ["/files/missing.png", "/files/..%2Fsecret.md", "/files/%2e%2e/secret.md", "/files/%E0%A4%A", "/files/"]) {
      assert.equal((await request(a, url)).status, 404, url);
    }
    assert.equal(await request(a, "/vaults/x"), "next");
    assert.equal(await request(a, "/filesystem.png"), "next");
  } finally {
    f.done();
  }
});

test("an import of /files/<name> is a module exporting the URL, served by the middleware", async () => {
  const plugin = vaultFilesPlugin({ entry: "/nowhere/deck.md", userRoot: "/nowhere" });
  assert.equal(plugin.enforce, "pre");
  const id = plugin.resolveId("/files/sub/a b.png?import");
  assert.equal(id, "\0mahfouz-files:/files/sub/a b.png");
  assert.equal(plugin.load(id), 'export default "/files/sub/a b.png";');
  assert.equal(plugin.resolveId("/filesystem.png"), null);
  assert.equal(plugin.resolveId("./files/a.png"), null);
  assert.equal(plugin.load("/files/a.png"), null);
});
