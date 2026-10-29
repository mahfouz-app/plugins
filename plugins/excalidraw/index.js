// Excalidraw drawings for Mahfouz: renders ```excalidraw fenced blocks (the
// scene's JSON) as static previews, edits one in a tab running the
// Excalidraw editor, and draws them as images on published pages.
//
// Excalidraw isn't bundled here: the install step unpacks this repo's
// excalidraw-v<version> release asset (built from bundle/, see its
// build.mjs) into `vendor/`, served from the plugin's own URL. It's
// Excalidraw and React as one ES module, its lazy chunks, its CSS and its
// fonts. Single file on purpose; see the README's note on frontend modules.

const VENDOR = "vendor/";
const MODULE = `${VENDOR}excalidraw.js`;
const STYLESHEET = `${VENDOR}excalidraw.css`;

// Excalidraw calls onChange on every pointer move and selection change, so
// this collapses a burst of changes into one note save — the same cadence
// as the app's own editor saves.
const AUTOSAVE_DEBOUNCE_MS = 400;

/** An empty scene, as Excalidraw's own JSON export writes one. */
const STARTER_JSON = JSON.stringify(
  { type: "excalidraw", version: 2, source: "mahfouz", elements: [], appState: {}, files: {} },
  null,
  2
);

// ---- ```excalidraw blocks in a note body -----------------------------------
//
// A drawing is addressed by its ordinal among the note's ```excalidraw
// fences (0-based, document order). The app hands the same ordinal to the
// embed renderer (computed from the full syntax tree, not just what's on
// screen), so a preview click and these body-text helpers always agree.

/** Matches a ```excalidraw fenced block, tolerating CRLF line endings. */
function fenceRe() {
  return /```excalidraw\r?\n([\s\S]*?)\r?\n```/g;
}

/** The `index`-th ```excalidraw block's JSON, or "" if there isn't one (yet). */
export function extractExcalidrawBlockAt(body, index) {
  const re = fenceRe();
  let match;
  let i = 0;
  while ((match = re.exec(body)) !== null) {
    if (i === index) return match[1];
    i += 1;
  }
  return "";
}

/**
 * Replaces the `index`-th ```excalidraw block's JSON. Throws when there's no
 * such block: the note changed underneath the editor, and writing to the
 * wrong block would be worse than failing loudly.
 */
export function replaceExcalidrawBlockAt(body, index, json) {
  let count = 0;
  let matched = false;
  const result = body.replace(fenceRe(), (full) => {
    const hit = count === index;
    count += 1;
    if (!hit) return full;
    matched = true;
    return "```excalidraw\n" + json + "\n```";
  });
  if (!matched) {
    throw new Error(`replaceExcalidrawBlockAt: no excalidraw block at index ${index} (found ${count})`);
  }
  return result;
}

/** How many ```excalidraw blocks start before `pos` — the ordinal of a block
 * just inserted at `pos`. */
export function countExcalidrawBlocksBefore(body, pos) {
  const re = fenceRe();
  let match;
  let count = 0;
  while ((match = re.exec(body)) !== null) {
    if (match.index >= pos) break;
    count += 1;
  }
  return count;
}

/**
 * Scene JSON safe to put inside a fence: a backtick only ever appears in a
 * JSON string (a text element's text), where ``` means the same, so a
 * text holding ``` can't close the fence early.
 */
export function fenceSafeJson(json) {
  return json.replace(/`/g, "\\u0060");
}

/**
 * The scene a fence's `source` holds, as Excalidraw's `restore` input:
 * `{ elements, appState, files }`. "" is an empty scene. Throws a readable
 * error for JSON that doesn't parse or isn't an Excalidraw scene.
 */
export function parseScene(source) {
  if (!source.trim()) return { elements: [], appState: {}, files: {} };
  let data;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new Error(`the drawing isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.elements)) {
    throw new Error('expected an Excalidraw scene: a JSON object with an "elements" array');
  }
  return { elements: data.elements, appState: data.appState ?? {}, files: data.files ?? {} };
}

/** Whether `elements` (a scene's) has anything left to draw. */
export function hasVisibleElements(elements) {
  return elements.some((el) => el && !el.isDeleted);
}

// ---- the editor session -----------------------------------------------------

/**
 * One editing session for block `index`. DOM-free so it can be tested:
 * `load()` resolves to the block's scene; `baseline(json)` is that scene as
 * the editor serializes it, which is what "unchanged" means (the fence's own
 * text may be formatted differently, and opening a drawing must not rewrite
 * it); `change(json)` is called with the serialized scene on every
 * Excalidraw onChange and saves it (debounced) when it differs from what was
 * saved last; `flush()` saves a pending one
 * right away (tab closing or unmounting — switching tabs unmounts too, so
 * nothing is ever dropped). `onError`/`onSaved` report save outcomes. A
 * failed save stays pending, so the next change or flush tries again.
 */
