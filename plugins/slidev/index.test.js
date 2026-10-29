// Run with `npm test` (node --test) from the repo root. The frontend's
// DOM-free behaviour, against a fake host and engine: what it registers,
// the deck start sequence, the PDF API, the PowerPoint export format and the
// presentation tag. (The
// tab's and overlay's DOM are exercised in the app, not here.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { activate, deckFileName, presentDeckTarget, sidecarEngine, startDeck, withPresentationType } from "./index.js";

function fakeEngine(over = {}) {
  const calls = [];
  const engine = {
    ready: async () => void calls.push("ready"),
    warm: async () => (calls.push("warm"), null),
    start: async (vaultPath, relPath, template) => (
      calls.push(`start ${vaultPath} ${relPath}${template ? ` ${template.name}` : ""}`),
      { url: "http://localhost:3030/", fresh: false }
    ),
    exportDeck: async (_vaultPath, relPath, { orientation, format, template }) => (
      calls.push(`export ${relPath} ${orientation} ${format}${template ? ` ${template.name}` : ""}`),
      `/tmp/out.${format}`
    ),
    stop: async () => void calls.push("stop"),
    log: async () => "server log tail",
    ...over,
  };
  return { engine, calls };
}

function fakeHost(enabled, slides) {
  const reg = { provided: undefined, tabs: [], commands: [], formats: [], toolbar: [], overlays: [], tabsOpened: [], attributeUpdates: [], sidecarCalls: [] };
  const host = {
    isEnabled: () => enabled,
    provide: (api) => void (reg.provided = api),
    registerTabType: (t) => reg.tabs.push(t),
    registerCommand: (c) => reg.commands.push(c),
    registerExportFormat: (f) => reg.formats.push(f),
    registerToolbarItem: (i) => reg.toolbar.push(i),
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
      ["present-fullscreen", false, "Mod+Alt+Enter"],
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
  assert.deepEqual([reg.tabs, reg.commands, reg.formats, reg.toolbar, calls], [[], [], [], [], []]);
});

test("adds a Present button to the toolbar that opens the presentation tab", async () => {
  const { engine } = fakeEngine();
  const { host, reg } = fakeHost(true);
  activate(host, engine);
  await flush();
  const present = reg.toolbar.find((i) => i.id === "present-button");
  assert.equal(present.kind, "button");
  assert.equal(present.label, "Present");
  present.run(note);
  assert.deepEqual(reg.tabsOpened, [["present", note, ""]]);
});

test("adds no toolbar item when loaded only as a dependency", async () => {
  const { engine } = fakeEngine();
  const { host, reg } = fakeHost(false);
  activate(host, engine);
  await flush();
  assert.deepEqual(reg.toolbar, []);
});

test("exportPdf checks Node, renders the note's own file, and adds the log to failures", async () => {
  const ok = fakeEngine();
  const a = fakeHost(false);
  activate(a.host, ok.engine);
  const progress = [];
  assert.equal(await a.reg.provided.exportPdf(note, { orientation: "portrait" }, (d) => progress.push(d)), "/tmp/out.pdf");
  assert.deepEqual(ok.calls, ["ready", "export talks/deck.md portrait pdf"]);
  assert.deepEqual(progress, ["Exporting…"]);

  const failing = fakeEngine({ exportDeck: async () => Promise.reject(new Error("chromium crashed")) });
  const b = fakeHost(false);
  activate(b.host, failing.engine);
  await assert.rejects(b.reg.provided.exportPdf(note, { orientation: "landscape" }, () => {}), {
    message: "chromium crashed\n\nserver log tail",
  });
});

test("enabled: adds a PowerPoint export format that renders the dialog's content", async () => {
  const { engine, calls } = fakeEngine();
  const { host, reg } = fakeHost(true);
  activate(host, engine);
  assert.deepEqual(reg.formats.map((f) => [f.id, f.label]), [["pptx", "PowerPoint / Google Slides (.pptx)"]]);
  const progress = [];
  const result = await reg.formats[0].export(
    { note: { ...note, attributes: { orientation: "portrait" } }, content: "# x" },
    (d) => progress.push(d)
  );
  assert.deepEqual(result, {
    path: "/tmp/out.pptx",
    suggestedName: "Deck.pptx",
    filter: { name: "PowerPoint", extensions: ["pptx"] },
  });
  assert.ok(calls.includes("export talks/deck.md portrait pptx"));
  assert.deepEqual(progress, ["Exporting…"]);
});

test("deck file names replace characters file systems refuse", () => {
  assert.equal(deckFileName("Q3: plan/review", "pptx"), "Q3- plan-review.pptx");
  assert.equal(deckFileName("", "pptx"), "Untitled.pptx");
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
  await engine.exportDeck("/v", "a.md", { orientation: "portrait", content: "# x", format: "pptx", template });
  assert.deepEqual(reg.sidecarCalls, [
    ["start", { vaultPath: "/v", relPath: "a.md", template }],
    ["export", { vaultPath: "/v", relPath: "a.md", orientation: "portrait", content: "# x", format: "pptx", template }],
  ]);
});

