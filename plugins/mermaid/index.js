// Mermaid diagrams for Mahfouz: renders ```mermaid fenced blocks.
//
// The mermaid library itself isn't bundled here. The install step unpacks
// the pinned npm package's self-contained ESM build into `vendor/`, and it's
// imported from the plugin's own URL the first time a block renders.
// Single file on purpose; see the README's note on frontend modules.

const MODULE_PATH = "vendor/package/dist/mermaid.esm.min.mjs";
const RENDER_TIMEOUT_MS = 8000;
// Collapses a burst of edits in the tab into one note save: the same
// cadence as the app's own editor saves.
const AUTOSAVE_DEBOUNCE_MS = 400;

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

// ---- editing a block in a tab --------------------------------------------

const lf = (text) => text.replace(/\r\n/g, "\n");

/**
 * The tab's link to its ```mermaid block: the `index`th one in the note
 * (0-based, document order). DOM-free; the tab passes `ctx.readBody`,
 * `ctx.writeBody` and `host.markdown`, and the UI hooks:
 * - `onConflict()`: the block changed outside the editor. Autosave has
 *   stopped until `load()` runs again; the editor should go read-only.
 * - `onSaved()`: a save reached the note.
 * - `onError(message)`: a save failed; the next save retries it.
 *
 * Every save checks that the block still holds what the session last
 * wrote (or loaded), or the text of a write that failed (the host's write
 * can land in the body and then throw), before replacing it. A block that
 * moved (another one inserted above) is followed when exactly one block
 * holds such a text; otherwise it's a conflict, never a guess. Saves run one at a time, so a
 * save never reads the body while an earlier write is still landing.
 * An external edit the app hasn't synced into the body yet can still be
 * overwritten, as in the main editor.
 */
export function createEditorSession({
  index,
  markdown,
  readBody,
  writeBody,
  onConflict,
  onSaved = () => {},
  onError,
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
}) {
  let at = index;
  // The block's text as the note holds it, as far as the session knows.
  let lastWritten = null;
  // Texts of writes that threw since then: any of them may have landed.
  const attempted = new Set();
  // The editor's text, saved or not.
  let current = "";
  // Until a load, and after a conflict, nothing is saved.
  let stopped = true;
  let timer = null;
  let chain = Promise.resolve();

  const enqueue = (job) => {
    const result = chain.then(job);
    chain = result.catch(() => {});
    return result;
  };

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = null;
  };

  const isOurs = (text) => text !== undefined && (text === lastWritten || attempted.has(text));

  const saveNow = async () => {
    if (stopped) return;
    const source = current;
    try {
      const body = await readBody();
      const texts = markdown.fencedBlocks(body, "mermaid").map((b) => lf(b.source));
      if (!isOurs(texts[at])) {
        const moved = texts.flatMap((text, i) => (isOurs(text) ? [i] : []));
        if (moved.length !== 1) {
          stopped = true;
          cancelTimer();
          onConflict();
          return;
        }
        at = moved[0];
      }
      // A block holding a failed write's text is written again: the host
      // updates the body before the file, so that text may be in the body
      // but not on disk.
      if (texts[at] === lastWritten) {
        attempted.clear();
        if (source === lastWritten) return;
      }
      attempted.add(source);
      await writeBody(markdown.replaceFencedBlock(body, "mermaid", at, source));
      lastWritten = source;
      attempted.clear();
    } catch (err) {
      onError(`Diagram save failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Outside the try: the save succeeded whatever the UI hook does.
    try {
      onSaved();
    } catch (err) {
      console.error(err);
    }
  };

  return {
    /**
     * Reads the block into the session and returns its source. Also what
     * "Reload from note" runs: it drops unsaved edits and resumes autosave.
     * Rejects, leaving autosave stopped, when the note can't be read or has
     * no such block.
     */
    load() {
      cancelTimer();
      return enqueue(async () => {
        // Stopped until the block is read, so a load that fails leaves
        // autosave off.
        stopped = true;
        const block = markdown.fencedBlocks(await readBody(), "mermaid")[at];
        if (!block) throw new Error(`No mermaid block at index ${at}`);
        lastWritten = current = lf(block.source);
        attempted.clear();
        stopped = false;
        return current;
      });
    },

    /** The editor's text changed; saves it after the debounce. */
    change(source) {
      current = lf(source);
      if (stopped) return;
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        void enqueue(saveNow);
      }, debounceMs);
    },

    /** Saves any unsaved edit now (unmount, Close, tab switch); resolves
     * once every save so far has finished. */
    flush() {
      cancelTimer();
      if (!stopped && (current !== lastWritten || attempted.size > 0)) void enqueue(saveNow);
      return chain;
    },

    /** The editor's text, saved or not ("Copy my version"). */
    source: () => current,

    /** The block's index now, after following any move. */
    index: () => at,
  };
}

export function activate(host) {
  const runtime = createMermaidRuntime(host);
  host.registerEmbed("mermaid", createMermaidRenderer(host, { runtime }));
}
