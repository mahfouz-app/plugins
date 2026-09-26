// Run with `npm test` (node --test) from the repo root. The frontend's
// DOM-free behaviour, against a fake host and engine: what it registers,
// the deck start sequence, the PDF API and the presentation tag. (The
// tab's and overlay's DOM are exercised in the app, not here.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { activate, sidecarEngine, startDeck, withPresentationType } from "./index.js";

function fakeEngine(over = {}) {
  const calls = [];
  const engine = {
    ready: async () => void calls.push("ready"),
    warm: async () => (calls.push("warm"), null),
    start: async (vaultPath, relPath, template) => (
      calls.push(`start ${vaultPath} ${relPath}${template ? ` ${template.name}` : ""}`),
      { url: "http://localhost:3030/", fresh: false }
    ),
    exportPdf: async (_vaultPath, relPath, { orientation, template }) => (
      calls.push(`export ${relPath} ${orientation}${template ? ` ${template.name}` : ""}`),
      "/tmp/out.pdf"
    ),
    stop: async () => void calls.push("stop"),
    log: async () => "server log tail",
    ...over,
  };
  return { engine, calls };
}

function fakeHost(enabled, slides) {
  const reg = { provided: undefined, tabs: [], commands: [], overlays: [], tabsOpened: [], attributeUpdates: [], sidecarCalls: [] };
  const host = {
    isEnabled: () => enabled,
    provide: (api) => void (reg.provided = api),
    registerTabType: (t) => reg.tabs.push(t),
    registerCommand: (c) => reg.commands.push(c),
    openTab: async (...args) => void reg.tabsOpened.push(args),
    notes: {
      get: async (note) => ({ ...note, title: "Deck", path: "talks/deck.md", vaultPath: "/vault", attributes: {}, body: "" }),
      updateAttributes: async (_note, update) => void reg.attributeUpdates.push(update({ type: "reference" })),
    },
    ui: { openOverlay: (spec) => (reg.overlays.push(spec), () => {}), openExternal: async () => {} },
    sidecar: { call: async (method, params) => (reg.sidecarCalls.push([method, params]), null) },
    ...(slides ? { slides } : {}),
  };
  return { host, reg };
}

const note = { vaultId: "v", noteId: "n", path: "talks/deck.md", title: "Deck" };
const flush = () => new Promise((r) => setTimeout(r, 0));

test("enabled: warms the server and adds the Present tab and commands", async () => {
  const { engine, calls } = fakeEngine();
  const { host, reg } = fakeHost(true);
  activate(host, engine);
  await flush();
  assert.ok(calls.includes("warm"));
  assert.deepEqual(reg.tabs.map((t) => [t.id, t.icon]), [["present", "▶"]]);
  assert.deepEqual(
    reg.commands.map((c) => [c.id, !!c.noteMenu, c.shortcut]),
    [
      ["present", true, undefined],
      ["present-fullscreen", false, "Mod+Shift+P"],
    ]
  );
  await reg.commands[0].run(note);
  assert.deepEqual(reg.tabsOpened, [["present", note, ""]]);
});

test("as PDF export's dependency only: provides its API, adds nothing, starts nothing", async () => {
  const { engine, calls } = fakeEngine();
  const { host, reg } = fakeHost(false);
  activate(host, engine);
  await flush();
  assert.ok(reg.provided);
  assert.deepEqual([reg.tabs, reg.commands, calls], [[], [], []]);
});

test("exportPdf checks Node, renders the note's own file, and adds the log to failures", async () => {
  const ok = fakeEngine();
  const a = fakeHost(false);
  activate(a.host, ok.engine);
  const progress = [];
  assert.equal(await a.reg.provided.exportPdf(note, { orientation: "portrait" }, (d) => progress.push(d)), "/tmp/out.pdf");
  assert.deepEqual(ok.calls, ["ready", "export talks/deck.md portrait"]);
  assert.deepEqual(progress, ["Exporting…"]);

  const failing = fakeEngine({ exportPdf: async () => Promise.reject(new Error("chromium crashed")) });
  const b = fakeHost(false);
  activate(b.host, failing.engine);
  await assert.rejects(b.reg.provided.exportPdf(note, { orientation: "landscape" }, () => {}), {
    message: "chromium crashed\n\nserver log tail",
  });
});

