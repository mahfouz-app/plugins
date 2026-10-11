// Run with `npm test` (node --test) from the repo root.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MONACO_WRITE, disableMonacoWrite, hardenPlugin, refusal } from "./harden.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("the dev server refuses writes and open-in-editor, and serves reads", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(refusal({ method, url: "/__slidev/slides/1.json" }), 405, method);
  }
  assert.equal(refusal({ method: "GET", url: "/__open-in-editor?file=/etc/hosts" }), 403);
  assert.equal(refusal({ method: "GET", url: "/" }), null);
  assert.equal(refusal({ method: "HEAD", url: "/@vite/client" }), null);
  assert.equal(refusal({ method: "GET", url: "/__slidev/slides/1.json" }), null);
});

test("monaco-write loses its server hook; other plugins keep theirs", () => {
  const configureServer = () => {};
  const monaco = { name: MONACO_WRITE, configureServer };
  const other = { name: "slidev:other", configureServer };
  disableMonacoWrite({ command: "serve", plugins: [other, monaco] });
  assert.equal(monaco.configureServer, undefined);
  assert.equal(other.configureServer, configureServer);
});

test("a dev server without monaco-write to disable refuses to start", () => {
  assert.throws(() => disableMonacoWrite({ command: "serve", plugins: [{ name: "slidev:renamed" }] }), /wasn't found/);
  assert.doesNotThrow(() => disableMonacoWrite({ command: "build", plugins: [] }));
});

test("the plugin goes first in the middleware stack and answers refused requests itself", () => {
  const plugin = hardenPlugin();
  assert.equal(plugin.enforce, "pre");
  const stack = [{ route: "/__slidev", handle() {} }];
  plugin.configureServer({ middlewares: { stack } });
  assert.equal(stack.length, 2);
  const middleware = stack[0].handle;
  const res = { statusCode: 200, ended: false, end() { this.ended = true; } };
  let passed = false;
  middleware({ method: "POST", url: "/__slidev/slides/1.json" }, res, () => (passed = true));
  assert.deepEqual([res.statusCode, res.ended, passed], [405, true, false]);
  middleware({ method: "GET", url: "/" }, { end() {} }, () => (passed = true));
  assert.equal(passed, true);
});

// The real dev server, from this directory as Slidev's project root, so it
// loads setup/vite-plugins.ts the way Present does. Needs the plugin's npm
// install; CI has it (see sidecar.test.js).
let slidev = null;
try {
  slidev = await import("@slidev/cli");
} catch (err) {
  if (process.env.CI) throw err;
}

test("Slidev's dev server loads the hardening from setup/", { skip: slidev ? false : "@slidev/cli isn't installed (npm ci in plugins/slidev)", timeout: 120_000 }, async () => {
  const entry = path.join(HERE, `.harden-test-${crypto.randomUUID()}.md`);
  fs.writeFileSync(entry, "---\ntitle: t\n---\n\n# Hello\n\n<<< @/sidecar.js js {monaco-write}\n");
  let server;
  try {
    const options = await slidev.resolveOptions({ entry }, "dev");
    server = await slidev.createServer(options, { server: { port: 0, host: "127.0.0.1" }, logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
    const monaco = server.config.plugins.find((p) => p.name === MONACO_WRITE);
    assert.ok(monaco, "Slidev still has monaco-write");
    assert.equal(monaco.configureServer, undefined);
    assert.ok(server.config.plugins.some((p) => p.name === "mahfouz:harden"));
    await server.listen();
    const base = `http://127.0.0.1:${server.config.server.port === 0 ? server.httpServer.address().port : server.config.server.port}`;
    const post = await fetch(`${base}/__slidev/slides/1.json`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(post.status, 405);
    const open = await fetch(`${base}/__open-in-editor?file=sidecar.js`);
    assert.equal(open.status, 403);
  } finally {
    await server?.close();
    fs.rmSync(entry, { force: true });
  }
});
