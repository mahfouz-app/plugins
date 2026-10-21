// Run with `npm test` (node --test) from the repo root. Covers the
// DOM-free parts: block helpers, scene parsing, the editor session and the
// publish renderer (with a fake Excalidraw).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkSvg } from "../../scripts/svg-allowlist.js";
import {
  activate,
  countExcalidrawBlocksBefore,
  createEditorSession,
  createPublishRenderer,
  extractExcalidrawBlockAt,
  fenceSafeJson,
  hasVisibleElements,
  isPublishableSvg,
  parseScene,
  replaceExcalidrawBlockAt,
} from "./index.js";

const scene = (elements) => JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });
const rect = { id: "r", type: "rectangle", isDeleted: false };

const twoBlocks = ["# Note", "", "```excalidraw", "{\"old\":0}", "```", "", "Text.", "", "```excalidraw", "{\"old\":1}", "```", ""].join("\n");

// ---- block helpers -----------------------------------------------------------

test("replaceExcalidrawBlockAt replaces only the Nth excalidraw block", () => {
  const out = replaceExcalidrawBlockAt(twoBlocks, 1, '{"new":1}');
  assert.match(out, /\{"old":0\}/);
  assert.doesNotMatch(out, /\{"old":1\}/);
  assert.match(out, /\{"new":1\}/);
  assert.match(out, /Text\./);
});

test("other fence languages don't count", () => {
  const body = "```drawio\n<a/>\n```\n\n```excalidraw\n{}\n```";
  const out = replaceExcalidrawBlockAt(body, 0, '{"x":1}');
  assert.match(out, /<a\/>/);
  assert.match(out, /\{"x":1\}/);
  assert.equal(countExcalidrawBlocksBefore(body, body.length), 1);
});

test("an out-of-range index throws instead of writing the wrong block", () => {
  assert.throws(() => replaceExcalidrawBlockAt("```excalidraw\n{}\n```\n", 1, "{}"), /no excalidraw block at index 1/);
});

test("CRLF bodies are read, and written back with LF fences", () => {
  const crlf = "```excalidraw\r\n{\"a\":1}\r\n```\r\n";
  assert.equal(extractExcalidrawBlockAt(crlf, 0), '{"a":1}');
  assert.equal(replaceExcalidrawBlockAt(crlf, 0, '{"b":2}'), '```excalidraw\n{"b":2}\n```\r\n');
});

test("extractExcalidrawBlockAt returns the Nth block, or empty when missing", () => {
  assert.equal(extractExcalidrawBlockAt(twoBlocks, 0), '{"old":0}');
  assert.equal(extractExcalidrawBlockAt(twoBlocks, 1), '{"old":1}');
  assert.equal(extractExcalidrawBlockAt(twoBlocks, 2), "");
});

test("countExcalidrawBlocksBefore gives a just-inserted block its ordinal", () => {
  assert.equal(countExcalidrawBlocksBefore(twoBlocks, 0), 0);
  assert.equal(countExcalidrawBlocksBefore(twoBlocks, twoBlocks.indexOf("Text.")), 1);
  assert.equal(countExcalidrawBlocksBefore(twoBlocks, twoBlocks.length), 2);
});

test("fenceSafeJson keeps a text's ``` from closing the fence, and means the same JSON", () => {
  const json = JSON.stringify({ elements: [{ type: "text", text: "```js\ncode\n```" }] });
  const safe = fenceSafeJson(json);
  assert.equal(safe.includes("`"), false);
  assert.deepEqual(JSON.parse(safe), JSON.parse(json));
  const body = replaceExcalidrawBlockAt("```excalidraw\n{}\n```\nAfter.", 0, safe);
  assert.equal(extractExcalidrawBlockAt(body, 0), safe);
  assert.match(body, /After\.$/);
});

// ---- scenes --------------------------------------------------------------------

test("parseScene reads a scene, and treats an empty fence as an empty scene", () => {
  assert.deepEqual(parseScene("  \n"), { elements: [], appState: {}, files: {} });
  assert.deepEqual(parseScene(JSON.stringify({ elements: [rect] })), { elements: [rect], appState: {}, files: {} });
  const full = { elements: [rect], appState: { viewBackgroundColor: "#fff" }, files: { f: {} } };
  assert.deepEqual(parseScene(JSON.stringify(full)), full);
});

