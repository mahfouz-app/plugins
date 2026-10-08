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
/** The vendored mermaid's version (the build doesn't expose it); plugin.json
 * pins the same one. */
export const MERMAID_VERSION = "12.0.0";

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

// ---- the editor tab: source on the left, live preview on the right -------

const PREVIEW_DEBOUNCE_MS = 250;
const SPLIT_KEY = "mahfouz.mermaid.split";
const SPLIT_DEFAULT = 40;
const SPLIT_MIN = 15;
const SPLIT_MAX = 85;
const SPLIT_STEP = 2;
const USE_SVG_EXPORT = "Use Export SVG for this diagram";
// Rendered to a PNG, an HTML label (a <foreignObject>) taints the canvas, so
// the export asks mermaid for SVG text labels instead. As a directive in the
// source, it applies to that one render: the shared instance's config,
// which the embeds render with, is never re-initialised for it.
const PNG_INIT = '%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%';

const DIAGRAM_TYPES = [
  "flowchart-elk", "flowchart", "graph", "sequenceDiagram", "classDiagram-v2", "classDiagram",
  "stateDiagram-v2", "stateDiagram", "erDiagram", "journey", "gantt", "pie", "quadrantChart",
  "requirementDiagram", "gitGraph", "C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment",
  "mindmap", "timeline", "zenuml", "sankey-beta", "sankey", "xychart-beta", "xychart", "block-beta", "block",
  "packet-beta", "packet", "kanban", "architecture-beta", "architecture", "radar-beta", "treemap-beta",
  "treemap",
];

const KEYWORDS = [
  "subgraph", "end", "direction", "participant", "actor", "loop", "alt", "else", "opt", "par", "and",
  "critical", "break", "rect", "box", "note", "over", "left of", "right of", "activate", "deactivate",
  "autonumber", "create", "destroy", "class", "classDef", "style", "linkStyle", "click", "state", "section",
  "title", "dateFormat", "axisFormat", "tickInterval", "excludes", "includes", "todayMarker", "showData",
  "accTitle", "accDescr", "as", "TB", "TD", "BT", "RL", "LR",
];

/**
 * The source pane's syntax, as `createCodeEditor` rules. They see one line
 * at a time and keep no state, so "the first line" is approximated as a
 * diagram type at the start of a line, and a `---` config block only has
 * its fences marked.
 */
export const MERMAID_LANGUAGE = {
  lineComment: "%%",
  rules: [
    // Comments, and %%{init}%% directives.
    { regex: "%%.*", token: "comment" },
    { regex: "^---\\s*$", token: "punctuation" },
    { regex: `^\\s*(?:${DIAGRAM_TYPES.join("|")})(?![\\w-])`, token: "type" },
    // Arrows of every diagram: flowchart (-->, -.->, ==>, ~~~, --o, --x),
    // class (<|--, *--, ..>), ER cardinalities (||--o{), then the one-dash
    // sequence arrows (->>, -x, -)), which need a head so a hyphenated
    // name's dash isn't one (a name with "-x" in it is marked anyway).
    {
      regex:
        "(?:<\\||\\*|[|}][|o]|<<?)?(?:-\\.+-|-{2,}|={2,}|\\.{2,}|~{3,})(?:>>|\\|>|[|o][|{]|[>)]|[ox](?!\\w))?" +
        "|<{0,2}-(?:>>|[>)x])",
      token: "operator",
    },
    { regex: '"[^"]*"?', token: "string" },
    // Edge labels: -->|label|.
    { regex: "\\|[^|]*\\|", token: "string" },
    { regex: `\\b(?:${KEYWORDS.join("|")})\\b`, token: "keyword" },
    { regex: "\\b\\d+(?:\\.\\d+)?\\b", token: "number" },
  ],
};

