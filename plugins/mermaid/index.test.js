// Run with `npm test` (node --test) from the repo root. No dependencies:
// the host and the DOM container are small fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activate,
  createEditorSession,
  createMermaidRenderer,
  createMermaidRuntime,
  mermaidModuleUrl,
  parseErrorLocation,
} from "./index.js";

function fakeHost() {
  const host = {
    plugin: { baseUrl: "http://plugins.test/mahfouz/mermaid/" },
    embeds: new Map(),
    panZoomed: [],
    registerEmbed(language, renderer) {
      host.embeds.set(language, renderer);
      return { dispose() {} };
    },
    ui: {
      showError(container, message) {
        container.innerHTML = "";
        container.error = message;
      },
      attachPanZoom(container) {
        host.panZoomed.push(container);
        return () => {
          container.panZoomUndone = true;
        };
      },
    },
  };
  return host;
}

function fakeContainer({ clientWidth = 500, renderedWidth = 100 } = {}) {
  return {
    innerHTML: "",
    textContent: "",
    error: null,
    clientWidth,
    get firstElementChild() {
      return this.innerHTML ? { scrollWidth: renderedWidth } : null;
    },
  };
}

function fakeMermaid(render = async () => ({ svg: "<svg>diagram</svg>" })) {
  const calls = { initialize: [], render: 0 };
  return {
    calls,
    initialize(config) {
      calls.initialize.push(config);
    },
    render(...args) {
      calls.render += 1;
      return render(...args);
    },
  };
}

test("activate registers the mermaid fence language", () => {
  const host = fakeHost();
  activate(host);
  assert.equal(host.embeds.get("mermaid").label, "Mermaid diagram");
});

test("mounts the rendered SVG, no error box", async () => {
  const mermaid = fakeMermaid();
  const renderer = createMermaidRenderer(fakeHost(), { loadModule: async () => mermaid });
  const c = fakeContainer();
  await renderer.render(c, "graph TD;\nA-->B;", "light");
  assert.match(c.innerHTML, /<svg>diagram<\/svg>/);
  assert.equal(c.error, null);
});

test("shows the parse error in the app's error box", async () => {
  const mermaid = fakeMermaid(async () => {
    throw new Error("Parse error on line 1");
  });
  const renderer = createMermaidRenderer(fakeHost(), { loadModule: async () => mermaid });
  const c = fakeContainer();
  await renderer.render(c, "not valid", "light");
  assert.equal(c.error, "Parse error on line 1");
});

test("initializes with the matching theme, and only again when it changes", async () => {
  const mermaid = fakeMermaid();
  const renderer = createMermaidRenderer(fakeHost(), { loadModule: async () => mermaid });
  await renderer.render(fakeContainer(), "a", "dark");
  await renderer.render(fakeContainer(), "b", "dark");
  assert.deepEqual(mermaid.calls.initialize, [
    { startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "dark" },
  ]);
  await renderer.render(fakeContainer(), "c", "light");
  assert.equal(mermaid.calls.initialize.at(-1).theme, "default");
});

test("a render that never settles degrades to an error instead of hanging", async () => {
  const mermaid = fakeMermaid(() => new Promise(() => {}));
  const renderer = createMermaidRenderer(fakeHost(), { loadModule: async () => mermaid, timeoutMs: 20 });
  const c = fakeContainer();
  await renderer.render(c, "a", "light");
  assert.match(c.error, /timed out/i);
});

test("a module load that never settles times out and frees the queue", async () => {
  let loads = 0;
  const mermaid = fakeMermaid();
  const runtime = createMermaidRuntime(fakeHost(), {
    loadModule: () => {
      loads += 1;
      return loads === 1 ? new Promise(() => {}) : Promise.resolve(mermaid);
    },
    timeoutMs: 20,
  });
  await assert.rejects(runtime.renderSvg("a", "light"), /timed out/i);
  assert.equal(await runtime.renderSvg("b", "light"), "<svg>diagram</svg>");
  assert.equal(loads, 2);
});

