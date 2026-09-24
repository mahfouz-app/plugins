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

/**
 * Builds the embed renderer. `loadModule` and `timeoutMs` exist for tests;
 * the app uses the defaults.
 */
export function createMermaidRenderer(host, options = {}) {
  const loadModule =
    options.loadModule ?? (() => import(mermaidModuleUrl(host.plugin.baseUrl)).then((m) => m.default));
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;

  let cached = null;
  let pending = null;
  // mermaid.initialize() is meant for startup or a config change, not every
  // render, so it only runs again when the theme actually changes.
  let initializedTheme = null;
  let renderCounter = 0;
  const panZoomUndo = new WeakMap();

  function load() {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      pending = loadModule().then((mod) => {
        cached = mod;
        return mod;
      });
      // A failed load isn't cached, so the next render retries.
      pending.catch(() => {
        pending = null;
      });
    }
    return pending;
  }

  function withTimeout(promise) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Mermaid render timed out after ${timeoutMs}ms`)),
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

  const message = (err) => (err instanceof Error ? err.message : String(err));

  return {
    label: "Mermaid diagram",
    snippet: "graph TD;\n    A --> B",

    async render(container, source, theme) {
      if (!cached) container.textContent = "Loading Mermaid…";
      let mermaid;
      try {
        mermaid = await load();
      } catch (err) {
        host.ui.showError(container, message(err));
        return;
      }
      if (initializedTheme !== theme) {
        mermaid.initialize({ startOnLoad: false, theme: theme === "dark" ? "dark" : "default" });
        initializedTheme = theme;
      }
      try {
        renderCounter += 1;
        const { svg } = await withTimeout(mermaid.render(`mahfouz-mermaid-${renderCounter}`, source));
        container.innerHTML = svg;
        const rendered = container.firstElementChild;
        if (rendered && rendered.scrollWidth > container.clientWidth) {
          panZoomUndo.set(container, host.ui.attachPanZoom(container));
        }
      } catch (err) {
        host.ui.showError(container, message(err));
      }
    },

    dispose(container) {
      panZoomUndo.get(container)?.();
      panZoomUndo.delete(container);
    },
  };
}

export function activate(host) {
  host.registerEmbed("mermaid", createMermaidRenderer(host));
}