test("parseScene throws a readable error for bad JSON or a non-scene", () => {
  assert.throws(() => parseScene("{nope"), /isn't valid JSON/);
  assert.throws(() => parseScene('{"type":"excalidraw"}'), /"elements" array/);
  assert.throws(() => parseScene("[1]"), /"elements" array/);
});

test("hasVisibleElements ignores deleted elements", () => {
  assert.equal(hasVisibleElements([]), false);
  assert.equal(hasVisibleElements([{ ...rect, isDeleted: true }]), false);
  assert.equal(hasVisibleElements([{ ...rect, isDeleted: true }, rect]), true);
});

// ---- activate ------------------------------------------------------------------

test("activate registers the embed, the editor tab and the publish renderer", () => {
  const registered = {};
  activate({
    registerEmbed: (lang, r) => (registered.embed = [lang, r.label]),
    registerTabType: (t) => (registered.tab = [t.id, t.icon]),
    registerPublishRenderer: (langs, fn) => (registered.publish = [langs, typeof fn]),
    isEnabled: () => false,
  });
  assert.deepEqual(registered, {
    embed: ["excalidraw", "Excalidraw drawing"],
    tab: ["editor", "✎"],
    publish: [["excalidraw"], "function"],
  });
});

test("activate works on an app without registerPublishRenderer", () => {
  assert.doesNotThrow(() => activate({ registerEmbed: () => {}, registerTabType: () => {}, isEnabled: () => false }));
});

test("the starter snippet is an empty scene", () => {
  let renderer;
  activate({ registerEmbed: (_l, r) => (renderer = r), registerTabType: () => {}, isEnabled: () => false });
  const parsed = parseScene(renderer.snippet);
  assert.deepEqual(parsed.elements, []);
  assert.equal(JSON.parse(renderer.snippet).type, "excalidraw");
});

test("the embed's edit button and an insert open the editor tab for that block", () => {
  let renderer;
  const opened = [];
  activate({
    registerEmbed: (_lang, r) => (renderer = r),
    registerTabType: () => {},
    isEnabled: () => false,
    openTab: (type, note, arg) => opened.push([type, note, arg]),
  });
  const note = { vaultId: "v", noteId: "n" };
  renderer.edit({ ordinal: 2, note });
  renderer.onInsertedAt({ state: { doc: { toString: () => twoBlocks } } }, twoBlocks.indexOf("Text."), note);
  renderer.edit({ ordinal: 0, note: null });
  assert.deepEqual(opened, [
    ["editor", note, "2"],
    ["editor", note, "1"],
  ]);
});

test("a New drawing toolbar button inserts an excalidraw block, or toasts without an editor", () => {
  const inserted = [];
  const toasts = [];
  const toolbar = [];
  let open = true;
  activate({
    registerEmbed: () => {},
    registerTabType: () => {},
    isEnabled: () => true,
    registerToolbarItem: (item) => toolbar.push(item),
    editor: { insertEmbed: (lang) => (inserted.push(lang), open) },
    toast: (message) => toasts.push(message),
  });
  const btn = toolbar.find((i) => i.id === "new-drawing");
  assert.equal(btn.kind, "button");
  assert.equal(btn.label, "New drawing");
  btn.run({ vaultId: "v", noteId: "n", path: "n.md", title: "N" });
  open = false;
  btn.run({ vaultId: "v", noteId: "n", path: "n.md", title: "N" });
  assert.deepEqual(inserted, ["excalidraw", "excalidraw"]);
  assert.deepEqual(toasts, ["Open a note in the editor first, then add the drawing."]);
});

test("adds no toolbar item when loaded only as a dependency", () => {
  const toolbar = [];
  activate({
    registerEmbed: () => {},
    registerTabType: () => {},
    isEnabled: () => false,
    registerToolbarItem: (item) => toolbar.push(item),
  });
  assert.deepEqual(toolbar, []);
});

// ---- editor session --------------------------------------------------------------

function session(overrides = {}) {
  const log = { written: [], errors: [], saved: 0 };
  let body = overrides.body ?? twoBlocks;
  const s = createEditorSession({
    index: overrides.index ?? 1,
    readBody: async () => body,
    writeBody:
      overrides.writeBody ??
      (async (next) => {
        body = next;
        log.written.push(next);
        return next;
      }),
    onError: (m) => log.errors.push(m),
    onSaved: () => (log.saved += 1),
    debounceMs: overrides.debounceMs ?? 5,
  });
  return { s, log, body: () => body };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("session: load reads the block's scene; an unchanged scene is never written", async () => {
  const body = "```excalidraw\n" + scene([rect]) + "\n```\n";
  const { s, log } = session({ body, index: 0 });
  assert.deepEqual((await s.load()).elements, [rect]);
  const echo = scene([rect]).replace('"version":2', '"version":2,"source":"x"');
  s.baseline(echo);
  s.change(echo);
  await tick();
  await s.flush();
  assert.deepEqual(log.written, []);
});

test("session: changes before the baseline are ignored", async () => {
  const { s, log } = session();
  s.change(scene([rect]));
  await tick();
  await s.flush();
  assert.deepEqual(log.written, []);
});

test("session: a burst of changes saves once, the last one, fence-safe", async () => {
  const { s, log, body } = session();
  s.baseline(scene([]));
  s.change(scene([rect]));
  s.change(scene([rect, { ...rect, id: "r2" }]));
  const withText = scene([{ type: "text", text: "a ``` b" }]);
  s.change(withText);
  await tick();
  assert.equal(log.written.length, 1);
  assert.equal(extractExcalidrawBlockAt(body(), 1), fenceSafeJson(withText));
  assert.equal(extractExcalidrawBlockAt(body(), 0), '{"old":0}');
  assert.equal(log.saved, 1);
});

test("session: changing back to the saved scene cancels the pending save", async () => {
  const { s, log } = session();
  s.baseline(scene([]));
  s.change(scene([rect]));
  s.change(scene([]));
  await tick();
  await s.flush();
  assert.deepEqual(log.written, []);
});

test("session: flush saves a pending change right away", async () => {
  const { s, log } = session({ debounceMs: 10_000 });
  s.baseline(scene([]));
  s.change(scene([rect]));
  await s.flush();
  assert.equal(log.written.length, 1);
  await s.flush();
  assert.equal(log.written.length, 1);
});

test("session: a failed save is reported and retried by the next flush", async () => {
  let fail = true;
  const written = [];
  const err = Object.assign(new Error("The note changed outside this tab."), { name: "NoteChangedError" });
  const { s, log } = session({
    writeBody: async (next) => {
      if (fail) throw err;
      written.push(next);
      return next;
    },
  });
  s.baseline(scene([]));
  s.change(scene([rect]));
  await s.flush();
  assert.deepEqual(log.errors, ["Drawing save failed: The note changed outside this tab."]);
  assert.equal(log.saved, 0);
  fail = false;
  await s.flush();
  assert.equal(written.length, 1);
  assert.equal(log.saved, 1);
});

test("session: a block that's gone fails loudly instead of writing another block", async () => {
  const { s, log } = session({ index: 5 });
  s.baseline(scene([]));
  s.change(scene([rect]));
  await s.flush();
  assert.deepEqual(log.written, []);
  assert.match(log.errors[0], /no excalidraw block at index 5/);
});

// ---- published pages ------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const GOOD_SVG = `<svg xmlns="${SVG_NS}" viewBox="0 0 10 10"><path d="M0 0L10 10" stroke="#000"/></svg>`;

function fakeSvg(children = []) {
  const removed = [];
  const el = (name) => ({ name, remove: () => removed.push(name) });
  const nodes = children.map(el);
  return {
    removed,
    getElementsByTagNameNS: (ns, name) => (ns === SVG_NS ? nodes.filter((n) => n.name === name) : []),
  };
}

function publishDeps({ serialized = GOOD_SVG, children = ["metadata", "style", "path"], fail } = {}) {
  const calls = [];
  const svg = fakeSvg(children);
  const lib = {
    restore: (data) => ({ elements: data.elements, appState: { ...data.appState, theme: "light" }, files: data.files }),
    getNonDeletedElements: (els) => els.filter((e) => !e.isDeleted),
    exportToSvg: async (opts) => {
      calls.push(opts);
      if (fail) throw new Error(fail);
      return svg;
    },
  };
  return { calls, svg, deps: { loadExcalidraw: async () => lib, serialize: () => serialized } };
}

test("publish render: exports light, without background or inlined fonts, and drops metadata and style", async () => {
  const { calls, svg, deps } = publishDeps();
  const out = await createPublishRenderer({}, deps)("excalidraw", scene([rect, { ...rect, id: "gone", isDeleted: true }]));
  assert.equal(out, GOOD_SVG);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].elements.map((e) => e.id),
    ["r"]
  );
  assert.equal(calls[0].appState.exportWithDarkMode, false);
  assert.equal(calls[0].appState.exportBackground, false);
  assert.equal(calls[0].skipInliningFonts, true);
  assert.deepEqual(svg.removed.sort(), ["metadata", "style"]);
});