/** The Samples menu, in order; the first line of each is its diagram type. */
export const MERMAID_SAMPLES = [
  {
    label: "Flowchart",
    source: `flowchart TD
    Start([Idea]) --> Draft[Write a draft]
    Draft --> Review{Ready?}
    Review -->|Yes| Publish[Publish]
    Review -->|No| Draft`,
  },
  {
    label: "Sequence",
    source: `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Can we meet tomorrow?
    alt free
        B-->>A: Yes, at ten
    else busy
        B-->>A: How about Friday?
    end`,
  },
  {
    label: "Class",
    source: `classDiagram
    class Note {
        +String title
        +String body
        +save()
    }
    class Attachment {
        +String path
    }
    Note "1" --> "*" Attachment : links`,
  },
  {
    label: "State",
    source: `stateDiagram-v2
    [*] --> Draft
    Draft --> Review : submit
    Review --> Draft : changes requested
    Review --> Published : approve
    Published --> [*]`,
  },
  {
    label: "ER",
    source: `erDiagram
    AUTHOR ||--o{ NOTE : writes
    NOTE ||--o{ TAG : has
    AUTHOR {
        string name
        string email
    }
    NOTE {
        string title
        date created
    }`,
  },
  {
    label: "Gantt",
    source: `gantt
    title Project plan
    dateFormat YYYY-MM-DD
    section Design
        Research       :a1, 2026-01-05, 7d
        Mockups        :after a1, 5d
    section Build
        Implementation :b1, 2026-01-19, 14d
        Testing        :after b1, 5d`,
  },
  {
    label: "Pie",
    source: `pie title Time spent
    "Writing" : 45
    "Reading" : 30
    "Meetings" : 25`,
  },
  {
    label: "Mindmap",
    source: `mindmap
  root((Notes))
    Projects
      Website
      App
    Areas
      Health
      Finance
    Resources`,
  },
  {
    label: "Timeline",
    source: `timeline
    title Release history
    2024 : First prototype
    2025 : Public beta : Plugins
    2026 : Version 1.0`,
  },
];

/** `source` with the PNG export's directive added: first, or after a
 * leading `---` config block, which mermaid only reads at the very start. */
export function pngExportSource(source) {
  const config = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(source);
  if (!config) return `${PNG_INIT}\n${source}`;
  const head = config[0].endsWith("\n") ? config[0] : `${config[0]}\n`;
  return `${head}${PNG_INIT}\n${source.slice(config[0].length)}`;
}

/** Whether `svg` can't be drawn onto a canvas and read back: an HTML label
 * or an image that isn't inline data would taint it. */
export function needsSvgExport(svg) {
  if (/<foreignObject\b/i.test(svg)) return true;
  return [...svg.matchAll(/<image\b[^>]*?\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)].some(
    (m) => !/^data:/i.test(m[1].trim())
  );
}

/** The diagram's size in CSS pixels, from its root `<svg>`'s viewBox, else
 * its numeric width and height; null when it has neither. */
export function svgSize(svg) {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  const attr = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  const width = Number(attr("width"));
  const height = Number(attr("height"));
  return width > 0 && height > 0 ? { width, height } : null;
}

/** `<title>-diagram-<n>.<ext>`, `index` being the block's 0-based ordinal,
 * with the characters file systems refuse replaced. */
export function exportFileName(title, index, ext) {
  const safe = title
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-")
    .trim()
    .replace(/^\.+/, "");
  return `${safe || "untitled"}-diagram-${index + 1}.${ext}`;
}

/** The source pane's width, as a percentage of the tab. */
export function loadSplit() {
  try {
    const stored = localStorage.getItem(SPLIT_KEY);
    const value = stored === null ? NaN : Number(stored);
    if (Number.isFinite(value)) return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
  } catch {
    // Storage unavailable: the default.
  }
  return SPLIT_DEFAULT;
}