test("loads the module once, but retries after a failed load", async () => {
  let loads = 0;
  const mermaid = fakeMermaid();
  const renderer = createMermaidRenderer(fakeHost(), {
    loadModule: async () => {
      loads += 1;
      if (loads === 1) throw new Error("network down");
      return mermaid;
    },
  });
  const first = fakeContainer();
  await renderer.render(first, "a", "light");
  assert.equal(first.error, "network down");
  await renderer.render(fakeContainer(), "b", "light");
  await renderer.render(fakeContainer(), "c", "light");
  assert.equal(loads, 2);
});

test("the vendored build is served from the plugin's own URL", () => {
  assert.equal(
    mermaidModuleUrl("http://plugins.test/mahfouz/mermaid/"),
    "http://plugins.test/mahfouz/mermaid/vendor/package/dist/mermaid.esm.min.mjs"
  );
});

test("wide diagrams get pan/zoom, undone on dispose", async () => {
  const host = fakeHost();
  const renderer = createMermaidRenderer(host, { loadModule: async () => fakeMermaid() });
  const wide = fakeContainer({ clientWidth: 100, renderedWidth: 900 });
  await renderer.render(wide, "a", "light");
  assert.deepEqual(host.panZoomed, [wide]);
  renderer.dispose(wide);
  assert.equal(wide.panZoomUndone, true);

  const narrow = fakeContainer();
  await renderer.render(narrow, "b", "light");
  assert.equal(host.panZoomed.length, 1);
});

test("the init cache is keyed on the whole config, not the theme name", async () => {
  const mermaid = fakeMermaid();
  const runtime = createMermaidRuntime(fakeHost(), { loadModule: async () => mermaid });
  // Both map to mermaid's "default" theme: same config, so no re-initialize.
  await runtime.renderSvg("a", "light");
  await runtime.renderSvg("b", "sepia");
  assert.equal(mermaid.calls.initialize.length, 1);
  await runtime.renderSvg("c", "dark");
  await runtime.renderSvg("d", "light");
  assert.equal(mermaid.calls.initialize.length, 3);
});

test("renderSvg resolves to the SVG markup", async () => {
  const runtime = createMermaidRuntime(fakeHost(), { loadModule: async () => fakeMermaid() });
  assert.equal(runtime.isLoaded(), false);
  assert.equal(await runtime.renderSvg("graph TD;\nA-->B;", "light"), "<svg>diagram</svg>");
  assert.equal(runtime.isLoaded(), true);
});

test("renders run one at a time, so a re-initialize can't change a render in flight", async () => {
  const log = [];
  let releaseFirst;
  const mermaid = fakeMermaid((id, source) => {
    log.push(`render ${source}`);
    if (source === "first") return new Promise((resolve) => (releaseFirst = () => resolve({ svg: "<svg>1</svg>" })));
    return Promise.resolve({ svg: "<svg>2</svg>" });
  });
  const init = mermaid.initialize;
  mermaid.initialize = (config) => {
    log.push(`init ${config.theme}`);
    init(config);
  };
  const runtime = createMermaidRuntime(fakeHost(), { loadModule: async () => mermaid });
  const first = runtime.renderSvg("first", "light");
  const second = runtime.renderSvg("second", "dark");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ["init default", "render first"]);
  releaseFirst();
  assert.equal(await first, "<svg>1</svg>");
  assert.equal(await second, "<svg>2</svg>");
  assert.deepEqual(log, ["init default", "render first", "init dark", "render second"]);
});

test("a hung render times out and doesn't block the next one", async () => {
  const mermaid = fakeMermaid((id, source) =>
    source === "hang" ? new Promise(() => {}) : Promise.resolve({ svg: "<svg>ok</svg>" })
  );
  const runtime = createMermaidRuntime(fakeHost(), { loadModule: async () => mermaid, timeoutMs: 20 });
  await assert.rejects(runtime.renderSvg("hang", "light"), /timed out/i);
  assert.equal(await runtime.renderSvg("fine", "light"), "<svg>ok</svg>");
});