test("the presentation tag is added once, keeping other types", () => {
  assert.deepEqual(withPresentationType({}), { type: "presentation" });
  assert.deepEqual(withPresentationType({ type: "reference" }), { type: "reference, presentation" });
  const tagged = { type: "presentation, reference" };
  assert.equal(withPresentationType(tagged), tagged);
});

test("the note's slides template goes to both exports and to Present", async () => {
  const brand = { name: "Brand" };
  const asked = [];
  const slides = { resolveTemplate: async (n) => (asked.push(n.noteId), brand) };
  const ok = fakeEngine();
  const a = fakeHost(true, slides);
  activate(a.host, ok.engine);
  await a.reg.provided.exportPdf(note, { orientation: "landscape" }, () => {});
  assert.ok(ok.calls.includes("export talks/deck.md landscape pdf Brand"));
  await a.reg.formats[0].export({ note: { ...note, attributes: {} } }, () => {});
  assert.ok(ok.calls.includes("export talks/deck.md landscape pptx Brand"));
  assert.deepEqual(asked, ["n", "n"]);

  const phases = [];
  const started = fakeEngine();
  startDeck(started.engine, async () => ({ vaultPath: "/v", relPath: "a.md", template: brand }), (p) => phases.push(p.kind));
  await flush();
  await flush();
  assert.deepEqual(started.calls, ["ready", "start /v a.md Brand"]);
});

/** Just enough `document` for the Present tab's status panel and frame. */
function fakeDocument() {
  const el = () => ({
    children: [],
    isConnected: false,
    setAttribute() {},
    addEventListener() {},
    replaceChildren() {
      this.children = [];
    },
    appendChild(c) {
      this.children.push(c);
      c.isConnected = true;
    },
    append(...cs) {
      cs.forEach((c) => this.appendChild(c));
    },
    remove() {
      this.isConnected = false;
    },
    focus() {},
  });
  return { createElement: el, body: el() };
}

test("Present and both exports, each through the plugin's own wiring, send the same stylesheet bytes", async () => {
  const stylesheet = '.slidev-page { --mahfouz-text: #111; }\n</style>\n---\n\u2028';
  const v2 = { name: "Brand", stylesheet, colorSchema: "dark", fontFamilies: ["Inter"] };
  const seen = [];
  const capture = fakeEngine({
    start: async (_v, _r, template) => (seen.push(["present", template.stylesheet]), { url: "http://localhost:3030/", fresh: false }),
    exportDeck: async (_v, _r, { format, template }) => (seen.push([format, template.stylesheet]), `/tmp/out.${format}`),
  });
  // Each lookup returns a fresh copy, as the app's does.
  const a = fakeHost(true, { resolveTemplate: async () => structuredClone(v2) });
  activate(a.host, capture.engine);
  await a.reg.provided.exportPdf(note, { orientation: "landscape" }, () => {});
  await a.reg.formats[0].export({ note: { ...note, attributes: {} } }, () => {});

  // Present: the note menu's command opens the tab, and the tab type the
  // plugin registered renders it.
  await a.reg.commands.find((c) => c.id === "present").run(note);
  const [[tabId, tabNote]] = a.reg.tabsOpened;
  const tab = a.reg.tabs.find((t) => t.id === tabId);
  globalThis.document = fakeDocument();
  try {
    const container = document.createElement("div");
    const dispose = tab.render(container, { note: tabNote, setToolbar: () => {} });
    for (let i = 0; i < 5 && seen.length < 3; i++) await flush();
    dispose();
  } finally {
    delete globalThis.document;
  }

  assert.deepEqual(seen.map(([kind]) => kind), ["pdf", "pptx", "present"]);
  for (const [kind, bytes] of seen) assert.equal(bytes, stylesheet, kind);
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
  assert.deepEqual(old.calls, ["ready", "export talks/deck.md portrait pdf"]);
  assert.deepEqual(broken.calls, ["ready", "export talks/deck.md portrait pdf"]);
});

// ---- the template preview renderer -------------------------------------------
//
// Settings → Slides' "Render with Slidev": the app hands a renderer its
// sample deck and a resolved template (`host.slides.registerPreviewRenderer`,
// absent in older apps) and gets the slides back as PNG data URLs.

function previewHost(enabled) {
  const renderers = [];
  const slides = { resolveTemplate: async () => null, registerPreviewRenderer: (render) => (renderers.push(render), { dispose() {} }) };
  return { ...fakeHost(enabled, slides), renderers };
}

