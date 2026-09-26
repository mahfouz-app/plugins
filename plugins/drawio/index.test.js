// Run with `npm test` (node --test) from the repo root. Covers the
// DOM-free parts: block helpers and the editor protocol session.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activate,
  countDrawioBlocksBefore,
  createEditorSession,
  drawDiagram,
  extractDrawioBlockAt,
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
  });
  assert.deepEqual(registered, { embed: ["drawio", "Draw.io diagram"], tab: ["editor", "◇"] });
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
