// Run with `npm test` (node --test) from the repo root. Covers the
// DOM-free parts: block helpers and the editor protocol session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkSvg } from "../../scripts/svg-allowlist.js";
import {
  activate,
  countDrawioBlocksBefore,
  createEditorSession,
  createPublishRenderer,
  drawDiagram,
  drawImagePlaceholder,
  droppedImagesCaption,
  DROPPED_IMAGE_ATTR,
  DROPPED_IMAGE_TITLE,
  exportDiagramSvg,
  hardenImages,
  hardenLabelSanitizer,
  localImageSrc,
  viewerPaths,
  isInlineImageSrc,
  LABEL_PURIFY_CONFIG,
  extractDrawioBlockAt,
  isPublishableSvg,
  replaceDrawioBlockAt,
} from "./index.js";

const twoBlocks = ["# Note", "", "```drawio", "<old-0/>", "```", "", "Text.", "", "```drawio", "<old-1/>", "```", ""].join("\n");

test("replaceDrawioBlockAt replaces only the Nth drawio block", () => {
  const out = replaceDrawioBlockAt(twoBlocks, 1, "<new-1/>");
  assert.match(out, /<old-0\/>/);
  assert.doesNotMatch(out, /<old-1\/>/);
  assert.match(out, /<new-1\/>/);
});

test("other fence languages don't count", () => {
  const body = "```mermaid\ngraph TD; A --> B\n```\n\n```drawio\n<old/>\n```";
  const out = replaceDrawioBlockAt(body, 0, "<new/>");
  assert.match(out, /graph TD; A --> B/);
  assert.match(out, /<new\/>/);
  assert.equal(countDrawioBlocksBefore(body, body.length), 1);
});

test("an out-of-range index throws instead of writing the wrong block", () => {
  assert.throws(() => replaceDrawioBlockAt("```drawio\n<a/>\n```\n", 1, "<b/>"), /no drawio block at index 1/);
});

test("CRLF bodies are read, and written back with LF fences", () => {
  const body = "# Note\r\n\r\n```drawio\r\n<old/>\r\n```\r\n";
  assert.equal(extractDrawioBlockAt(body, 0), "<old/>");
  assert.match(replaceDrawioBlockAt(body, 0, "<new/>"), /```drawio\n<new\/>\n```/);
});

test("extractDrawioBlockAt returns the Nth block, or empty when missing", () => {
  assert.equal(extractDrawioBlockAt(twoBlocks, 0), "<old-0/>");
  assert.equal(extractDrawioBlockAt(twoBlocks, 1), "<old-1/>");
  assert.equal(extractDrawioBlockAt(twoBlocks, 2), "");
  assert.equal(extractDrawioBlockAt("", 0), "");
});

test("countDrawioBlocksBefore gives a just-inserted block its ordinal", () => {
  const before = "```drawio\n<existing/>\n```\n\n";
  const body = before + "```drawio\n<new/>\n```\n";
  const index = countDrawioBlocksBefore(body, before.length);
  assert.equal(index, 1);
  assert.equal(extractDrawioBlockAt(body, index), "<new/>");
  assert.equal(countDrawioBlocksBefore(body, 0), 0);
});

test("the embed's edit button opens the editor tab for that block", () => {
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
  assert.deepEqual(opened, [["editor", note, "2"]]);
});

test("activate registers the embed and the editor tab", () => {
  const registered = {};
  activate({
    registerEmbed: (lang, r) => (registered.embed = [lang, r.label]),
    registerTabType: (t) => (registered.tab = [t.id, t.icon]),
    isEnabled: () => false,
  });
  assert.deepEqual(registered, { embed: ["drawio", "Draw.io diagram"], tab: ["editor", "◇"] });
});