test("registers a preview renderer only when enabled, and only on a host that has the method", async () => {
  for (const enabled of [true, false]) {
    const { host, renderers } = previewHost(enabled);
    activate(host, fakeEngine().engine);
    await flush();
    assert.equal(renderers.length, enabled ? 1 : 0, `enabled: ${enabled}`);
  }
  // An older app: no slides at all, or slides without the method.
  for (const slides of [undefined, { resolveTemplate: async () => null }]) {
    const { host, reg } = fakeHost(true, slides);
    assert.doesNotThrow(() => activate(host, fakeEngine().engine));
    await flush();
    assert.deepEqual([reg.tabs.map((t) => t.id), reg.formats.map((f) => f.id)], [["present"], ["pptx"]]);
  }
});

test("the preview renderer checks Node, renders the sample with the template, and returns PNG data URLs", async () => {
  const template = { name: "Brand", stylesheet: ".slidev-page { color: red; }" };
  const { engine, calls } = fakeEngine({
    previewDeck: async (vaultPath, markdown, t) => (
      calls.push(`preview ${vaultPath} ${JSON.stringify(markdown)} ${t.name}`),
      { slides: [{ png: "iVBORw0KGgoAAAA=" }, { png: "iVBORw0KGgoBBBB=" }] }
    ),
  });
  const { host, renderers } = previewHost(true);
  activate(host, engine);
  await flush();
  calls.length = 0;
  const result = await renderers[0]({ vaultPath: "/vault", markdown: "# One\n\n---\n\n# Two\n", template });
  assert.deepEqual(result, {
    slides: [{ png: "data:image/png;base64,iVBORw0KGgoAAAA=" }, { png: "data:image/png;base64,iVBORw0KGgoBBBB=" }],
  });
  assert.deepEqual(calls, ["ready", 'preview /vault "# One\\n\\n---\\n\\n# Two\\n" Brand']);
});

test("a failed preview render carries the server log, like an export", async () => {
  const { engine } = fakeEngine({ previewDeck: async () => Promise.reject(new Error("chromium crashed")) });
  const { host, renderers } = previewHost(true);
  activate(host, engine);
  await flush();
  await assert.rejects(renderers[0]({ vaultPath: "/vault", markdown: "# a", template: null }), {
    message: "chromium crashed\n\nserver log tail",
  });
});

test("the engine's previewDeck is the sidecar's preview method", async () => {
  const { host, reg } = fakeHost(true);
  const template = { name: "Brand" };
  await sidecarEngine(host).previewDeck("/v", "# a", template);
  assert.deepEqual(reg.sidecarCalls, [["preview", { vaultPath: "/v", markdown: "# a", template }]]);
});

test("Present's target carries the app's deck: the note, its descendants and its links", async () => {
  const deck = { parts: ["talks/deck.md", "talks/deck/child.md"], links: { child: { path: "talks/deck/child.md", title: "Child" } } };
  const asked = [];
  const { host } = fakeHost(true, { deck: async (n) => (asked.push(n), deck) });
  assert.deepEqual(await presentDeckTarget(host, note), { vaultPath: "/vault", relPath: "talks/deck.md", template: null, deck });
  assert.deepEqual(asked, [note]);
});

test("an app without host.slides.deck presents the note alone, with no links", async () => {
  for (const slides of [undefined, { resolveTemplate: async () => null }]) {
    const { host } = fakeHost(true, slides);
    assert.deepEqual((await presentDeckTarget(host, note)).deck, { parts: ["talks/deck.md"], links: {} });
  }
});

test("a refused deck (an encrypted note) is Present's error", async () => {
  const { host } = fakeHost(true, { deck: async () => Promise.reject(new Error("Encrypted notes can't be presented.")) });
  await assert.rejects(presentDeckTarget(host, note), /Encrypted notes/);
});

test("the engine sends the deck's parts and links with start, and nothing for an older call", async () => {
  const { host, reg } = fakeHost(true);
  const engine = sidecarEngine(host);
  await engine.start("/v", "a.md", null, { parts: ["a.md", "a/b.md"], links: { b: null } });
  await engine.start("/v", "a.md");
  assert.deepEqual(reg.sidecarCalls, [
    ["start", { vaultPath: "/v", relPath: "a.md", template: null, parts: ["a.md", "a/b.md"], links: { b: null } }],
    ["start", { vaultPath: "/v", relPath: "a.md", template: null }],
  ]);
});

test("the deck start sequence hands the target's deck to the engine", async () => {
  const seen = [];
  const { engine } = fakeEngine({ start: async (...args) => (seen.push(args), { url: "http://localhost:3030/", fresh: false }) });
  const deck = { parts: ["a.md"], links: {} };
  startDeck(engine, async () => ({ vaultPath: "/v", relPath: "a.md", deck }), () => {});
  await flush();
  await flush();
  assert.deepEqual(seen, [["/v", "a.md", null, deck]]);
});