test("the embed and its runtime share one mermaid instance", async () => {
  let loads = 0;
  const mermaid = fakeMermaid();
  const runtime = createMermaidRuntime(fakeHost(), {
    loadModule: async () => {
      loads += 1;
      return mermaid;
    },
  });
  const renderer = createMermaidRenderer(fakeHost(), { runtime });
  await renderer.render(fakeContainer(), "a", "light");
  await runtime.renderSvg("b", "light");
  assert.equal(loads, 1);
  assert.equal(mermaid.calls.initialize.length, 1);
});

test("a stale render result is dropped, never mounted", async () => {
  let releaseFirst;
  const mermaid = fakeMermaid((id, source) =>
    source === "old"
      ? new Promise((resolve) => (releaseFirst = () => resolve({ svg: "<svg>old</svg>" })))
      : Promise.resolve({ svg: "<svg>new</svg>" })
  );
  const renderer = createMermaidRenderer(fakeHost(), { loadModule: async () => mermaid });
  const mounted = [];
  const c = fakeContainer();
  let html = "";
  Object.defineProperty(c, "innerHTML", {
    get: () => html,
    set: (value) => {
      html = value;
      mounted.push(value);
    },
  });
  const older = renderer.render(c, "old", "light");
  const newer = renderer.render(c, "new", "light");
  await new Promise((r) => setTimeout(r, 10));
  releaseFirst();
  await Promise.all([older, newer]);
  assert.deepEqual(mounted, ["<svg>new</svg>"]);
});

test("a stale render's error is dropped too", async () => {
  let failFirst;
  const mermaid = fakeMermaid((id, source) =>
    source === "old"
      ? new Promise((_, reject) => (failFirst = () => reject(new Error("old error"))))
      : Promise.resolve({ svg: "<svg>new</svg>" })
  );
  const renderer = createMermaidRenderer(fakeHost(), { loadModule: async () => mermaid });
  const c = fakeContainer();
  const older = renderer.render(c, "old", "light");
  const newer = renderer.render(c, "new", "light");
  await new Promise((r) => setTimeout(r, 10));
  failFirst();
  await Promise.all([older, newer]);
  assert.equal(c.error, null);
  assert.equal(c.innerHTML, "<svg>new</svg>");
});

// ---- parseErrorLocation ----------------------------------------------------
//
// The three error shapes below were captured from the pinned build
// (mermaid-12.0.0.tgz, sha256 as in plugin.json) by running `mermaid.parse`
// under node on the source shown with each.

// graph TD\n  A --> B\n  B --> --> C  (flowchart: jison parser)
function jisonError() {
  const err = new Error(
    "Parse error on line 3:\n...D  A --> B  B --> --> C\n---------------------^\n" +
      "Expecting 'AMP', 'COLON', 'PIPE', 'TESTSTR', 'DOWN', 'DEFAULT', 'NUM', 'COMMA', " +
      "'NODE_STRING', 'BRKT', 'MINUS', 'MULT', 'UNICODE_TEXT', got 'LINK'"
  );
  err.hash = {
    text: "--> ",
    token: "LINK",
    line: 2,
    loc: { first_line: 3, last_line: 3, first_column: 3, last_column: 8 },
    expected: ["'AMP'", "'COLON'"],
  };
  return err;
}

// pie title Pets\n  "Dogs" : 386\n  "Cats" 85  (pie: langium parser)
// mermaid's own class; its instances keep `name` "Error" and carry `result`.
class MermaidParseError extends Error {}

function langiumError() {
  const err = new MermaidParseError(
    "Parsing failed:  Parse error on line 3, column 10: Expecting token of type ':' but found `85`."
  );
  err.result = {};
  return err;
}

// notADiagram\n  foo
function unknownDiagramError() {
  const err = new Error("No diagram type detected matching given configuration for text: notADiagram\n  foo");
  err.name = "UnknownDiagramError";
  return err;
}

test("parseErrorLocation: jison loc, columns made 1-based, end exclusive", () => {
  assert.deepEqual(parseErrorLocation(jisonError()), { line: 3, column: 4, endColumn: 9 });
});

