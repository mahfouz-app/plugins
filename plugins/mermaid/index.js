// Mermaid diagrams for Mahfouz: renders ```mermaid fenced blocks.
//
// The mermaid library itself isn't bundled here. The install step unpacks
// the pinned npm package's self-contained ESM build into `vendor/`, and it's
// imported from the plugin's own URL the first time a block renders.
// Single file on purpose; see the README's note on frontend modules.

const MODULE_PATH = "vendor/package/dist/mermaid.esm.min.mjs";
const RENDER_TIMEOUT_MS = 8000;

/** Where the vendored mermaid build is served, under the plugin's own URL. */
export function mermaidModuleUrl(baseUrl) {
  return `${baseUrl}${MODULE_PATH}`;
}

// How mermaid's parsers word a syntax error, at the start of the message:
// jison's parser ("Parse error on line 3:") and lexer ("Lexical error on
// line 3."), and the langium diagrams' "Parsing failed: Parse error on line
// 3, column 10:" / "Lexer error on line 3, column 3:".
const SYNTAX_ERROR_RE = /^(?:Parsing failed:\s*)?(?:Parse|Lexical|Lexer) error on line (\d+)\b(?:, column (\d+)\b)?/;

/**
 * Where a mermaid syntax error points, as 1-based `{ line, column?, endColumn? }`
 * (`endColumn` exclusive), or null for any other error. Only a message
 * worded like a parser's counts: mermaid's own semantic errors quote the
 * user's text and carry a placeholder `hash`, so neither can be trusted.
 * jison errors (flowchart and others) carry a `hash` (`loc` columns and
 * `line` 0-based); langium ones (pie and others) only say it in the
 * message, with chevrotain's 1-based line and column.
 */
export function parseErrorLocation(err) {
  if (!(err instanceof Error)) return null;
  const match = SYNTAX_ERROR_RE.exec(err.message);
  if (!match) return null;
  const loc = err.hash?.loc;
  if (Number.isInteger(loc?.first_line)) {
    const at = { line: loc.first_line };
    if (Number.isInteger(loc.first_column)) {
      at.column = loc.first_column + 1;
      if (loc.last_line === loc.first_line && loc.last_column > loc.first_column) {
        at.endColumn = loc.last_column + 1;
      }
    }
    return at;
  }
  if (Number.isInteger(err.hash?.line)) return { line: err.hash.line + 1 };
  return match[2] ? { line: Number(match[1]), column: Number(match[2]) } : { line: Number(match[1]) };
}

/**
 * The one mermaid instance the plugin renders with: the embed and the
 * editor tab share it, so the module loads once. `loadModule` and
 * `timeoutMs` exist for tests; the app uses the defaults.
 */
export function createMermaidRuntime(host, options = {}) {
  const loadModule =
    options.loadModule ?? (() => import(mermaidModuleUrl(host.plugin.baseUrl)).then((m) => m.default));
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;

  let cached = null;
  let pending = null;
  // mermaid.initialize() is meant for startup or a config change, not every
  // render, so it only runs again when the config actually changes.
  let initializedConfig = null;
  let renderCounter = 0;
  // initialize() sets global config that a render reads while it runs, so
  // renders go one at a time: a theme change for one caller can't land in
  // the middle of another's render.
  let queue = Promise.resolve();

  function load() {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      // Under the timeout too: an import that never settles would otherwise
      // hold the render queue for good.
      pending = withTimeout(loadModule(), "Loading Mermaid").then((mod) => {
        cached = mod;
        return mod;
      });
      // A failed or timed-out load isn't cached, so the next render retries.
      pending.catch(() => {
        pending = null;
      });
    }
    return pending;
  }

  function withTimeout(promise, what = "Mermaid render") {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  async function renderNow(source, theme) {
    const mermaid = await load();
    // securityLevel is mermaid's default, pinned so it can't drift: it
    // sanitises labels and turns off click handlers in the SVG.
    // suppressErrorRendering: on a syntax error mermaid otherwise draws its
    // own error diagram into a temporary element on document.body and
    // leaves it there. Callers show the thrown error themselves.
    const config = {
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
    };
    const key = JSON.stringify(config);
    if (initializedConfig !== key) {
      mermaid.initialize(config);
      initializedConfig = key;
    }
    renderCounter += 1;
    const { svg } = await withTimeout(mermaid.render(`mahfouz-mermaid-${renderCounter}`, source));
    return svg;
  }

  return {
    /** Whether the mermaid module has loaded (renders won't wait on it). */
    isLoaded: () => cached !== null,

    /** Renders `source` to SVG markup; rejects with mermaid's error. */
    renderSvg(source, theme) {
      const result = queue.then(() => renderNow(source, theme));
      queue = result.catch(() => {});
      return result;
    },
  };
}

/**
 * Builds the embed renderer. `options.runtime` is the shared mermaid
 * instance; without one it makes its own from `options` (tests do).
 */
export function createMermaidRenderer(host, options = {}) {
  const runtime = options.runtime ?? createMermaidRuntime(host, options);
  const panZoomUndo = new WeakMap();
  // Each render of a container takes the next number; a result that comes
  // back after a newer render of the same container started is dropped.
  const latest = new WeakMap();
  let sequence = 0;

  const message = (err) => (err instanceof Error ? err.message : String(err));

  return {
    label: "Mermaid diagram",
    snippet: "graph TD;\n    A --> B",

    async render(container, source, theme) {
      sequence += 1;
      const seq = sequence;
      latest.set(container, seq);
      if (!runtime.isLoaded()) container.textContent = "Loading Mermaid…";
      let svg;
      try {
        svg = await runtime.renderSvg(source, theme);
      } catch (err) {
        if (latest.get(container) === seq) host.ui.showError(container, message(err));
        return;
      }
      if (latest.get(container) !== seq) return;
      container.innerHTML = svg;
      const rendered = container.firstElementChild;
      if (rendered && rendered.scrollWidth > container.clientWidth) {
        panZoomUndo.set(container, host.ui.attachPanZoom(container));
      }
    },

    dispose(container) {
      panZoomUndo.get(container)?.();
      panZoomUndo.delete(container);
    },
  };
}

export function activate(host) {
  const runtime = createMermaidRuntime(host);
  host.registerEmbed("mermaid", createMermaidRenderer(host, { runtime }));
}