test("a New diagram toolbar button inserts a drawio block", () => {
  const inserted = [];
  const toolbar = [];
  activate({
    registerEmbed: () => {},
    registerTabType: () => {},
    isEnabled: () => true,
    registerToolbarItem: (item) => toolbar.push(item),
    editor: { insertEmbed: (lang) => (inserted.push(lang), true) },
  });
  const btn = toolbar.find((i) => i.id === "new-diagram");
  assert.equal(btn.kind, "button");
  assert.equal(btn.label, "New diagram");
  btn.run({ vaultId: "v", noteId: "n", path: "n.md", title: "N" });
  assert.deepEqual(inserted, ["drawio"]);
});

test("New diagram toasts instead of inserting when there's no note editor open", () => {
  const toasts = [];
  const toolbar = [];
  activate({
    registerEmbed: () => {},
    registerTabType: () => {},
    isEnabled: () => true,
    registerToolbarItem: (item) => toolbar.push(item),
    editor: { insertEmbed: () => false },
    toast: (message) => toasts.push(message),
  });
  toolbar[0].run({ vaultId: "v", noteId: "n", path: "n.md", title: "N" });
  assert.deepEqual(toasts, ["Open a note in the editor first, then add the diagram."]);
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

// ---- editor session ------------------------------------------------------

function session(overrides = {}) {
  const log = { posted: [], written: [], errors: [], closed: 0 };
  let body = overrides.body ?? twoBlocks;
  const s = createEditorSession({
    index: overrides.index ?? 1,
    readBody: async () => body,
    writeBody:
      overrides.writeBody ??
      (async (next) => {
        body = next;
        log.written.push(next);
      }),
    post: (m) => log.posted.push(m),
    close: () => (log.closed += 1),
    onError: (m) => log.errors.push(m),
    debounceMs: 10,
  });
  return { s, log, body: () => body };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("init loads the addressed block with autosave on", async () => {
  const { s, log } = session();
  await s.handle({ event: "init" });
  assert.deepEqual(log.posted, [{ action: "load", xml: "<old-1/>", autosave: 1 }]);
});

test("a burst of autosaves becomes one save of the last state", async () => {
  const { s, log, body } = session();
  await s.handle({ event: "autosave", xml: "<a/>" });
  await s.handle({ event: "autosave", xml: "<b/>" });
  await s.handle({ event: "autosave", xml: "<c/>" });
  assert.equal(log.written.length, 0);
  await wait(30);
  assert.equal(log.written.length, 1);
  assert.equal(extractDrawioBlockAt(body(), 1), "<c/>");
  assert.equal(extractDrawioBlockAt(body(), 0), "<old-0/>");
});

test("an explicit save is immediate and supersedes a pending autosave", async () => {
  const { s, log, body } = session();
  await s.handle({ event: "autosave", xml: "<stale/>" });
  await s.handle({ event: "save", xml: "<saved/>" });
  await wait(30);
  assert.equal(log.written.length, 1);
  assert.equal(extractDrawioBlockAt(body(), 1), "<saved/>");
});

test("flush saves a pending autosave right away (tab switched away)", async () => {
  const { s, log } = session();
  await s.handle({ event: "autosave", xml: "<x/>" });
  await s.flush();
  assert.equal(log.written.length, 1);
  await wait(30);
  assert.equal(log.written.length, 1);
});

test("exit flushes, then closes the tab", async () => {
  const { s, log } = session();
  await s.handle({ event: "autosave", xml: "<x/>" });
  await s.handle({ event: "exit" });
  assert.equal(log.written.length, 1);
  assert.equal(log.closed, 1);
});

test("a save that can't find its block is reported, not silently dropped", async () => {
  const { s, log } = session({ index: 5 });
  await s.handle({ event: "save", xml: "<x/>" });
  assert.equal(log.written.length, 0);
  assert.match(log.errors[0], /Diagram save failed: .*no drawio block at index 5/);
});

test("a write failure is reported", async () => {
  const { s, log } = session({
    writeBody: async () => {
      throw new Error("disk full");
    },
  });
  await s.handle({ event: "save", xml: "<x/>" });
  assert.deepEqual(log.errors, ["Diagram save failed: disk full"]);
});

test("messages it doesn't know are ignored", async () => {
  const { s, log } = session();
  await s.handle({ event: "configure" });
  await s.handle(null);
  await s.handle({ event: "autosave" });
  await wait(30);
  assert.deepEqual(log, { posted: [], written: [], errors: [], closed: 0 });
});

// ---- preview -------------------------------------------------------------

// Just enough of a DOMParser result for drawDiagram.
function parsed(rootName, parseError) {
  const errorEl = parseError && {
    textContent: `This page contains the following errors:${parseError}Below is a rendering`,
    getElementsByTagName: (tag) => (tag === "div" ? [{ textContent: parseError }] : []),
  };
  return {
    documentElement: { nodeName: rootName },
    getElementsByTagName: (tag) => (tag === "parsererror" && errorEl ? [errorEl] : []),
  };
}

function fakeHolder() {
  const attrs = {};
  return { attrs, setAttribute: (k, v) => (attrs[k] = v) };
}

// A viewer whose drawn model holds `cells` ("vertex" | "edge" | "other").
function fakeViewer(cells, drawn = []) {
  const model = {
    getRoot: () => "root",
    getDescendants: () => cells,
    isVertex: (c) => c === "vertex",
    isEdge: (c) => c === "edge",
  };
  return {
    createViewerForElement: (el, done) => {
      drawn.push(el);
      done?.({ graph: { getModel: () => model } });
    },
  };
}

test("drawDiagram hands only its own element to the viewer, drawing it now", () => {
  const drawn = [];
  const holder = fakeHolder();
  assert.equal(drawDiagram(holder, "<mxfile/>", fakeViewer(["vertex"], drawn), () => parsed("mxfile")), true);
  assert.deepEqual(drawn, [holder]);
  // Without this the viewer waits for the (0px-wide) holder to get a width.
  assert.deepEqual(JSON.parse(holder.attrs["data-mxgraph"]), { xml: "<mxfile/>", "check-visible-state": false });
});

test("drawDiagram returns false for a diagram with no shapes", () => {
  assert.equal(drawDiagram(fakeHolder(), "<mxGraphModel/>", fakeViewer(["other", "other"]), () => parsed("mxGraphModel")), false);
  assert.equal(drawDiagram(fakeHolder(), "<mxGraphModel/>", fakeViewer(["other", "edge"]), () => parsed("mxGraphModel")), true);
});

test("drawDiagram reports a viewer that didn't load", () => {
  assert.throws(() => drawDiagram(fakeHolder(), "<mxfile/>", undefined, () => parsed("mxfile")), /viewer didn't load/);
});

test("drawDiagram reports XML that doesn't parse, with the parser's message", () => {
  const viewer = { createViewerForElement: () => assert.fail("should not draw") };
  assert.throws(
    () => drawDiagram(fakeHolder(), "<mxfile", viewer, () => parsed("mxfile", "error on line 1 at column 8")),
    /isn't valid XML: error on line 1 at column 8$/
  );
});

test("drawDiagram reports XML that isn't a diagram", () => {
  const viewer = { createViewerForElement: () => assert.fail("should not draw") };
  assert.throws(() => drawDiagram(fakeHolder(), "<svg/>", viewer, () => parsed("svg")), /found <svg>/);
});

test("drawDiagram lets the viewer's own errors through", () => {
  const viewer = {
    createViewerForElement: () => {
      throw new Error("Cannot read properties of null");
    },
  };
  assert.throws(() => drawDiagram(fakeHolder(), "<mxfile/>", viewer, () => parsed("mxfile")), /Cannot read properties/);
});

// ---- published pages ------------------------------------------------------

test("activate registers a publish renderer for drawio fences when the host has the hook", () => {
  const registered = [];
  activate({
    registerEmbed: () => {},
    registerTabType: () => {},
    isEnabled: () => false,
    registerPublishRenderer: (languages, render) => (registered.push([languages, typeof render]), { dispose() {} }),
  });
  assert.deepEqual(registered, [[["drawio"], "function"]]);
});

const SVG_NS = "http://www.w3.org/2000/svg";
const GOOD_SVG = `<svg xmlns="${SVG_NS}"><g><rect width="1" height="1"/><text>Box</text></g></svg>`;

// Enough of draw.io's export root for exportDiagramSvg: attributes and a
// list of <a> elements to unwrap.
function fakeSvgRoot(links = []) {
  const attrs = { style: "background: transparent;" };
  const root = {
    attrs,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => (attrs[k] = v),
    getElementsByTagNameNS: (ns, tag) => (ns === SVG_NS && tag === "a" ? links : []),
    ownerDocument: {
      createElementNS: (ns, tag) => {
        const el = { ns, tag, attrs: {}, children: [] };
        el.setAttribute = (k, v) => (el.attrs[k] = v);
        el.appendChild = (c) => el.children.push(c);
        return el;
      },
    },
  };
  return root;
}

function fakeLink(attrs, children) {
  const link = { attrs, kids: [...children] };
  link.getAttribute = (k) => attrs[k] ?? null;
  Object.defineProperty(link, "firstChild", { get: () => link.kids[0] ?? null });
  link.parentNode = { replaced: null, replaceChild: (next, old) => (link.parentNode.replaced = [next, old]) };
  // What the group's appendChild does to the link: moves its first child out.
  link.moveOut = () => link.kids.shift();
  return link;
}

// A draw.io Graph whose getSvg draws one HTML label: the label sets
// allowConvertHtmlToSvg from its style first (false here), then, when the
// conversion is off, falls back to a <foreignObject>.
function fakeGraph({ cells = ["vertex"], root = fakeSvgRoot(), log = [] } = {}) {
  const model = {
    getRoot: () => "root",
    getDescendants: () => cells,
    isVertex: (c) => c === "vertex",
    isEdge: (c) => c === "edge",
  };
  const graph = {
    log,
    destroyed: 0,
    getModel: () => model,
    createSvgCanvas() {
      const canvas = {
        allowConvertHtmlToSvg: false,
        state: { dx: 1, dy: 2 },
        addForeignObject() {
          log.push("foreignObject");
        },
        plainText(x, y, w, h, str) {
          log.push(["plainText", x, y, str]);
        },
      };
      return canvas;
    },
    getSvg(...args) {
      log.push(["getSvg", args[0], args[12], args[15]]);
      const canvas = this.createSvgCanvas();
      canvas.allowConvertHtmlToSvg = false;
      if (canvas.allowConvertHtmlToSvg) log.push("converted");
      canvas.addForeignObject(0, 0, 10, 10, "<b>Hi</b>", "center", "middle", true, "html", null, false, 0, null, { childNodes: ["Hi"] });
      return root;
    },
    destroy() {
      graph.destroyed += 1;
    },
  };
  return graph;
}

const mxUtils = { extractTextWithWhitespace: (nodes) => nodes.join("") };

test("exportDiagramSvg converts every HTML label to SVG text, and an unconvertible one to plain text", () => {
  const graph = fakeGraph();
  const originalCanvas = graph.createSvgCanvas;
  const root = exportDiagramSvg(graph, mxUtils);
  assert.deepEqual(graph.log, [
    // transparent, whole diagram, links off
    ["getSvg", null, "diagram", true],
    "converted",
    ["plainText", 1, 2, "Hi"],
  ]);
  assert.equal(graph.createSvgCanvas, originalCanvas, "the graph's own canvas factory is put back");
  assert.equal(root.attrs.style, "background: transparent; color-scheme: light;");
});

test("exportDiagramSvg turns a cell's link into a plain group", () => {
  const child = { name: "shape" };
  const link = fakeLink({ "xlink:href": "https://example.com", transform: "t", style: "pointer-events: none;" }, [child]);
  const root = fakeSvgRoot([link]);
  // The group's appendChild moves the child out of the link, as the DOM does.
  const createElementNS = root.ownerDocument.createElementNS;
  root.ownerDocument.createElementNS = (ns, tag) => {
    const el = createElementNS(ns, tag);
    el.appendChild = (c) => (link.moveOut(), el.children.push(c));
    return el;
  };
  exportDiagramSvg(fakeGraph({ root }), mxUtils);
  const [group, old] = link.parentNode.replaced;
  assert.equal(old, link);
  assert.deepEqual([group.ns, group.tag, group.attrs, group.children], [SVG_NS, "g", { transform: "t" }, [child]]);
});

function fakeDocument() {
  const doc = { added: [], removed: [] };
  doc.createElement = (tag) => {
    const el = { tag, attrs: {}, setAttribute: (k, v) => (el.attrs[k] = v), remove: () => doc.removed.push(el) };
    return el;
  };
  doc.body = { appendChild: (el) => doc.added.push(el) };
  return doc;
}

function publishDeps({ graph = fakeGraph(), serialized = GOOD_SVG, viewer, root = "mxGraphModel", parseError } = {}) {
  const doc = fakeDocument();
  const v = viewer ?? { createViewerForElement: (el, done) => done({ graph }) };
  return {
    doc,
    graph,
    deps: {
      document: doc,
      loadViewer: async () => ({ viewer: v, mxUtils }),
      parseXml: () => parsed(root, parseError),
      serialize: () => serialized,
    },
  };
}

test("publish render: draws off screen, returns the serialized SVG and leaves nothing behind", async () => {
  const { doc, graph, deps } = publishDeps();
  const svg = await createPublishRenderer({}, deps)("drawio", "<mxGraphModel/>");
  assert.equal(svg, GOOD_SVG);
  assert.equal(doc.added.length, 1);
  assert.deepEqual(doc.removed, doc.added);
  assert.match(doc.added[0].attrs.style, /visibility:hidden/);
  assert.equal(graph.destroyed, 1);
});

test("publish render: null for an empty source, an empty diagram, bad XML, or a viewer that fails", async () => {
  assert.equal(await createPublishRenderer({}, publishDeps().deps)("drawio", "  \n"), null);
  const empty = publishDeps({ graph: fakeGraph({ cells: ["other"] }) });
  assert.equal(await createPublishRenderer({}, empty.deps)("drawio", "<mxGraphModel/>"), null);
  assert.deepEqual(empty.doc.removed, empty.doc.added);
  const bad = publishDeps({ parseError: "error on line 1" });
  assert.equal(await createPublishRenderer({}, bad.deps)("drawio", "<mxGraph"), null);
  assert.deepEqual(bad.doc.removed, bad.doc.added);
  const notDiagram = publishDeps({ root: "svg" });
  assert.equal(await createPublishRenderer({}, notDiagram.deps)("drawio", "<svg/>"), null);
  const throwing = publishDeps({
    viewer: {
      createViewerForElement: () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal(await createPublishRenderer({}, throwing.deps)("drawio", "<mxfile/>"), null);
  assert.deepEqual(throwing.doc.removed, throwing.doc.added);
  const noViewer = { ...publishDeps().deps, loadViewer: () => Promise.reject(new Error("failed to load draw.io's viewer")) };
  assert.equal(await createPublishRenderer({}, noViewer)("drawio", "<mxfile/>"), null);
});

test("publish render: null for an SVG that breaks the publishing rules (an image shape)", async () => {
  const { deps } = publishDeps({ serialized: `<svg xmlns="${SVG_NS}"><image href="https://example.com/x.png"/></svg>` });
  assert.equal(await createPublishRenderer({}, deps)("drawio", "<mxGraphModel/>"), null);
});

test("real publish renders (HTML labels, a linked cell) pass the publishing service's allowlist", () => {
  for (const name of ["labels", "link"]) {
    const svg = readFileSync(new URL(`./testdata/publish-${name}.svg`, import.meta.url), "utf8");
    assert.equal(svg.includes("foreignObject"), false, name);
    assert.equal(isPublishableSvg(svg), true, name);
    assert.deepEqual(checkSvg(svg), { ok: true }, name);
  }
});

// ---- label sanitizing -----------------------------------------------------

// A window with draw.io's sanitizer and a DOMPurify factory that records
// what the second pass is given.
function fakeLabelWindow({ supported = true } = {}) {
  const calls = { factory: [], hooks: [], sanitize: [] };
  const win = {
    Graph: { sanitizeHtml: (value) => `drawio(${value})` },
    DOMPurify(w) {
      calls.factory.push(w);
      return {
        isSupported: supported,
        addHook: (name, fn) => calls.hooks.push({ name, fn }),
        sanitize: (value, config) => {
          calls.sanitize.push({ value, config });
          return `strict(${value})`;
        },
      };
    },
  };
  return { win, calls };
}

function fakeImg(src) {
  const node = { nodeName: "IMG", removed: false, getAttribute: (n) => (n === "src" ? src : null) };
  node.remove = () => (node.removed = true);
  return node;
}

test("labels get draw.io's sanitizer, then the strict second pass on a fresh DOMPurify", () => {
  const { win, calls } = fakeLabelWindow();
  hardenLabelSanitizer(win);
  assert.equal(win.Graph.sanitizeHtml("<b>x</b>"), "strict(drawio(<b>x</b>))");
  assert.deepEqual(calls.factory, [win]);
  assert.equal(calls.sanitize[0].config, LABEL_PURIFY_CONFIG);
});

test("the second pass keeps formatting but no links, media or data attributes", () => {
  const { ALLOWED_TAGS, ALLOWED_ATTR } = LABEL_PURIFY_CONFIG;
  for (const tag of ["b", "i", "u", "br", "font", "span", "div", "ul", "li", "table", "img"]) assert.ok(ALLOWED_TAGS.includes(tag), tag);
  for (const tag of ["a", "video", "audio", "source", "iframe", "object", "svg", "style", "form", "input", "link", "meta", "base"]) {
    assert.ok(!ALLOWED_TAGS.includes(tag), tag);
  }
  for (const attr of ["href", "xlink:href", "srcset", "poster", "action", "formaction", "target", "class", "id"]) assert.ok(!ALLOWED_ATTR.includes(attr), attr);
  assert.ok(!ALLOWED_ATTR.some((a) => /^on/i.test(a)));
  assert.equal(LABEL_PURIFY_CONFIG.ALLOW_DATA_ATTR, false);
});

test("an image in a label keeps only an inline data: source", () => {
  const { win, calls } = fakeLabelWindow();
  hardenLabelSanitizer(win);
  const hook = calls.hooks.find((h) => h.name === "afterSanitizeAttributes").fn;
  const kept = ["data:image/png;base64,AAAA", "data:image/svg+xml;base64,PHN2Zz4=", " DATA:image/gif,x", "data:image/jpeg;base64,x"];
  for (const src of kept) {
    const img = fakeImg(src);
    hook(img);
    assert.equal(img.removed, false, src);
  }
  const removed = ["https://example.com/p.png", "//example.com/p.png", "/files/x.png", "x", "", null, "data:text/html,<b>", "data:image/png", "javascript:alert(1)"];
  for (const src of removed) {
    const img = fakeImg(src);
    hook(img);
    assert.equal(img.removed, true, String(src));
  }
  const span = { nodeName: "SPAN", getAttribute: () => null, remove: () => assert.fail("only images are removed") };
  hook(span);
  assert.equal(isInlineImageSrc("data:image/webp;base64,x"), true);
});

test("hardening is applied once, however often the viewer loads", () => {
  const { win, calls } = fakeLabelWindow();
  hardenLabelSanitizer(win);
  const strict = win.Graph.sanitizeHtml;
  hardenLabelSanitizer(win);
  assert.equal(win.Graph.sanitizeHtml, strict);
  assert.equal(calls.factory.length, 1);
  assert.equal(win.Graph.sanitizeHtml("x"), "strict(drawio(x))");
});

test("a viewer without draw.io's sanitizer or a working DOMPurify fails instead of drawing", () => {
  assert.throws(() => hardenLabelSanitizer({}), /sanitizer didn't load/);
  assert.throws(() => hardenLabelSanitizer({ Graph: {} }), /sanitizer didn't load/);
  assert.throws(() => hardenLabelSanitizer({ Graph: { sanitizeHtml: (v) => v } }), /isn't supported/);
  const { win } = fakeLabelWindow({ supported: false });
  const original = win.Graph.sanitizeHtml;
  assert.throws(() => hardenLabelSanitizer(win), /isn't supported/);
  assert.equal(win.Graph.sanitizeHtml, original);
});

// ---- images in shapes -------------------------------------------------------

const WEBAPP_BASE = "http://127.0.0.1:4100/mahfouz/drawio/webapp/drawio-31.4.6/src/main/webapp/";

test("an image keeps an inline source or one of the plugin's own draw.io files", () => {
  assert.equal(localImageSrc("data:image/png;base64,AAAA", WEBAPP_BASE), "data:image/png;base64,AAAA");
  assert.equal(localImageSrc(" data:image/svg+xml;base64,PHN2Zz4= ", WEBAPP_BASE), "data:image/svg+xml;base64,PHN2Zz4=");
  // Library clip art is written relative; it resolves to the web app.
  assert.equal(localImageSrc("img/lib/clip_art/computers/Server_Tower_128x128.png", WEBAPP_BASE), `${WEBAPP_BASE}img/lib/clip_art/computers/Server_Tower_128x128.png`);
  assert.equal(localImageSrc(`${WEBAPP_BASE}images/x.svg`, WEBAPP_BASE), `${WEBAPP_BASE}images/x.svg`);
});

test("any other image source is never requested", () => {
  const refused = [
    "https://example.com/pixel.png",
    "http://example.com/pixel.png",
    "//example.com/pixel.png",
    "/files/x.png",
    "../../../x.png",
    "img/../../../../x.png",
    "http://127.0.0.1:4100/mahfouz/drawio/webapp/other.png",
    "http://127.0.0.1:4100.evil.example/mahfouz/drawio/webapp/drawio-31.4.6/src/main/webapp/x.png",
    "javascript:alert(1)",
    "data:text/html,<b>",
    "data:image/png",
    "blob:http://127.0.0.1:4100/abc",
    "file:///etc/passwd",
    "",
    "   ",
    null,
    undefined,
  ];
  for (const src of refused) assert.equal(localImageSrc(src, WEBAPP_BASE), null, String(src));
});

// Just enough of an mxSvgCanvas2D and its SVG root for the placeholder: each
// primitive that draws appends a node, as the real canvas's addNode does.
function fakeCanvas() {
  const calls = [];
  const el = (name) => ({ name, attrs: {}, children: [], textContent: "", setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) {
    if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
    c.parent = this;
    this.children.push(c);
  } });
  const root = el("g");
  root.ownerDocument = { createElementNS: (_ns, name) => el(name) };
  Object.defineProperty(root, "childNodes", { get: () => root.children });
  root.appendChild(el("rect-before"));
  const canvas = { root, calls };
  for (const name of ["save", "restore", "setStrokeColor", "setStrokeWidth", "setFillColor", "setDashed", "setDashPattern", "rect", "ellipse", "begin", "moveTo", "lineTo"]) {
    canvas[name] = (...args) => calls.push([name, ...args]);
  }
  for (const name of ["stroke", "fill"]) {
    canvas[name] = () => {
      calls.push([name]);
      root.appendChild(el(name));
    };
  }
  return canvas;
}

test("a dropped image draws a dashed outline its size, with an icon, grouped under a title", () => {
  const canvas = fakeCanvas();
  drawImagePlaceholder(canvas, 10, 20, 80, 70);
  assert.deepEqual(canvas.calls.find((c) => c[0] === "rect"), ["rect", 10, 20, 80, 70]);
  assert.ok(canvas.calls.some((c) => c[0] === "setDashed" && c[1] === true));
  assert.ok(canvas.calls.some((c) => c[0] === "ellipse"), "the icon is drawn");
  assert.equal(canvas.calls[0][0], "save");
  assert.equal(canvas.calls.at(-1)[0], "restore");
  // What was there before stays; everything the placeholder drew is grouped.
  const [before, group] = canvas.root.children;
  assert.equal(canvas.root.children.length, 2);
  assert.equal(before.name, "rect-before");
  assert.equal(group.name, "g");
  assert.equal(group.attrs[DROPPED_IMAGE_ATTR], "");
  assert.equal(group.children[0].name, "title");
  assert.equal(group.children[0].textContent, DROPPED_IMAGE_TITLE);
  assert.deepEqual(group.children.slice(1).map((c) => c.name), ["stroke", "stroke", "stroke", "fill"]);
});

test("a dropped image too small for the icon keeps just its outline", () => {
  const canvas = fakeCanvas();
  drawImagePlaceholder(canvas, 0, 0, 6, 40);
  assert.equal(canvas.calls.filter((c) => c[0] === "rect").length, 1);
  assert.ok(!canvas.calls.some((c) => c[0] === "ellipse"));
});

function fakeImageWindow() {
  const drawn = [];
  function Canvas() {
    Object.assign(this, fakeCanvas());
  }
  Canvas.prototype.image = function (...args) {
    drawn.push(args);
  };
  return { win: { mxSvgCanvas2D: Canvas }, drawn };
}

test("the canvas draws an allowed image resolved, and a placeholder for any other", () => {
  const { win, drawn } = fakeImageWindow();
  hardenImages(win, WEBAPP_BASE);
  const canvas = new win.mxSvgCanvas2D();
  canvas.image(1, 2, 3, 4, "img/lib/a.png", true, false, true, "inset(1px)", "x");
  assert.deepEqual(drawn, [[1, 2, 3, 4, `${WEBAPP_BASE}img/lib/a.png`, true, false, true, "inset(1px)", "x"]]);
  canvas.image(5, 6, 70, 80, "https://tracker.example/p.png");
  assert.equal(drawn.length, 1, "the remote image is never handed to draw.io");
  assert.equal(canvas.root.children.at(-1).attrs[DROPPED_IMAGE_ATTR], "");
});

test("images are hardened once, and a viewer without the canvas fails instead of drawing", () => {
  const { win, drawn } = fakeImageWindow();
  hardenImages(win, WEBAPP_BASE);
  const local = win.mxSvgCanvas2D.prototype.image;
  hardenImages(win, WEBAPP_BASE);
  assert.equal(win.mxSvgCanvas2D.prototype.image, local);
  new win.mxSvgCanvas2D().image(0, 0, 1, 1, "data:image/gif,x");
  assert.equal(drawn.length, 1);
  assert.throws(() => hardenImages({}, WEBAPP_BASE), /image drawing didn't load/);
  assert.throws(() => hardenImages({ mxSvgCanvas2D: function () {} }, WEBAPP_BASE), /image drawing didn't load/);
});

test("the viewer looks for its own files in the plugin, never on draw.io's servers", () => {
  const paths = viewerPaths(WEBAPP_BASE);
  // The viewer resolves library images as DRAWIO_BASE_URL + "/" + path.
  assert.equal(`${paths.DRAWIO_BASE_URL}/img/lib/a.png`, `${WEBAPP_BASE}img/lib/a.png`);
  for (const [name, value] of Object.entries(paths)) {
    assert.ok(`${value}/`.startsWith(WEBAPP_BASE), name);
    assert.doesNotMatch(value, /diagrams\.net|draw\.io/, name);
  }
  for (const name of ["GRAPH_IMAGE_PATH", "STENCIL_PATH", "SHAPES_PATH", "DRAW_MATH_URL", "PROXY_URL"]) assert.ok(name in paths, name);
});

test("the preview's caption counts the images it left out", () => {
  assert.equal(droppedImagesCaption(0), null);
  assert.equal(droppedImagesCaption(1), "1 image from the web isn’t shown in previews.");
  assert.equal(droppedImagesCaption(2), "2 images from the web aren’t shown in previews.");
});
