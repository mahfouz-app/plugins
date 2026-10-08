// Run with `npm test` (node --test) from the repo root. No dependencies:
// the host and the DOM container are small fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  activate,
  bannerActions,
  canExport,
  createEditorSession,
  createRenderTracker,
  createMermaidRenderer,
  createMermaidRuntime,
  exportFileName,
  loadSplit,
  MERMAID_LANGUAGE,
  MERMAID_SAMPLES,
  MERMAID_VERSION,
  mermaidModuleUrl,
  needsSvgExport,
  parseErrorLocation,
  pngExportSource,
  sourceErrorLocation,
  storeSplit,
  svgSize,
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

// ---- sourceErrorLocation -------------------------------------------------
//
// Each `at` is what parseErrorLocation returned for that source under the
// pinned build (mermaid.parse under node): mermaid counts in the text it
// parsed, after stripping front matter, directives and comments.

test("sourceErrorLocation: a plain source maps onto itself", () => {
  const src = "graph TD\n  A-->B\n  C-->>\n";
  assert.deepEqual(sourceErrorLocation(src, { line: 3, column: 4, endColumn: 7 }), {
    line: 3,
    column: 4,
    endColumn: 7,
  });
});

test("sourceErrorLocation: front matter, comments, directives and leading blank lines", () => {
  const at = { line: 3, column: 4, endColumn: 7 }; // reported for every one of these
  const cases = [
    ["---\ntitle: x\n---\ngraph TD\n  A-->B\n  C-->>\n", 6],
    ["  ---\n  title: x\n  ---\ngraph TD\n  A-->B\n  C-->>\n", 6],
    ["graph TD\n%% one\n  %% indented\n  A-->B\n  C-->>\n", 5],
    ["%%{init: {'theme':'dark'}}%%\ngraph TD\n  A-->B\n  C-->>\n", 4],
    ["\n\n\ngraph TD\n  A-->B\n  C-->>\n", 6],
    // A comment's leading \s* takes the blank line above it too.
    ["graph TD\n  A-->B\n\n%% c\n  C-->>\n", 5],
    ["---\ntitle: x\n---\n\n%%{init: {'theme':'dark'}}%%\n%% c\ngraph TD\n\n  %% c2\n  A-->B\n  C-->>\n", 11],
    // An inline directive leaves its line; a bare %% isn't a comment.
    ["graph TD\n  A-->B %%{init: {'theme':'dark'}}%% \n  C-->>\n", 3],
    ["graph TD\n%%\n  C-->>\n", 3],
  ];
  for (const [src, line] of cases) {
    assert.deepEqual(sourceErrorLocation(src, at), { line, column: 4, endColumn: 7 }, JSON.stringify(src));
  }
});

test("sourceErrorLocation: a directive spanning lines, and an indented first line", () => {
  const at = { line: 2, column: 4, endColumn: 7 };
  assert.deepEqual(sourceErrorLocation("%%{init: {\n'theme':'dark'\n}}%%\ngraph TD\n  C-->>\n", at), {
    line: 5,
    column: 4,
    endColumn: 7,
  });
  assert.deepEqual(sourceErrorLocation("\n   graph TD\n  C-->>\n", at), { line: 3, column: 4, endColumn: 7 });
  // The trimmed indent shifts the columns on the first line back.
  assert.deepEqual(sourceErrorLocation("%% c\n  graph TD C-->>\n", { line: 1, column: 9, endColumn: 10 }), {
    line: 2,
    column: 11,
    endColumn: 12,
  });
});

test("sourceErrorLocation: front matter that isn't at the very start stays in", () => {
  assert.deepEqual(sourceErrorLocation("\n---\ntitle: x\n---\ngraph TD\n", { line: 1, column: 1 }), {
    line: 2,
    column: 1,
  });
});

test("sourceErrorLocation: an error at the end of the input", () => {
  assert.deepEqual(sourceErrorLocation("%% c\ngraph TD\n  A-->\n%% trailing\n", { line: 2, column: 4 }), {
    line: 3,
    column: 4,
  });
});

test("sourceErrorLocation: pie (langium) errors", () => {
  assert.deepEqual(sourceErrorLocation('---\ntitle: p\n---\npie\n  "a": 1\n  "b" 2\n', { line: 3, column: 7 }), {
    line: 6,
    column: 7,
  });
  const all = '\n%%{init: {\'theme\':\'dark\'}}%%\n%% c\npie\n  %% c\n  "a": 1\n\n  "b" 2\n';
  assert.deepEqual(sourceErrorLocation(all, { line: 4, column: 7 }), { line: 8, column: 7 });
  const comments = 'pie\n%% c\n    %% indented\n\n  "a": 1\n  "b" 2\n';
  assert.deepEqual(sourceErrorLocation(comments, { line: 4, column: 7 }), { line: 6, column: 7 });
});