test("parseErrorLocation: jison loc spanning lines keeps only the start", () => {
  const err = jisonError();
  err.hash.loc = { first_line: 2, last_line: 4, first_column: 5, last_column: 1 };
  assert.deepEqual(parseErrorLocation(err), { line: 2, column: 6 });
});

test("parseErrorLocation: falls back to jison's 0-based hash.line", () => {
  const err = jisonError();
  delete err.hash.loc;
  assert.deepEqual(parseErrorLocation(err), { line: 3 });
});

test("parseErrorLocation: langium's line and column, read from the message", () => {
  assert.deepEqual(parseErrorLocation(langiumError()), { line: 3, column: 10 });
});

test("parseErrorLocation: jison's lexer error, 0-based hash.line", () => {
  // Built from the lexer's parseError call in the vendored build (no
  // reachable input triggered one).
  const err = new Error("Lexical error on line 4. Unrecognized text.\n...A --> B\n-----^");
  err.hash = { text: "", token: null, line: 3 };
  assert.deepEqual(parseErrorLocation(err), { line: 4 });
});

test("parseErrorLocation: langium's lexer error", () => {
  const err = new MermaidParseError(
    "Parsing failed: Lexer error on line 3, column 3: unexpected character: ->^<- at offset: 16, skipped 3 characters. "
  );
  assert.deepEqual(parseErrorLocation(err), { line: 3, column: 3 });
});

test("parseErrorLocation: a semantic error quoting the user's text has no location", () => {
  // sequenceDiagram\n  A->>B: hi\n  deactivate line 4 — captured: mermaid
  // attaches a placeholder hash (line "1", loc all 1s) to its own errors.
  const err = new Error("Trying to inactivate an inactive participant (line 4)");
  err.hash = {
    text: "->>-",
    token: "->>-",
    line: "1",
    loc: { first_line: 1, last_line: 1, first_column: 1, last_column: 1 },
    expected: ["'ACTIVE_PARTICIPANT'"],
  };
  assert.equal(parseErrorLocation(err), null);
  assert.equal(parseErrorLocation(new Error("Task overdue: deadline 3")), null);
  assert.equal(parseErrorLocation(new Error("Bad outline 2")), null);
  assert.equal(parseErrorLocation(new Error("Not a Parse error on line 2")), null);
});

test("parseErrorLocation: an unknown diagram has no location", () => {
  assert.equal(parseErrorLocation(unknownDiagramError()), null);
  // The message quotes the user's text, which must not be read as a location.
  const quoting = unknownDiagramError();
  quoting.message = "No diagram type detected matching given configuration for text: flowhcart TD\n  A[line 2]";
  assert.equal(parseErrorLocation(quoting), null);
});

test("parseErrorLocation: anything else has no location", () => {
  assert.equal(parseErrorLocation(new Error("Mermaid render timed out after 8000ms")), null);
  assert.equal(parseErrorLocation("Parse error on line 2"), null);
  assert.equal(parseErrorLocation(null), null);
  assert.equal(parseErrorLocation(undefined), null);
});

// ---- editor session ------------------------------------------------------

// A stand-in for host.markdown: a plain ```mermaid fence splitter. Like the
// host, `source` has CRLF turned into LF, and a replace keeps the body's
// line ending and throws on a missing block.
const FENCE_RE = /^```mermaid\r?\n([\s\S]*?)^```/gm;

const fakeMarkdown = {
  fencedBlocks(body, lang) {
    assert.equal(lang, "mermaid");
    return [...body.matchAll(FENCE_RE)].map((m) => ({
      from: m.index,
      to: m.index + m[0].length,
      prefix: "",
      source: m[1].replace(/\r\n/g, "\n").replace(/\n$/, ""),
    }));
  },
  replaceFencedBlock(body, lang, index, source) {
    assert.equal(lang, "mermaid");
    const m = [...body.matchAll(FENCE_RE)][index];
    if (!m) throw new Error(`no mermaid block at index ${index}`);
    const eol = body.includes("\r\n") ? "\r\n" : "\n";
    const start = m.index + m[0].length - m[1].length - 3;
    const content = source ? source.split("\n").join(eol) + eol : "";
    return body.slice(0, start) + content + body.slice(start + m[1].length);
  },
};