export function createEditorSession({
  index,
  readBody,
  writeBody,
  onError,
  onSaved = () => {},
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
}) {
  let saved = null;
  let pending = null;
  let timer = null;
  let saving = Promise.resolve();

  const load = async () => parseScene(extractExcalidrawBlockAt(await readBody(), index));

  const baseline = (json) => {
    saved = fenceSafeJson(json);
  };

  const save = (json) => {
    saving = saving.then(async () => {
      if (json === saved) return;
      try {
        const body = await readBody();
        await writeBody(replaceExcalidrawBlockAt(body, index, json));
        saved = json;
        if (pending === json) pending = null;
        onSaved();
      } catch (err) {
        onError(`Drawing save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return saving;
  };

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    return pending === null ? saving : save(pending);
  };

  const change = (json) => {
    // Before the baseline there's nothing to compare against.
    if (saved === null) return;
    const safe = fenceSafeJson(json);
    if (safe === saved && pending === null) return;
    pending = safe;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void save(pending);
    }, debounceMs);
  };

  return { load, baseline, change, flush };
}

// ---- loading Excalidraw -----------------------------------------------------

let excalidrawModule = null;
function loadExcalidraw(baseUrl) {
  if (excalidrawModule) return excalidrawModule;
  // Excalidraw fetches its fonts from here, not from a CDN.
  window.EXCALIDRAW_ASSET_PATH = `${baseUrl}${VENDOR}`;
  // A saved scene's `source`, read once as the module loads: otherwise the
  // webview's own origin goes into every note.
  window.EXCALIDRAW_EXPORT_SOURCE ??= "mahfouz";
  if (!document.querySelector("link[data-mahfouz-excalidraw]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${baseUrl}${STYLESHEET}`;
    link.setAttribute("data-mahfouz-excalidraw", "");
    document.head.appendChild(link);
  }
  excalidrawModule = import(`${baseUrl}${MODULE}`).catch((err) => {
    excalidrawModule = null;
    throw new Error(`failed to load Excalidraw: ${err instanceof Error ? err.message : String(err)}`);
  });
  return excalidrawModule;
}

// ---- published pages --------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Whether `svg` keeps the rules a published page's drawing must (the
 * publishing service's allowlist, which is stricter): no <foreignObject>,
 * script, image or other embedded document, no link, no event attribute,
 * no reference outside the document (`href` only `#…`, `url()` only
 * `url(#…)`) and no @import or @font-face. A quick screen so a render that
 * would be refused is published as code straight away; the service still
 * checks every element.
 */
export function isPublishableSvg(svg) {
  if (typeof svg !== "string" || !/^<svg[\s>]/.test(svg)) return false;
  if (/<(?:[\w-]+:)?(?:foreignObject|script|iframe|object|embed|image|a|animate\w*|set)[\s/>]/i.test(svg)) return false;
  if (/\son[a-z]+\s*=/i.test(svg)) return false;
  for (const m of svg.matchAll(/\s(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!m[2].trim().startsWith("#")) return false;
  }
  for (const m of svg.matchAll(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi)) {
    if (!m[2].startsWith("#")) return false;
  }
  return !/@import|@font-face|javascript:/i.test(svg);
}

/**
 * `svg` (Excalidraw's `exportToSvg` result, drawn without inlined fonts)
 * made fit for a published page: its <metadata> (the scene's own JSON, for
 * reopening an exported file in Excalidraw) and any font <style> left out.
 * Text stays SVG text in Excalidraw's font families, which a page without
 * those fonts draws in its fallback.
 */
export function cleanExportedSvg(svg) {
  for (const name of ["metadata", "style"]) {
    for (const el of [...svg.getElementsByTagNameNS(SVG_NS, name)]) el.remove();
  }
  return svg;
}

/**
 * The renderer for `host.registerPublishRenderer`: the fence's scene drawn
 * by Excalidraw's `exportToSvg` in light mode, without a background or
 * inlined fonts, cleaned by `cleanExportedSvg` and serialized with
 * XMLSerializer. Null for an empty or invalid scene, on any error, or for
 * an SVG that fails `isPublishableSvg` (an embedded image, for one).
 * `deps` exist for tests.
 */
export function createPublishRenderer(host, deps = {}) {
  const load = deps.loadExcalidraw ?? (() => loadExcalidraw(host.plugin.baseUrl));
  const serialize = deps.serialize ?? ((node) => new XMLSerializer().serializeToString(node));

  return async (_lang, source) => {
    try {
      const scene = parseScene(source);
      if (!hasVisibleElements(scene.elements)) return null;
      const lib = await load();
      const restored = lib.restore(scene, null, null);
      const svg = await lib.exportToSvg({
        elements: lib.getNonDeletedElements(restored.elements),
        appState: { ...restored.appState, exportBackground: false, exportWithDarkMode: false, exportScale: 1 },
        files: restored.files,
        exportPadding: 10,
        skipInliningFonts: true,
      });
      const text = serialize(cleanExportedSvg(svg));
      return isPublishableSvg(text) ? text : null;
    } catch {
      return null;
    }
  };
}

// ---- the app's side: embed + tab ----------------------------------------------

function createRenderer(host) {
  const openEditor = (note, ordinal) => {
    if (!note || ordinal < 0) return;
    void host.openTab("editor", note, String(ordinal));
  };

  return {
    label: "Excalidraw drawing",
    snippet: STARTER_JSON,

    async render(container, source, theme, _context) {
      container.innerHTML = "";
      const preview = document.createElement("div");
      preview.className = "cm-excalidraw-preview";
      preview.setAttribute("style", "cursor:pointer;");
      container.appendChild(preview);
      // The app owns the click: it opens the viewer, or `edit` below when
      // the diagram is empty.

      const EMPTY = "Empty drawing — click to open the editor";
      try {
        const scene = parseScene(source);
        if (!hasVisibleElements(scene.elements)) {
          preview.textContent = EMPTY;
          return;
        }
        const lib = await loadExcalidraw(host.plugin.baseUrl);
        const restored = lib.restore(scene, null, null);
        const svg = await lib.exportToSvg({
          elements: lib.getNonDeletedElements(restored.elements),
          appState: { ...restored.appState, exportBackground: false, exportWithDarkMode: theme === "dark", exportScale: 1 },
          files: restored.files,
          exportPadding: 10,
        });
        svg.setAttribute("style", "max-width:100%;height:auto;display:block;");
        preview.appendChild(svg);
      } catch (err) {
        host.ui.showError(preview, `Excalidraw preview failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    // The embed's edit button opens the editor too, rather than revealing
    // the raw JSON. (Older apps ignore this and still reveal the JSON.)
    edit(context) {
      openEditor(context.note, context.ordinal);
    },

    // An excalidraw block is unusable hand-edited, so inserting one from
    // the toolbar goes straight to the editor instead.
    onInsertedAt(view, from, note) {
      openEditor(note, countExcalidrawBlocksBefore(view.state.doc.toString(), from));
    },
  };
}

function createEditorTab(host) {
  return {
    id: "editor",
    icon: "✎",
    render(container, ctx) {
      const index = Number(ctx.arg);
      const banner = document.createElement("div");
      banner.setAttribute("role", "alert");
      banner.hidden = true;
      container.appendChild(banner);

      const mount = document.createElement("div");
      mount.setAttribute("style", "position:relative;flex:1;min-height:0;height:100%;");
      container.appendChild(mount);

      const showError = (message) => {
        console.error(message);
        host.ui.showError(banner, message);
        banner.hidden = false;
      };

      const session = createEditorSession({
        index,
        readBody: ctx.readBody,
        writeBody: ctx.writeBody,
        // Excalidraw shows no save state of its own, so a failure must be
        // impossible to miss: shown above the editor, and in the console.
        onError: showError,
        onSaved() {
          banner.hidden = true;
        },
      });

      let root = null;
      let disposed = false;
      let theme = ctx.theme ?? "light";
      let draw = () => {};

      void (async () => {
        let lib;
        let scene;
        try {
          [lib, scene] = await Promise.all([loadExcalidraw(host.plugin.baseUrl), session.load()]);
        } catch (err) {
          showError(`Couldn't open the drawing: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (disposed) return;
        const initialData = lib.restore(scene, null, null);
        session.baseline(lib.serializeAsJSON(initialData.elements, initialData.appState, initialData.files, "local"));
        const onChange = (elements, appState, files) => {
          session.change(lib.serializeAsJSON(elements, appState, files, "local"));
        };
        root = lib.createRoot(mount);
        draw = () =>
          root.render(
            lib.createElement(lib.Excalidraw, {
              initialData: { ...initialData, scrollToContent: true },
              theme,
              onChange,
              name: ctx.note.title,
              UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false } },
            })
          );
        draw();
      })();

      const unsubscribe = ctx.onThemeChange?.((next) => {
        theme = next;
        draw();
      });

      return () => {
        disposed = true;
        unsubscribe?.();
        void session.flush();
        root?.unmount();
      };
    },
  };
}

export function activate(host) {
  host.registerEmbed("excalidraw", createRenderer(host));
  host.registerTabType(createEditorTab(host));
  // Absent in apps older than published diagrams.
  host.registerPublishRenderer?.(["excalidraw"], createPublishRenderer(host));

  if (host.isEnabled()) {
    host.registerToolbarItem({
      kind: "button",
      id: "new-drawing",
      label: "New drawing",
      run: () => {
        if (!host.editor.insertEmbed("excalidraw")) host.toast("Open a note in the editor first, then add the drawing.");
      },
    });
  }
}
