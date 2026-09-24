// Run with `npm test` (node --test) from the repo root. No dependencies:
// the host and the DOM container are small fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activate, createMermaidRenderer, mermaidModuleUrl } from "./index.js";

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
  assert.deepEqual(mermaid.calls.initialize, [{ startOnLoad: false, theme: "dark" }]);
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