const fence = (src) => "```mermaid\n" + src + "\n```\n";
const twoDiagrams = "# Note\n\n" + fence("graph TD\n  A-->B") + "\ntext\n\n" + fence("pie\n  \"x\": 1");

function editor(overrides = {}) {
  const log = { written: [], errors: [], conflicts: 0, saved: 0 };
  const note = { body: overrides.body ?? twoDiagrams };
  const s = createEditorSession({
    index: overrides.index ?? 1,
    markdown: fakeMarkdown,
    readBody: async () => note.body,
    writeBody:
      overrides.writeBody ??
      (async (next) => {
        note.body = next;
        log.written.push(next);
      }),
    onConflict: () => (log.conflicts += 1),
    onSaved: () => (log.saved += 1),
    onError: (m) => log.errors.push(m),
    debounceMs: 10,
  });
  return { s, log, note };
}

const sourceAt = (body, i) => fakeMarkdown.fencedBlocks(body, "mermaid")[i]?.source;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("session: load returns the addressed block's source", async () => {
  const { s } = editor();
  assert.equal(await s.load(), 'pie\n  "x": 1');
  assert.equal(s.source(), 'pie\n  "x": 1');
  assert.equal(s.index(), 1);
});

test("session: load rejects when the note has no such block", async () => {
  const { s, log } = editor({ index: 5 });
  await assert.rejects(s.load(), /no mermaid block at index 5/i);
  s.change("pie");
  await s.flush();
  assert.equal(log.written.length, 0);
});

test("session: a burst of edits becomes one save of the last state", async () => {
  const { s, log, note } = editor();
  await s.load();
  s.change("pie\n  a");
  s.change("pie\n  ab");
  s.change("pie\n  abc");
  await wait(5);
  assert.equal(log.written.length, 0);
  await wait(30);
  assert.equal(log.written.length, 1);
  assert.equal(sourceAt(note.body, 1), "pie\n  abc");
  assert.equal(sourceAt(note.body, 0), "graph TD\n  A-->B");
  assert.equal(log.saved, 1);
});

test("session: flush saves a pending edit right away, once", async () => {
  const { s, log, note } = editor();
  await s.load();
  s.change("pie\n  now");
  await s.flush();
  assert.equal(log.written.length, 1);
  assert.equal(sourceAt(note.body, 1), "pie\n  now");
  await wait(30);
  assert.equal(log.written.length, 1);
});

test("session: an edit back to the saved text writes nothing", async () => {
  const { s, log } = editor();
  const original = await s.load();
  s.change("pie\n  typo");
  s.change(original);
  await s.flush();
  assert.equal(log.written.length, 0);
});

test("session: overlapping saves run one at a time, with no false conflict", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const writes = [];
  const { s, log, note } = editor({
    writeBody: async (next) => {
      writes.push(next);
      if (writes.length === 1) await gate;
      note.body = next;
    },
  });
  await s.load();
  s.change("pie\n  first");
  const first = s.flush();
  await wait(5);
  assert.equal(writes.length, 1);
  // A second save while the first write is still open waits for it, rather
  // than reading a body whose block no longer matches what it expects.
  s.change("pie\n  second");
  const second = s.flush();
  await wait(5);
  assert.equal(writes.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(writes.length, 2);
  assert.equal(sourceAt(note.body, 1), "pie\n  second");
  assert.equal(log.conflicts, 0);
  assert.deepEqual(log.errors, []);
});

test("session: a failed write is reported and doesn't advance what was last written", async () => {
  let fail = true;
  const { s, log, note } = editor({
    writeBody: async (next) => {
      if (fail) throw new Error("disk full");
      note.body = next;
    },
  });
  await s.load();
  s.change("pie\n  lost?");
  await s.flush();
  assert.deepEqual(log.errors, ["Diagram save failed: disk full"]);
  assert.equal(log.saved, 0);
  // The block still holds the original text, which is what the session
  // expects there, so the retry is no conflict, and flush retries even
  // with no new edit.
  fail = false;
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(sourceAt(note.body, 1), "pie\n  lost?");
});

