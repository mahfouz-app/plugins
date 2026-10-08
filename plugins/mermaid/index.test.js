// Run with `npm test` (node --test) from the repo root. No dependencies:
// the host and the DOM container are small fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activate,
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

test("parseErrorLocation: a bare 'line N' in the message", () => {
  assert.deepEqual(parseErrorLocation(new Error("Lexer error on LINE 7")), { line: 7 });
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