test("sourceErrorLocation: agentflow is parsed with its comments in", () => {
  const src = "---\ntitle: a\n---\n%% c\nagentflow-beta\n  bad bad (\n";
  assert.deepEqual(sourceErrorLocation(src, { line: 3, column: 6, endColumn: 7 }), {
    line: 6,
    column: 6,
    endColumn: 7,
  });
});

test("sourceErrorLocation: keeps only the line where entities shift the columns", () => {
  assert.deepEqual(sourceErrorLocation("%% c\ngraph TD\n  A[#35; x]-->B C-->>\n", { line: 2, column: 20 }), {
    line: 3,
  });
});

test("sourceErrorLocation: no mark when it can't be placed", () => {
  assert.equal(sourceErrorLocation("graph TD\n  A-->\n", null), null);
  assert.equal(sourceErrorLocation("graph TD\n  A-->\n", { line: 9 }), null);
  assert.equal(sourceErrorLocation("graph TD\r\n  A-->\r\n", { line: 2, column: 4 }), null);
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
    readBody: overrides.readBody ?? (async () => note.body),
    writeBody:
      overrides.writeBody ??
      (async (next) => {
        note.body = next;
        log.written.push(next);
      }),
    onConflict: () => (log.conflicts += 1),
    onSaved: overrides.onSaved ?? (() => (log.saved += 1)),
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

test("session: a write that lands and then throws is retried, not a conflict", async () => {
  let fail = true;
  const { s, log, note } = editor({
    // Like the host: the body (what readBody returns) is updated before
    // the file write that fails.
    writeBody: async (next) => {
      note.body = next;
      log.written.push(next);
      if (fail) throw new Error("file write failed");
    },
  });
  await s.load();
  s.change("pie\n  landed");
  await s.flush();
  assert.deepEqual(log.errors, ["Diagram save failed: file write failed"]);
  assert.equal(log.saved, 0);
  fail = false;
  // The block holds the failed write's text: still ours, and written again,
  // since it may be in the body but not on disk.
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(log.written.length, 2);
  assert.equal(sourceAt(log.written[1], 1), "pie\n  landed");
  assert.equal(log.saved, 1);
  // Now confirmed: flushing again writes nothing.
  await s.flush();
  assert.equal(log.written.length, 2);
  s.change("pie\n  next");
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(sourceAt(note.body, 1), "pie\n  next");
  assert.equal(log.saved, 2);
});

test("session: undoing back to the saved text after a landed failed write still writes it", async () => {
  let fail = true;
  const { s, log, note } = editor({
    writeBody: async (next) => {
      note.body = next;
      log.written.push(next);
      if (fail) throw new Error("file write failed");
    },
  });
  const original = await s.load();
  s.change("pie\n  landed");
  await s.flush();
  fail = false;
  s.change(original);
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(log.written.length, 2);
  assert.equal(sourceAt(note.body, 1), original);
  assert.equal(log.saved, 1);
});

test("session: a landed failed write is followed when a block is inserted above", async () => {
  let fail = true;
  const { s, log, note } = editor({
    writeBody: async (next) => {
      note.body = next;
      if (fail) throw new Error("file write failed");
    },
  });
  await s.load();
  s.change("pie\n  landed");
  await s.flush();
  fail = false;
  note.body = fence("flowchart LR") + note.body;
  s.change("pie\n  next");
  await s.flush();
  assert.equal(log.conflicts, 0);
  assert.equal(s.index(), 2);
  assert.equal(sourceAt(note.body, 2), "pie\n  next");
});

test("session: a load that fails mid-session leaves autosave stopped", async () => {
  let readFails = false;
  const { s, log, note } = editor({
    readBody: async () => {
      if (readFails) throw new Error("vault gone");
      return note.body;
    },
  });
  await s.load();
  s.change("pie\n  unsaved");
  readFails = true;
  await assert.rejects(s.load(), /vault gone/);
  readFails = false;
  s.change("pie\n  more");
  await wait(30);
  await s.flush();
  assert.equal(log.written.length, 0);
  assert.equal(s.source(), "pie\n  more");
});

test("session: a load that finds the block gone mid-session leaves autosave stopped", async () => {
  const { s, log, note } = editor();
  await s.load();
  note.body = note.body.slice(0, note.body.lastIndexOf("```mermaid"));
  await assert.rejects(s.load(), /no mermaid block at index 1/i);
  s.change("pie\n  more");
  await wait(30);
  await s.flush();
  assert.equal(log.written.length, 0);
  assert.equal(log.conflicts, 0);
});

test("session: a throwing onSaved isn't reported as a failed save", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { s, log } = editor({
    onSaved: () => {
      throw new Error("ui hook broke");
    },
  });
  await s.load();
  s.change("pie\n  saved");
  await s.flush();
  assert.deepEqual(log.errors, []);
  assert.equal(log.written.length, 1);
  assert.equal(logged.mock.callCount(), 1);
  // It counts as saved: nothing is written again.
  await s.flush();
  assert.equal(log.written.length, 1);
});

// ---- the editor tab ------------------------------------------------------

// The host's tokenizer (src/core/src/plugins/codeEditor.ts), line by line:
// at each position the first rule that matches there (non-empty) wins;
// otherwise one character is skipped, unstyled.
function tokenize(line) {
  const rules = MERMAID_LANGUAGE.rules.map((r) => ({
    re: new RegExp(r.regex, (r.flags ?? "").replace(/[gy]/g, "") + "y"),
    token: r.token,
  }));
  const out = [];
  let pos = 0;
  while (pos < line.length) {
    let hit = null;
    for (const { re, token } of rules) {
      re.lastIndex = pos;
      const m = re.exec(line);
      if (m && m[0].length > 0) {
        hit = [m[0], token];
        break;
      }
    }
    if (hit) {
      out.push(hit);
      pos += hit[0].length;
    } else {
      pos += 1;
    }
  }
  return out;
}

test("mermaid rules: every regex compiles, as the host compiles it", () => {
  assert.equal(MERMAID_LANGUAGE.lineComment, "%%");
  const tokens = new Set(["keyword", "type", "string", "comment", "operator", "number", "variable", "punctuation"]);
  for (const rule of MERMAID_LANGUAGE.rules) {
    assert.ok(tokens.has(rule.token), rule.token);
    assert.doesNotThrow(() => new RegExp(rule.regex, (rule.flags ?? "") + "y"), rule.regex);
  }
});

test("mermaid rules: fixture lines get the expected tokens", () => {
  const cases = [
    ["flowchart LR", [["flowchart", "type"], ["LR", "keyword"]]],
    ["sequenceDiagram", [["sequenceDiagram", "type"]]],
    ["  stateDiagram-v2", [["  stateDiagram-v2", "type"]]],
    ["%% a comment --> not an arrow", [["%% a comment --> not an arrow", "comment"]]],
    ['%%{init: {"theme": "dark"}}%%', [['%%{init: {"theme": "dark"}}%%', "comment"]]],
    ["---", [["---", "punctuation"]]],
    ["  A[Start] -->|yes| B", [["-->", "operator"], ["|yes|", "string"]]],
    ["  A -.-> B", [["-.->", "operator"]]],
    ["  A ==> B", [["==>", "operator"]]],
    ["  A --o B", [["--o", "operator"]]],
    ["  Alice->>Bob: Hi", [["->>", "operator"]]],
    ["  Bob-->>Alice: Hello", [["-->>", "operator"]]],
    ["  Alice-xBob: lost", [["-x", "operator"]]],
    ["  Animal <|-- Duck", [["<|--", "operator"]]],
    ["  CUSTOMER ||--o{ ORDER : places", [["||--o{", "operator"]]],
    ['  A["a label"] --> B', [['"a label"', "string"], ["-->", "operator"]]],
    ['  "Dogs" : 386', [['"Dogs"', "string"], ["386", "number"]]],
    ["  subgraph one", [["subgraph", "keyword"]]],
    ["  end", [["end", "keyword"]]],
    ["  participant Alice", [["participant", "keyword"]]],
    ["  loop Every minute", [["loop", "keyword"]]],
    ["  alt is sick", [["alt", "keyword"]]],
    ["  else is well", [["else", "keyword"]]],
    // Keywords and arrows inside identifiers aren't marked.
    ["  backend --> endpoint", [["-->", "operator"]]],
    ["  my-node --> api-node", [["-->", "operator"]]],
  ];
  for (const [line, expected] of cases) assert.deepEqual(tokenize(line), expected, line);
});

test("samples: the menu's diagrams, each starting with its diagram type", () => {
  assert.deepEqual(
    MERMAID_SAMPLES.map((s) => s.label),
    ["Flowchart", "Sequence", "Class", "State", "ER", "Gantt", "Pie", "Mindmap", "Timeline"]
  );
  for (const { label, source } of MERMAID_SAMPLES) {
    const first = source.split("\n")[0];
    assert.equal(tokenize(first)[0]?.[1], "type", label);
  }
});

test("the footer's version is the one plugin.json installs", () => {
  const manifest = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
  assert.ok(manifest.install[0].artifacts.any.url.endsWith(`/mermaid-${MERMAID_VERSION}.tgz`));
});

const PNG_INIT = '%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%';

test("PNG export source: the htmlLabels directive goes first", () => {
  assert.equal(pngExportSource("graph TD\n  A-->B"), `${PNG_INIT}\ngraph TD\n  A-->B`);
});

test("PNG export source: after a --- config block, which must stay first", () => {
  const src = "---\ntitle: Hello\n---\ngraph TD\n  A-->B";
  assert.equal(pngExportSource(src), `---\ntitle: Hello\n---\n${PNG_INIT}\ngraph TD\n  A-->B`);
  // An unclosed block isn't a config block.
  assert.equal(pngExportSource("---\ngraph TD"), `${PNG_INIT}\n---\ngraph TD`);
});

test("a PNG export doesn't change the next embed render's config", async () => {
  const mermaid = fakeMermaid();
  const sources = [];
  const render = mermaid.render;
  mermaid.render = (id, source) => {
    sources.push(source);
    return render(id, source);
  };
  const runtime = createMermaidRuntime(fakeHost(), { loadModule: async () => mermaid });
  const renderer = createMermaidRenderer(fakeHost(), { runtime });
  await renderer.render(fakeContainer(), "graph TD\n  A-->B", "light");
  await runtime.renderSvg(pngExportSource("graph TD\n  A-->B"), "light");
  await renderer.render(fakeContainer(), "graph TD\n  A-->B", "light");
  // One initialize, before the first render: the export never re-initializes.
  assert.equal(mermaid.calls.initialize.length, 1);
  assert.equal(sources[1].split("\n")[0], PNG_INIT);
  assert.equal(sources[2], "graph TD\n  A-->B");
});

test("needsSvgExport: HTML labels and external images can't be drawn to a PNG", () => {
  assert.equal(needsSvgExport('<svg><g><rect/><text>A</text></g></svg>'), false);
  assert.equal(needsSvgExport("<svg><foreignObject><div>A</div></foreignObject></svg>"), true);
  assert.equal(needsSvgExport('<svg><image href="https://example.com/a.png"/></svg>'), true);
  assert.equal(needsSvgExport('<svg><image xlink:href="/files/a.png"/></svg>'), true);
  assert.equal(needsSvgExport('<svg><image href="data:image/png;base64,AAAA"/></svg>'), false);
});

test("svgSize: from the viewBox, else width and height", () => {
  assert.deepEqual(svgSize('<svg id="x" viewBox="-8 -8 316.5 200" style="max-width: 316.5px;">'), {
    width: 316.5,
    height: 200,
  });
  assert.deepEqual(svgSize('<svg width="120" height="80"><g viewBox="0 0 1 1"/></svg>'), { width: 120, height: 80 });
  assert.equal(svgSize('<svg width="100%"></svg>'), null);
  assert.equal(svgSize("not svg"), null);
});

test("exportFileName: the note title made safe, and the diagram's number", () => {
  assert.equal(exportFileName("Design notes", 0, "svg"), "Design notes-diagram-1.svg");
  assert.equal(exportFileName('a/b\\c: "d"?', 2, "png"), "a-b-c- -d--diagram-3.png");
  assert.equal(exportFileName("..hidden", 0, "svg"), "hidden-diagram-1.svg");
  assert.equal(exportFileName("  ", 1, "png"), "untitled-diagram-2.png");
});

test("split: stored width is read back, clamped, and a bad or unreadable value gives the default", (t) => {
  const store = new Map();
  t.after(() => delete globalThis.localStorage);
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  assert.equal(loadSplit(), 40);
  storeSplit(55);
  assert.equal(store.get("mahfouz.mermaid.split"), "55");
  assert.equal(loadSplit(), 55);
  store.set("mahfouz.mermaid.split", "99");
  assert.equal(loadSplit(), 85);
  store.set("mahfouz.mermaid.split", "nonsense");
  assert.equal(loadSplit(), 40);
  globalThis.localStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(loadSplit(), 40);
  assert.doesNotThrow(() => storeSplit(50));
});

// A host from before the editor members: no markdown, no code editor.
function oldTabHost() {
  const host = fakeHost();
  host.tabTypes = [];
  host.opened = [];
  host.registerTabType = (type) => {
    host.tabTypes.push(type);
    return { dispose() {} };
  };
  host.openTab = async (...args) => {
    host.opened.push(args);
  };
  return host;
}

function editorHost() {
  const host = oldTabHost();
  host.markdown = fakeMarkdown;
  host.ui.createCodeEditor = () => {
    throw new Error("not in node");
  };
  return host;
}

test("feature detection: an old host gets the embed only, no tab and no edit hooks", () => {
  for (const tweak of [
    (h) => delete h.markdown,
    (h) => delete h.markdown.replaceFencedBlock,
    (h) => delete h.ui.createCodeEditor,
  ]) {
    const host = editorHost();
    host.markdown = { ...fakeMarkdown };
    tweak(host);
    activate(host);
    assert.deepEqual(host.tabTypes, []);
    const embed = host.embeds.get("mermaid");
    assert.equal(embed.edit, undefined);
    assert.equal(embed.onInsertedAt, undefined);
  }
});

test("editor tab: registered on a new host, opened by the edit button with the block's ordinal", () => {
  const host = editorHost();
  activate(host);
  assert.equal(host.tabTypes.length, 1);
  assert.equal(host.tabTypes[0].id, "editor");
  assert.equal(host.tabTypes[0].icon, "◈");
  const embed = host.embeds.get("mermaid");
  const note = { vaultId: "v", noteId: "n" };
  embed.edit({ ordinal: 2, note });
  assert.deepEqual(host.opened, [["editor", note, "2"]]);
  embed.edit({ ordinal: 0, note: null });
  assert.equal(host.opened.length, 1);
});

test("editor tab: a freshly inserted block opens at its ordinal", () => {
  const host = editorHost();
  activate(host);
  const before = "# Note\n\n" + fence("graph TD\n  A-->B") + "\n";
  const doc = before + fence("graph TD;\n    A --> B") + "\n" + fence("pie");
  const view = { state: { doc: { toString: () => doc } } };
  const note = { vaultId: "v", noteId: "n" };
  host.embeds.get("mermaid").onInsertedAt(view, before.length, note);
  assert.deepEqual(host.opened, [["editor", note, "1"]]);
});

test("banner: Copy my version comes first and is primary; Reload, which discards edits, second", () => {
  assert.deepEqual(bannerActions({ hasEditor: true }), [
    { id: "copy", label: "Copy my version", primary: true },
    { id: "reload", label: "Reload from note", primary: false },
  ]);
  // A load that failed before there was an editor has nothing to copy.
  assert.deepEqual(bannerActions({ hasEditor: false }), [
    { id: "reload", label: "Reload from note", primary: false },
  ]);
});

test("canExport: only a successful render of the current source, with none pending", () => {
  assert.equal(canExport({ svg: "<svg/>", current: true, pending: false }), true);
  // An edit's render is still debounced or running: the SVG is the old text's.
  assert.equal(canExport({ svg: "<svg/>", current: true, pending: true }), false);
  // The source has an error or is empty.
  assert.equal(canExport({ svg: "<svg/>", current: false, pending: false }), false);
  assert.equal(canExport({ svg: null, current: false, pending: false }), false);
});

test("render tracker: an edit during a render drops that render, and exports wait for the next", () => {
  const t = createRenderTracker();
  assert.equal(t.isPending(), false);
  // First edit: debounced render scheduled, then it starts.
  assert.equal(t.schedule(), true);
  const first = t.start();
  // A second edit lands while the first render is in flight.
  assert.equal(t.schedule(), false);
  // The first render resolves: superseded, so it's dropped and nothing is exportable.
  assert.equal(t.settle(first), false);
  assert.equal(t.isPending(), true);
  assert.equal(canExport({ svg: "<svg>old</svg>", current: true, pending: t.isPending() }), false);
  // The second edit's render runs and resolves.
  const second = t.start();
  assert.equal(t.settle(second), true);
  assert.equal(t.isPending(), false);
  assert.equal(canExport({ svg: "<svg>new</svg>", current: true, pending: t.isPending() }), true);
});

test("render tracker: a render started over another wins, and the older one is dropped", () => {
  const t = createRenderTracker();
  const a = t.start();
  const b = t.start(); // e.g. a theme change re-renders
  assert.equal(t.settle(a), false);
  assert.equal(t.isPending(), true);
  assert.equal(t.settle(b), true);
  assert.equal(t.isPending(), false);
});