test("publish render: null for an empty or deleted-only scene, bad JSON, or an export that fails", async () => {
  const { calls, deps } = publishDeps();
  const render = createPublishRenderer({}, deps);
  assert.equal(await render("excalidraw", ""), null);
  assert.equal(await render("excalidraw", scene([])), null);
  assert.equal(await render("excalidraw", scene([{ ...rect, isDeleted: true }])), null);
  assert.equal(await render("excalidraw", "{nope"), null);
  assert.equal(calls.length, 0);
  assert.equal(await createPublishRenderer({}, publishDeps({ fail: "boom" }).deps)("excalidraw", scene([rect])), null);
  const noLib = { ...deps, loadExcalidraw: () => Promise.reject(new Error("failed to load Excalidraw")) };
  assert.equal(await createPublishRenderer({}, noLib)("excalidraw", scene([rect])), null);
});

test("publish render: null for an SVG that breaks the publishing rules (an embedded image)", async () => {
  const { deps } = publishDeps({ serialized: `<svg xmlns="${SVG_NS}"><image href="data:image/png;base64,AAAA"/></svg>` });
  assert.equal(await createPublishRenderer({}, deps)("excalidraw", scene([rect])), null);
});

test("isPublishableSvg refuses inlined fonts", () => {
  assert.equal(isPublishableSvg(GOOD_SVG), true);
  const fonts = `<svg xmlns="${SVG_NS}"><style>@font-face { font-family: Excalifont; src: url(data:font/woff2;base64,AAAA); }</style></svg>`;
  assert.equal(isPublishableSvg(fonts), false);
});

test("a real publish render (shapes, bound text, an arrow) passes the publishing service's allowlist", () => {
  const svg = readFileSync(new URL("./testdata/publish-shapes.svg", import.meta.url), "utf8");
  assert.equal(isPublishableSvg(svg), true);
  assert.deepEqual(checkSvg(svg), { ok: true });
});