test("session: a block inserted above is adopted silently", async () => {
  const { s, log, note } = editor();
  await s.load();
  note.body = fence("flowchart LR\n  X-->Y") + note.body;
  s.change("pie\n  moved");
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(s.index(), 2);
  assert.equal(sourceAt(note.body, 0), "flowchart LR\n  X-->Y");
  assert.equal(sourceAt(note.body, 1), "graph TD\n  A-->B");
  assert.equal(sourceAt(note.body, 2), "pie\n  moved");
  // And the next save goes straight to the adopted block.
  s.change("pie\n  again");
  await s.flush();
  assert.equal(sourceAt(note.body, 2), "pie\n  again");
  assert.equal(log.conflicts, 0);
});

test("session: a block changed outside the editor raises the conflict and stops autosave", async () => {
  const { s, log, note } = editor();
  await s.load();
  note.body = note.body.replace('"x": 1', '"x": 2');
  const outside = note.body;
  s.change("pie\n  mine");
  await s.flush();
  assert.equal(log.conflicts, 1);
  assert.equal(log.written.length, 0);
  assert.equal(note.body, outside);
  // Later edits neither save nor raise it again; the user's text is kept.
  s.change("pie\n  mine, more");
  await wait(30);
  await s.flush();
  assert.equal(log.written.length, 0);
  assert.equal(log.conflicts, 1);
  assert.equal(s.source(), "pie\n  mine, more");
});

test("session: a deleted block raises the conflict", async () => {
  const { s, log, note } = editor();
  await s.load();
  note.body = note.body.slice(0, note.body.lastIndexOf("```mermaid"));
  s.change("pie\n  mine");
  await s.flush();
  assert.equal(log.conflicts, 1);
  assert.equal(log.written.length, 0);
});

test("session: two blocks matching the moved text are a conflict, not a guess", async () => {
  const { s, log, note } = editor({ index: 0 });
  await s.load();
  // A new block above moves ours to index 1, and a copy of it lands at 3.
  note.body = fence("flowchart LR") + note.body + fence("graph TD\n  A-->B");
  s.change("graph TD\n  A-->C");
  await s.flush();
  assert.equal(log.conflicts, 1);
  assert.equal(log.written.length, 0);
});

test("session: loading again (Reload from note) re-reads the block and resumes autosave", async () => {
  const { s, log, note } = editor();
  await s.load();
  note.body = note.body.replace('"x": 1', '"x": 2');
  s.change("pie\n  mine");
  await s.flush();
  assert.equal(log.conflicts, 1);
  assert.equal(await s.load(), 'pie\n  "x": 2');
  assert.equal(s.source(), 'pie\n  "x": 2');
  s.change("pie\n  after reload");
  await wait(30);
  assert.equal(log.written.length, 1);
  assert.equal(sourceAt(note.body, 1), "pie\n  after reload");
  assert.equal(log.conflicts, 1);
});

test("session: loading again drops a pending edit", async () => {
  const { s, log } = editor();
  await s.load();
  s.change("pie\n  pending");
  await s.load();
  await wait(30);
  await s.flush();
  assert.equal(log.written.length, 0);
});

test("session: a CRLF body saves with no false conflict and keeps CRLF", async () => {
  const crlf = twoDiagrams.replace(/\n/g, "\r\n");
  const { s, log, note } = editor({ body: crlf });
  assert.equal(await s.load(), 'pie\n  "x": 1');
  // Text from the editor with CRLF in it (a paste) counts as the same text.
  s.change('pie\r\n  "x": 1');
  await s.flush();
  assert.equal(log.written.length, 0);
  s.change("pie\r\n  y");
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(sourceAt(note.body, 1), "pie\n  y");
  assert.ok(!/[^\r]\n/.test(note.body), "every newline stays CRLF");
  s.change("pie\n  z");
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(sourceAt(note.body, 1), "pie\n  z");
});
