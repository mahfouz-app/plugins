// Run with `npm test` (node --test) from the repo root. The `/files/`
// route (vault-files.js): each run serves the vault its own entry names,
// and nothing outside that vault's `files/`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

/** Runs the plugin's middleware on a request through a real HTTP server,
 * returning what it sent (or `next` when it passed the request on). */
async function request(plugin, url, method = "GET", reqHeaders = {}) {
  const stack = [];
  plugin.configureServer({ middlewares: { stack } });
  const server = http.createServer((req, res) =>
    stack[0].handle(req, res, () => {
      res.setHeader("X-Next", "1");
      res.end();
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path: url, method, headers: reqHeaders }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve(res.headers["x-next"] ? "next" : { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
  }
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

test("a single byte range is a 206 with Content-Range; a full response says Accept-Ranges", async () => {
  const f = fixture();
  try {
    // "logo of A" is 9 bytes.
    const a = vaultFilesPlugin({ entry: f.entry(ID_A), userRoot: f.ws });
    const full = await request(a, "/files/logo.png");
    assert.equal(full.status, 200);
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.equal(full.headers["content-length"], "9");
    for (const [range, body, contentRange] of [
      ["bytes=0-3", "logo", "bytes 0-3/9"],
      ["bytes=4-", " of A", "bytes 4-8/9"],
      ["bytes=-2", " A", "bytes 7-8/9"],
      ["bytes=8-8", "A", "bytes 8-8/9"],
      ["bytes=5-100", "of A", "bytes 5-8/9"],
      ["bytes=-100", "logo of A", "bytes 0-8/9"],
    ]) {
      const got = await request(a, "/files/logo.png", "GET", { Range: range });
      assert.equal(got.status, 206, range);
      assert.equal(got.body, body, range);
      assert.equal(got.headers["content-range"], contentRange, range);
      assert.equal(got.headers["content-length"], String(body.length), range);
      assert.equal(got.headers["content-type"], "image/png", range);
      assert.equal(got.headers["x-content-type-options"], "nosniff", range);
    }
  } finally {
    f.done();
  }
});

test("an unsatisfiable range is a 416; a malformed, multi or If-Range one gets the whole file", async () => {
  const f = fixture();
  try {
    const a = vaultFilesPlugin({ entry: f.entry(ID_A), userRoot: f.ws });
    for (const range of ["bytes=9-", "bytes=100-200", "bytes=-0"]) {
      const got = await request(a, "/files/logo.png", "GET", { Range: range });
      assert.equal(got.status, 416, range);
      assert.equal(got.headers["content-range"], "bytes */9", range);
      assert.equal(got.body, "", range);
    }
    for (const range of ["bytes=abc", "bytes=3-1", "bytes=-", "bytes=", "items=0-3", "bytes=0-1,4-5", "bytes=1.5-3", "bytes=0x1-3", "bytes = 0-3"]) {
      const got = await request(a, "/files/logo.png", "GET", { Range: range });
      assert.equal(got.status, 200, range);
      assert.equal(got.body, "logo of A", range);
      assert.equal(got.headers["content-range"], undefined, range);
    }
    const ifRange = await request(a, "/files/logo.png", "GET", { Range: "bytes=0-3", "If-Range": '"x"' });
    assert.equal(ifRange.status, 200);
    assert.equal(ifRange.body, "logo of A");
    // An empty file has no satisfiable range.
    fs.writeFileSync(path.join(f.vaults.A, "files", "empty.png"), "");
    assert.equal((await request(a, "/files/empty.png")).status, 200);
    assert.equal((await request(a, "/files/empty.png", "GET", { Range: "bytes=0-" })).status, 416);
    // Containment is unchanged for a ranged request.
    assert.equal((await request(a, "/files/..%2Fsecret.md", "GET", { Range: "bytes=0-3" })).status, 404);
  } finally {
    f.done();
  }
});

test("HEAD with a Range sends the 206 headers and no body", async () => {
  const f = fixture();
  try {
    const a = vaultFilesPlugin({ entry: f.entry(ID_A), userRoot: f.ws });
    const got = await request(a, "/files/logo.png", "HEAD", { Range: "bytes=0-3" });
    assert.equal(got.status, 206);
    assert.equal(got.body, "");
    assert.equal(got.headers["content-range"], "bytes 0-3/9");
    assert.equal(got.headers["content-length"], "4");
    const head = await request(a, "/files/logo.png", "HEAD");
    assert.equal(head.headers["content-length"], "9");
    assert.equal(head.headers["accept-ranges"], "bytes");
  } finally {
    f.done();
  }
});

test("a file larger than one read chunk streams through whole", async () => {
  const f = fixture();
  try {
    const big = Buffer.alloc(300_000, "x");
    big.write("END", big.length - 3);
    fs.writeFileSync(path.join(f.vaults.A, "files", "clip.mp4"), big);
    const a = vaultFilesPlugin({ entry: f.entry(ID_A), userRoot: f.ws });
    const got = await request(a, "/files/clip.mp4");
    assert.equal(got.headers["content-type"], "video/mp4");
    assert.equal(got.body.length, big.length);
    assert.ok(got.body.endsWith("END"));
    const tail = await request(a, "/files/clip.mp4", "GET", { Range: "bytes=-3" });
    assert.equal(tail.status, 206);
    assert.equal(tail.body, "END");
  } finally {
    f.done();
  }
});