test("Present full screen tags the note a presentation and opens the overlay", async () => {
  const { engine } = fakeEngine();
  const { host, reg } = fakeHost(true);
  activate(host, engine);
  reg.commands[1].run(note);
  await flush();
  assert.deepEqual(reg.attributeUpdates, [{ type: "reference, presentation" }]);
  assert.deepEqual(reg.overlays.map((o) => o.title), ["Presenting Deck"]);
});

test("the deck start sequence: checking → starting → running", async () => {
  const phases = [];
  const { engine, calls } = fakeEngine();
  startDeck(engine, async () => ({ vaultPath: "/v", relPath: "a.md" }), (p) => phases.push(p.kind));
  await flush();
  await flush();
  assert.deepEqual(phases, ["checking", "starting", "running"]);
  assert.deepEqual(calls, ["ready", "start /v a.md"]);
});

test("a missing Node.js gets its own title and no server log; other failures get the log", async () => {
  const quiet = console.error;
  console.error = () => {};
  const errors = [];
  startDeck(
    fakeEngine({ ready: async () => Promise.reject(new Error("Slidev needs Node.js 22.12 or newer")) }).engine,
    async () => ({ vaultPath: "/v", relPath: "a.md" }),
    (p) => p.kind === "error" && errors.push(p)
  );
  startDeck(
    fakeEngine({ start: async () => Promise.reject(new Error("port in use")) }).engine,
    async () => ({ vaultPath: "/v", relPath: "a.md" }),
    (p) => p.kind === "error" && errors.push(p)
  );
  await flush();
  await flush();
  await flush();
  console.error = quiet;
  assert.deepEqual(errors, [
    { kind: "error", title: "Node.js not found", message: "Slidev needs Node.js 22.12 or newer" },
    { kind: "error", title: "Slidev could not start", message: "port in use\n\nserver log tail" },
  ]);
});

test("the engine is the sidecar's methods", async () => {
  const { host, reg } = fakeHost(true);
  const engine = sidecarEngine(host);
  const template = { name: "Brand" };
  await engine.start("/v", "a.md", template);
  await engine.exportPdf("/v", "a.md", { orientation: "portrait", content: "# x", template });
  assert.deepEqual(reg.sidecarCalls, [
    ["start", { vaultPath: "/v", relPath: "a.md", template }],
    ["export", { vaultPath: "/v", relPath: "a.md", orientation: "portrait", content: "# x", template }],
  ]);
});

test("the presentation tag is added once, keeping other types", () => {
  assert.deepEqual(withPresentationType({}), { type: "presentation" });
  assert.deepEqual(withPresentationType({ type: "reference" }), { type: "reference, presentation" });
  const tagged = { type: "presentation, reference" };
  assert.equal(withPresentationType(tagged), tagged);
});

test("the note's slides template goes to the export and to Present", async () => {
  const brand = { name: "Brand" };
  const asked = [];
  const slides = { resolveTemplate: async (n) => (asked.push(n.noteId), brand) };
  const ok = fakeEngine();
  const a = fakeHost(true, slides);
  activate(a.host, ok.engine);
  await a.reg.provided.exportPdf(note, { orientation: "landscape" }, () => {});
  assert.ok(ok.calls.includes("export talks/deck.md landscape Brand"));
  assert.deepEqual(asked, ["n"]);

  const phases = [];
  const started = fakeEngine();
  startDeck(started.engine, async () => ({ vaultPath: "/v", relPath: "a.md", template: brand }), (p) => phases.push(p.kind));
  await flush();
  await flush();
  assert.deepEqual(started.calls, ["ready", "start /v a.md Brand"]);
});

test("no template support on the host, or a failing lookup, means no template", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  const old = fakeEngine();
  const a = fakeHost(false);
  activate(a.host, old.engine);
  await a.reg.provided.exportPdf(note, { orientation: "portrait" }, () => {});
  const broken = fakeEngine();
  const b = fakeHost(false, { resolveTemplate: async () => Promise.reject(new Error("no vault")) });
  activate(b.host, broken.engine);
  await b.reg.provided.exportPdf(note, { orientation: "portrait" }, () => {});
  console.warn = quiet;
  assert.deepEqual(old.calls, ["ready", "export talks/deck.md portrait"]);
  assert.deepEqual(broken.calls, ["ready", "export talks/deck.md portrait"]);
});