export function storeSplit(value) {
  try {
    localStorage.setItem(SPLIT_KEY, String(value));
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/**
 * The buttons on the banner a conflict or a failed load shows, in order.
 * Copy my version keeps the user's edits, so it comes first and is the
 * primary action; Reload from note discards them. With no editor yet (the
 * first load failed) there's nothing to copy.
 */
export function bannerActions({ hasEditor }) {
  const reload = { id: "reload", label: "Reload from note", primary: false };
  return hasEditor ? [{ id: "copy", label: "Copy my version", primary: true }, reload] : [reload];
}

/** Whether Export and Copy SVG may act: the preview shows a successful
 * render of the source as it is now, with no newer render debounced or
 * running, so all three act on the same text. */
export function canExport({ svg, current, pending }) {
  return svg !== null && current && !pending;
}

const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

const STYLE = `
.mahfouz-mermaid-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.mahfouz-mermaid-editor .mme-banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  border-bottom: 1px solid var(--cm-border); color: var(--cm-text); }
.mahfouz-mermaid-editor .mme-banner[hidden] { display: none; }
.mahfouz-mermaid-editor .mme-banner-text { flex: 1; }
.mahfouz-mermaid-editor .mme-banner button { font: inherit; padding: 2px 10px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--cm-border-strong); background: var(--cm-bg); color: var(--cm-text); }
/* Inverted text colours, not --cm-accent: white on the accent is under WCAG AA (App.css). */
.mahfouz-mermaid-editor .mme-banner button.mme-primary { background: var(--cm-text); border-color: var(--cm-text);
  color: var(--cm-bg); }
.mahfouz-mermaid-editor .mme-banner button:disabled { opacity: 0.5; cursor: default; }
.mahfouz-mermaid-editor .mme-main { flex: 1; display: flex; min-height: 0; }
.mahfouz-mermaid-editor .mme-source { min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
.mahfouz-mermaid-editor .mme-source > * { flex: 1; min-height: 0; }
.mahfouz-mermaid-editor .mme-status { padding: 12px; color: var(--cm-muted); }
.mahfouz-mermaid-editor .mme-divider { flex: 0 0 5px; cursor: col-resize; background: var(--cm-border); }
.mahfouz-mermaid-editor .mme-divider:hover, .mahfouz-mermaid-editor .mme-divider:focus-visible {
  background: var(--cm-accent); outline: none; }
.mahfouz-mermaid-editor .mme-preview { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.mahfouz-mermaid-editor .mme-viewport { flex: 1; position: relative; overflow: hidden; background: var(--cm-bg); cursor: grab; }
.mahfouz-mermaid-editor .mme-canvas { position: absolute; top: 0; left: 0; }
.mahfouz-mermaid-editor .mme-canvas > svg { display: block; }
.mahfouz-mermaid-editor .mme-canvas.mme-stale { opacity: 0.35; }
.mahfouz-mermaid-editor .mme-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center; color: var(--cm-muted); pointer-events: none; }
.mahfouz-mermaid-editor .mme-hint[hidden] { display: none; }
.mahfouz-mermaid-editor .mme-error { max-height: 30%; overflow: auto; margin: 0; padding: 8px 12px; white-space: pre-wrap;
  font-family: var(--font-stack-monospace); font-size: 0.85em; color: var(--callout-caution);
  border-top: 1px solid var(--cm-border); background: var(--cm-bg); }
/* Collapsed, not display:none, while there's no error: the live region has
   to stay in the accessibility tree for its first message to be announced. */
.mahfouz-mermaid-editor .mme-error:empty { padding: 0; border-top: 0; }
.mahfouz-mermaid-editor .mme-footer { padding: 2px 12px; font-size: 0.8em; color: var(--cm-muted);
  border-top: 1px solid var(--cm-border); text-align: right; }
`;

/** An element with a class (under the tab's root class) and optional text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Draws `svg` at twice its size onto an opaque `background` and returns
 * the PNG bytes. Throws a SecurityError when the canvas is tainted. */
async function svgToPng(svg, background) {
  const size = svgSize(svg);
  if (!size) throw new Error("the diagram has no size");
  // Sized explicitly: mermaid's own SVG is width="100%", which an <img>
  // doesn't resolve.
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") throw new Error("the diagram's SVG doesn't parse as XML");
  root.setAttribute("width", String(size.width));
  root.setAttribute("height", String(size.height));
  root.style.maxWidth = "";
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size.width * 2);
  canvas.height = Math.ceil(size.height * 2);
  const g = canvas.getContext("2d");
  g.fillStyle = background;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(2, 2);
  g.drawImage(image, 0, 0, size.width, size.height);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the PNG couldn't be encoded"))), "image/png")
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function createEditorTab(host, runtime) {
  return {
    id: "editor",
    icon: "◈",
    render(container, ctx) {
      const { createPanZoom, saveFile } = host.ui;
      let disposed = false;

      const root = el("div", "mahfouz-mermaid-editor");
      root.appendChild(el("style", "", STYLE));

      // Save failures and conflicts, above both panes.
      const banner = el("div", "mme-banner");
      banner.setAttribute("role", "alert");
      banner.hidden = true;
      const bannerText = el("span", "mme-banner-text");
      banner.appendChild(bannerText);

      const main = el("div", "mme-main");
      const source = el("div", "mme-source");
      const status = el("div", "mme-status", "Loading the diagram…");
      source.appendChild(status);
      const divider = el("div", "mme-divider");
      divider.setAttribute("role", "separator");
      divider.setAttribute("aria-orientation", "vertical");
      divider.setAttribute("aria-label", "Resize the source and preview");
      divider.setAttribute("aria-valuemin", String(SPLIT_MIN));
      divider.setAttribute("aria-valuemax", String(SPLIT_MAX));
      divider.tabIndex = 0;

      const preview = el("div", "mme-preview");
      const viewport = el("div", "mme-viewport");
      // The pan/zoom target: the viewport's first child.
      const canvas = el("div", "mme-canvas");
      viewport.appendChild(canvas);
      const hint = el(
        "div",
        "mme-hint",
        "This diagram is empty. Choose one from Samples in the toolbar, or type Mermaid on the left."
      );
      hint.hidden = true;
      // Rendered even while empty (collapsed by CSS), so the live region is
      // in the accessibility tree before its first error arrives.
      const errorStrip = el("pre", "mme-error");
      errorStrip.setAttribute("aria-live", "polite");
      preview.append(viewport, hint, errorStrip, el("div", "mme-footer", `mermaid v${MERMAID_VERSION}`));

      main.append(source, divider, preview);
      root.append(banner, main);
      container.appendChild(root);

      // ---- state ----
      let editor = null;
      // Whether the source can be edited: loaded, and no conflict.
      let editable = false;
      // The last SVG that rendered, and whether it's what the source shows.
      let lastSvg = null;
      let current = false;
      let renderTimer = null;
      // A render is debounced or running whose result isn't in yet.
      let pending = false;
      // A load is in flight; Reload waits for it.
      let loading = false;
      let renderSeq = 0;

      // ---- split ----
      let split = loadSplit();
      const applySplit = () => {
        source.style.flex = `0 0 ${split}%`;
        divider.setAttribute("aria-valuenow", String(Math.round(split)));
      };
      applySplit();
      const setSplit = (value) => {
        split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
        applySplit();
      };
      divider.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        setSplit(split + (e.key === "ArrowLeft" ? -SPLIT_STEP : SPLIT_STEP));
        storeSplit(split);
      });
      divider.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        divider.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const box = main.getBoundingClientRect();
          if (box.width > 0) setSplit(((ev.clientX - box.left) / box.width) * 100);
        };
        const up = () => {
          divider.removeEventListener("pointermove", move);
          divider.removeEventListener("pointerup", up);
          divider.removeEventListener("pointercancel", up);
          storeSplit(split);
        };
        divider.addEventListener("pointermove", move);
        divider.addEventListener("pointerup", up);
        divider.addEventListener("pointercancel", up);
      });

      // ---- pan/zoom ----
      const panZoom = createPanZoom ? createPanZoom(viewport) : null;
      // Fit on every render and resize until the user moves the view.
      let userMoved = false;
      viewport.addEventListener("wheel", () => (userMoved = true), { passive: true });
      // A drag pans; a plain click doesn't count.
      viewport.addEventListener("mousedown", (down) => {
        const up = (e) => {
          if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 4) userMoved = true;
        };
        window.addEventListener("mouseup", up, { once: true });
      });
      const placeView = () => {
        if (!panZoom) return;
        if (userMoved) panZoom.refresh();
        else panZoom.fit();
      };
      const resizes =
        panZoom && typeof ResizeObserver === "function"
          ? new ResizeObserver(() => {
              if (lastSvg && !userMoved) panZoom.fit();
            })
          : null;
      resizes?.observe(viewport);

      // ---- preview ----
      const showDiagnostics = (list) => editor?.setDiagnostics(list);

      const renderNow = async () => {
        clearTimeout(renderTimer);
        renderTimer = null;
        if (!editor) return;
        pending = true;
        const text = editor.getValue();
        renderSeq += 1;
        const seq = renderSeq;
        if (!text.trim()) {
          pending = false;
          canvas.replaceChildren();
          canvas.classList.remove("mme-stale");
          hint.hidden = false;
          errorStrip.textContent = "";
          lastSvg = null;
          current = false;
          showDiagnostics([]);
          updateToolbar();
          return;
        }
        hint.hidden = true;
        let svg;
        try {
          svg = await runtime.renderSvg(text, ctx.theme);
        } catch (err) {
          if (disposed || seq !== renderSeq) return;
          pending = false;
          const message = errorMessage(err);
          // The last good diagram stays, dimmed, above the error.
          canvas.classList.add("mme-stale");
          errorStrip.textContent = message;
          current = false;
          const at = parseErrorLocation(err);
          showDiagnostics(at ? [{ ...at, message }] : []);
          updateToolbar();
          return;
        }
        if (disposed || seq !== renderSeq) return;
        pending = false;
        canvas.innerHTML = svg;
        canvas.classList.remove("mme-stale");
        // At its natural size, so pan/zoom has something to measure.
        const size = svgSize(svg);
        const svgEl = canvas.querySelector("svg");
        if (size && svgEl) {
          svgEl.setAttribute("width", String(size.width));
          svgEl.setAttribute("height", String(size.height));
          svgEl.style.maxWidth = "none";
        }
        errorStrip.textContent = "";
        lastSvg = svg;
        current = true;
        showDiagnostics([]);
        placeView();
        updateToolbar();
      };

      const scheduleRender = () => {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => void renderNow(), PREVIEW_DEBOUNCE_MS);
        // Export and Copy wait for this render (once per burst of edits).
        if (!pending) {
          pending = true;
          updateToolbar();
        }
      };
      const offTheme = ctx.onThemeChange(() => void renderNow());

      // ---- banner ----
      const runAction = {
        copy: () => void copyText(session.source(), "Your version is copied."),
        reload: () => void load(),
      };
      const showBanner = (text, actions = []) => {
        bannerText.textContent = text;
        banner.replaceChildren(bannerText);
        for (const { id, label, primary } of actions) {
          const button = el("button", primary ? "mme-primary" : "", label);
          button.type = "button";
          button.dataset.action = id;
          button.addEventListener("click", runAction[id]);
          banner.appendChild(button);
        }
        banner.hidden = false;
      };
      const hideBanner = () => (banner.hidden = true);

      // ---- the block ----
      const session = createEditorSession({
        index: Number(ctx.arg),
        markdown: host.markdown,
        readBody: ctx.readBody,
        writeBody: ctx.writeBody,
        onConflict() {
          editable = false;
          editor?.setReadOnly(true);
          updateToolbar();
          showBanner(
            "This diagram changed outside the editor, so your edits here aren't being saved.",
            bannerActions({ hasEditor: editor !== null })
          );
        },
        onSaved() {
          if (editable) hideBanner();
        },
        onError(message) {
          console.error(message);
          showBanner(message);
        },
      });

      const load = async () => {
        // One load at a time: a second Reload click while one runs is ignored.
        if (loading) return;
        loading = true;
        const reloadButton = banner.querySelector('[data-action="reload"]');
        if (reloadButton) reloadButton.disabled = true;
        let text;
        try {
          text = await session.load();
        } catch (err) {
          if (disposed) return;
          editable = false;
          editor?.setReadOnly(true);
          status.textContent = "The diagram couldn't be read.";
          updateToolbar();
          showBanner(`Couldn't read the diagram: ${errorMessage(err)}`, bannerActions({ hasEditor: editor !== null }));
          return;
        } finally {
          loading = false;
        }
        if (disposed) return;
        if (editor) {
          editor.setValue(text);
          editor.setReadOnly(false);
        } else {
          // Made once the text is known, so undo can't go back to an empty
          // editor.
          source.replaceChildren();
          editor = host.ui.createCodeEditor(source, {
            value: text,
            language: MERMAID_LANGUAGE,
            onChange(value) {
              session.change(value);
              scheduleRender();
            },
          });
          editor.focus();
        }
        editable = true;
        hideBanner();
        updateToolbar();
        void renderNow();
      };

      // ---- toolbar ----
      const copyText = async (text, done) => {
        try {
          await navigator.clipboard.writeText(text);
          host.toast(done);
        } catch (err) {
          host.toast(`Couldn't copy: ${errorMessage(err)}`, "error");
        }
      };

      const save = async (ext, filterName, data) => {
        try {
          await saveFile({
            defaultName: exportFileName(ctx.note.title, session.index(), ext),
            filters: [{ name: filterName, extensions: [ext] }],
            data,
          });
        } catch (err) {
          host.toast(`Export failed: ${errorMessage(err)}`, "error");
        }
      };

      const exportPng = async () => {
        const text = editor.getValue();
        let svg;
        try {
          svg = await runtime.renderSvg(pngExportSource(text), ctx.theme);
        } catch (err) {
          host.toast(`Export failed: ${errorMessage(err)}`, "error");
          return;
        }
        if (needsSvgExport(svg)) {
          host.toast(USE_SVG_EXPORT, "error");
          return;
        }
        // Opaque, in the preview's own colour, so the PNG reads the same.
        const fill = getComputedStyle(viewport).backgroundColor;
        const opaque = fill && !/^rgba\(.*,\s*0\)$|^transparent$/.test(fill);
        let data;
        try {
          data = await svgToPng(svg, opaque ? fill : ctx.theme === "dark" ? "#1e1e1e" : "#ffffff");
        } catch (err) {
          const tainted = err instanceof Error && err.name === "SecurityError";
          host.toast(tainted ? USE_SVG_EXPORT : `Export failed: ${errorMessage(err)}`, "error");
          return;
        }
        await save("png", "PNG image", data);
      };

      const updateToolbar = () => {
        if (disposed) return;
        const ready = canExport({ svg: lastSvg, current, pending });
        const buttons = [
          {
            label: "Samples",
            title: "Replace the source with a sample diagram (undo brings yours back)",
            disabled: !editable,
            menu: MERMAID_SAMPLES.map((sample) => ({
              label: sample.label,
              onSelect() {
                if (!editable || !editor) return;
                editor.setValue(sample.source);
                session.change(sample.source);
                void renderNow();
              },
            })),
          },
        ];
        if (panZoom) {
          buttons.push(
            {
              label: "Zoom out",
              title: "Zoom out of the preview",
              onClick() {
                userMoved = true;
                panZoom.zoomOut();
              },
            },
            {
              label: "Zoom in",
              title: "Zoom in to the preview",
              onClick() {
                userMoved = true;
                panZoom.zoomIn();
              },
            },
            {
              label: "Fit",
              title: "Fit the diagram to the preview, and keep fitting it",
              onClick() {
                userMoved = false;
                panZoom.fit();
              },
            }
          );
        }
        if (saveFile) {
          buttons.push(
            {
              label: "Export SVG",
              title: "Save the diagram as an SVG file",
              disabled: !ready,
              onClick: () => void save("svg", "SVG image", new TextEncoder().encode(lastSvg)),
            },
            {
              label: "Export PNG",
              title: "Save the diagram as a PNG image at twice its size",
              disabled: !ready,
              onClick: () => void exportPng(),
            }
          );
        }
        buttons.push({
          label: "Copy SVG",
          title: "Copy the diagram's SVG markup",
          disabled: !ready,
          onClick: () => void copyText(lastSvg, "SVG copied."),
        });
        ctx.setToolbar(buttons);
      };

      updateToolbar();
      void load();

      return () => {
        disposed = true;
        clearTimeout(renderTimer);
        offTheme();
        resizes?.disconnect();
        panZoom?.dispose();
        void session.flush();
        editor?.destroy();
      };
    },
  };
}

export function activate(host) {
  const runtime = createMermaidRuntime(host);
  const renderer = createMermaidRenderer(host, { runtime });
  // The editor tab needs the host's block splicing and code editor; an
  // older app gets the embed alone, and its edit button reveals the source.
  if (host.markdown?.fencedBlocks && host.markdown?.replaceFencedBlock && host.ui?.createCodeEditor) {
    const openEditor = (note, ordinal) => {
      if (!note || ordinal < 0) return;
      void host.openTab("editor", note, String(ordinal));
    };
    host.registerTabType(createEditorTab(host, runtime));
    // Only the edit button opens the tab; a plain click on the diagram
    // still reveals its source in the note.
    renderer.edit = (context) => openEditor(context.note, context.ordinal);
    // A block inserted from the toolbar opens in the editor. Its ordinal
    // counts the blocks whose content starts before its fence.
    renderer.onInsertedAt = (view, from, note) => {
      const blocks = host.markdown.fencedBlocks(view.state.doc.toString(), "mermaid");
      openEditor(note, blocks.filter((b) => b.from < from).length);
    };
  }
  host.registerEmbed("mermaid", renderer);
}
