// draw.io diagrams for Mahfouz: renders ```drawio fenced blocks (the
// diagram's XML) as static previews, and edits one in a tab running the
// draw.io web app in embed mode.
//
// The web app isn't bundled here: the install step unpacks the pinned
// jgraph/drawio release's `src/main/webapp` into `webapp/`, served from
// the plugin's own URL. Single file on purpose; see the README's note on
// frontend modules.

const WEBAPP = "webapp/drawio-31.4.6/src/main/webapp/";

// draw.io's own autosave debounce is internal to the (unvendored) web app,
// so this one collapses a burst of autosave events into one note save —
// the same cadence as the app's own editor saves.
const AUTOSAVE_DEBOUNCE_MS = 400;

const STARTER_XML =
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
  '<root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel>';

// ---- ```drawio blocks in a note body ------------------------------------
//
// A diagram is addressed by its ordinal among the note's ```drawio fences
// (0-based, document order). The app hands the same ordinal to the embed
// renderer (computed from the full syntax tree, not just what's on
// screen), so a preview click and these body-text helpers always agree.

/** Matches a ```drawio fenced block, tolerating CRLF line endings. */
function fenceRe() {
  return /```drawio\r?\n([\s\S]*?)\r?\n```/g;
}

/** The `index`-th ```drawio block's XML, or "" if there isn't one (yet). */
export function extractDrawioBlockAt(body, index) {
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
 * Replaces the `index`-th ```drawio block's XML. Throws when there's no
 * such block: the note changed underneath the editor, and writing to the
 * wrong block would be worse than failing loudly.
 */
export function replaceDrawioBlockAt(body, index, xml) {
  let count = 0;
  let matched = false;
  const result = body.replace(fenceRe(), (full) => {
    const hit = count === index;
    count += 1;
    if (!hit) return full;
    matched = true;
    return "```drawio\n" + xml + "\n```";
  });
  if (!matched) {
    throw new Error(`replaceDrawioBlockAt: no drawio block at index ${index} (found ${count})`);
  }
  return result;
}

/** How many ```drawio blocks start before `pos` — the ordinal of a block
 * just inserted at `pos`. */
export function countDrawioBlocksBefore(body, pos) {
  const re = fenceRe();
  let match;
  let count = 0;
  while ((match = re.exec(body)) !== null) {
    if (match.index >= pos) break;
    count += 1;
  }
  return count;
}

// ---- the editor protocol --------------------------------------------------

/**
 * One editing session for block `index`, speaking draw.io's embed protocol
 * (jgraph/drawio-integration): the iframe sends {event:"init"} when ready
 * and gets {action:"load", xml, autosave:1}; with autosave on it then
 * sends {event:"autosave", xml} as the diagram changes, {event:"save", xml}
 * on an explicit save, and {event:"exit"} to leave.
 *
 * DOM-free so it can be tested: `post` sends to the iframe, `close` closes
 * the tab, `onError`/`onSaved` report save outcomes. Autosaves are
 * debounced; `flush()` saves a pending one right away (tab closing or
 * unmounting — switching tabs unmounts too, so nothing is ever dropped).
 */
export function createEditorSession({
  index,
  readBody,
  writeBody,
  post,
  close,
  onError,
  onSaved = () => {},
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
}) {
  let pending = null;
  // The body is read once up front, and `init` waits for it rather than
  // racing it.
  const initialXml = readBody().then((body) => extractDrawioBlockAt(body, index));

  const save = async (xml) => {
    try {
      const body = await readBody();
      await writeBody(replaceDrawioBlockAt(body, index, xml));
      onSaved();
    } catch (err) {
      onError(`Diagram save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const flush = () => {
    if (!pending) return Promise.resolve();
    clearTimeout(pending.timer);
    const { xml } = pending;
    pending = null;
    return save(xml);
  };

  const handle = async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.event === "init") {
      let xml = "";
      try {
        xml = await initialXml;
      } catch (err) {
        onError(`Couldn't read the diagram: ${err instanceof Error ? err.message : String(err)}`);
      }
      post({ action: "load", xml, autosave: 1 });
    } else if (msg.event === "autosave" && msg.xml) {
      if (pending) clearTimeout(pending.timer);
      const xml = msg.xml;
      pending = {
        xml,
        timer: setTimeout(() => {
          pending = null;
          void save(xml);
        }, debounceMs),
      };
    } else if (msg.event === "save" && msg.xml) {
      // An explicit save supersedes a pending autosave of an older state.
      if (pending) {
        clearTimeout(pending.timer);
        pending = null;
      }
      await save(msg.xml);
    } else if (msg.event === "exit") {
      await flush();
      close();
    }
  };

  return { handle, flush };
}

// ---- rendering a preview -------------------------------------------------

/** The text of the parse error in `doc` (a DOMParser result), or null. WebKit
 * wraps the message in a `<div>` between two headings; Gecko doesn't. */
function parseErrorOf(doc) {
  const el = doc.getElementsByTagName("parsererror")[0];
  if (!el) return null;
  return ((el.getElementsByTagName("div")[0] ?? el).textContent ?? "").trim() || "unknown parse error";
}

/**
 * Draws the diagram XML `source` into `holder` with draw.io's viewer
 * (`window.GraphViewer`), throwing a readable error for the failures the
 * viewer would otherwise swallow or leave as an empty box: no viewer, XML
 * that doesn't parse, or XML that isn't a diagram. Returns false when the
 * diagram drew but has no shapes, which would otherwise look like nothing.
 *
 * Draws only `holder`, via `createViewerForElement`: `processElements`
 * would redraw every `.mxgraph` element on the page, and catches its own
 * errors instead of reporting them.
 */
export function drawDiagram(holder, source, viewer, parseXml) {
  const drawn = createDiagramViewer(holder, source, viewer, parseXml);
  return drawn ? hasShapes(drawn.graph) : true;
}

/** Whether `graph` (an mxGraph) holds any shape or edge. */
function hasShapes(graph) {
  const model = graph?.getModel();
  if (!model) return true;
  return model.getDescendants(model.getRoot()).some((cell) => model.isVertex(cell) || model.isEdge(cell));
}

/** `drawDiagram`'s drawing: the GraphViewer it made, or null when the viewer
 * didn't call back. Throws as `drawDiagram` does. */
function createDiagramViewer(holder, source, viewer, parseXml) {
  if (!viewer?.createViewerForElement) throw new Error("draw.io's viewer didn't load");
  const doc = parseXml(source);
  const parseError = parseErrorOf(doc);
  if (parseError) throw new Error(`the diagram isn't valid XML: ${parseError}`);
  const root = doc.documentElement?.nodeName;
  if (root !== "mxfile" && root !== "mxGraphModel") {
    throw new Error(`expected an <mxfile> or <mxGraphModel> diagram, found <${root}>`);
  }
  // Draw now: by default the viewer waits until the element has a width,
  // which an empty holder in the app's fit-content embed never has until
  // something unrelated changes — so the diagram came late or not at all,
  // and any error it hit was thrown outside this call.
  holder.setAttribute("data-mxgraph", JSON.stringify({ xml: source, "check-visible-state": false }));
  let drawn = null;
  // Calls back synchronously for inline XML.
  viewer.createViewerForElement(holder, (v) => (drawn = v));
  return drawn;
}

// ---- label sanitizing -----------------------------------------------------
//
// A diagram's HTML labels are vault content, drawn as HTML in the app's page.
// draw.io's viewer already cleans each one (`Graph.sanitizeHtml`, its
// bundled DOMPurify with hooks against script, event handlers,
// `javascript:` and external CSS), but lets remote images and media (a
// request every time the note renders) and clickable links through. A
// second pass, on a fresh instance of that same DOMPurify (pinned with the
// release, none of draw.io's hooks), keeps only formatting.

/** The second pass's DOMPurify config. `style` was already checked by
 * draw.io's hook in the first pass. */
export const LABEL_PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark", "sub", "sup", "small", "big",
    "br", "hr", "p", "div", "span", "font", "center", "blockquote", "pre", "code",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th", "img",
  ],
  ALLOWED_ATTR: [
    "style", "color", "face", "size", "align", "valign", "dir", "width", "height",
    "colspan", "rowspan", "span", "border", "cellpadding", "cellspacing", "src", "alt",
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** Whether an <img> in a label may keep `src`: an inline raster or SVG
 * image only, never anything fetched. */
export function isInlineImageSrc(src) {
  return /^data:image\/(?:png|gif|jpe?g|webp|svg\+xml)[;,]/i.test(String(src ?? "").trim());
}

/**
 * Wraps `win.Graph.sanitizeHtml` (once) so its output gets the second pass.
 * Every label, tooltip and the publish export go through it. Throws when
 * draw.io's sanitizer or DOMPurify is missing or unsupported, so a viewer
 * that can't clean labels never draws.
 */
export function hardenLabelSanitizer(win) {
  const Graph = win.Graph;
  const original = Graph?.sanitizeHtml;
  if (typeof original !== "function") throw new Error("draw.io's label sanitizer didn't load");
  if (original.mahfouzStrict) return;
  const purify = typeof win.DOMPurify === "function" ? win.DOMPurify(win) : null;
  if (!purify?.isSupported || typeof purify.sanitize !== "function") {
    throw new Error("draw.io's label sanitizer isn't supported here");
  }
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName?.toUpperCase() === "IMG" && !isInlineImageSrc(node.getAttribute("src"))) node.remove();
  });
  const strict = function (value, editing) {
    return purify.sanitize(original.call(this, value, editing), LABEL_PURIFY_CONFIG);
  };
  strict.mahfouzStrict = true;
  Graph.sanitizeHtml = strict;
}

// ---- images in shapes ------------------------------------------------------
//
// An image shape (`shape=image;image=…`), `image=` on any other shape, an
// <image> inside a stencil and the page's background image are all drawn by
// the SVG canvas's `image()`, which would request their URL every time the
// note renders: a read beacon for whoever wrote the diagram. Only an inline
// image or one of the plugin's own draw.io files is drawn; any other is
// replaced by a placeholder, and the preview says how many it left out.

/** Marks a placeholder group, so the preview can count them. */
export const DROPPED_IMAGE_ATTR = "data-mahfouz-dropped-image";

/** The placeholder's tooltip. */
export const DROPPED_IMAGE_TITLE = "Image from the web not loaded";

const PLACEHOLDER_COLOR = "#9a9a94";

/**
 * The URL to draw for an image `src`, or null when it mustn't be requested:
 * an inline image as it is, or a URL that resolves (a relative one against
 * the plugin's draw.io web app, as library clip art is written) to a file
 * under `webappBase` (absolute, ending in "/"). Any other scheme is refused.
 */
export function localImageSrc(src, webappBase) {
  const value = String(src ?? "").trim();
  if (isInlineImageSrc(value)) return value;
  if (!value) return null;
  let url;
  try {
    url = new URL(value, webappBase);
  } catch {
    return null;
  }
  return url.href.startsWith(webappBase) ? url.href : null;
}

/**
 * Draws the placeholder for an image left out at (x, y, w, h) on `canvas`
 * (an mxSvgCanvas2D, so the canvas's scale, translation and rotation apply):
 * a dashed outline the image's size with an image icon, grouped under a
 * <title> and `DROPPED_IMAGE_ATTR`.
 */
export function drawImagePlaceholder(canvas, x, y, w, h) {
  const root = canvas.root;
  const first = root.childNodes.length;
  canvas.save();
  canvas.setStrokeColor(PLACEHOLDER_COLOR);
  canvas.setStrokeWidth(1);
  canvas.setDashed(true);
  canvas.setDashPattern("4 3");
  canvas.rect(x, y, w, h);
  canvas.stroke();
  canvas.setDashed(false);
  const s = Math.min(w, h, 28) * 0.8;
  if (s >= 8) {
    // A picture frame with a sun and two hills.
    const ix = x + (w - s) / 2;
    const iy = y + (h - s * 0.8) / 2;
    canvas.setStrokeWidth(1.5);
    canvas.rect(ix, iy, s, s * 0.8);
    canvas.stroke();
    canvas.begin();
    canvas.moveTo(ix + s * 0.08, iy + s * 0.72);
    canvas.lineTo(ix + s * 0.38, iy + s * 0.42);
    canvas.lineTo(ix + s * 0.6, iy + s * 0.62);
    canvas.lineTo(ix + s * 0.74, iy + s * 0.5);
    canvas.lineTo(ix + s * 0.92, iy + s * 0.72);
    canvas.stroke();
    canvas.setFillColor(PLACEHOLDER_COLOR);
    canvas.ellipse(ix + s * 0.22, iy + s * 0.18, s * 0.16, s * 0.16);
    canvas.fill();
  }
  canvas.restore();

  const doc = root.ownerDocument;
  const group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute(DROPPED_IMAGE_ATTR, "");
  const title = doc.createElementNS(SVG_NS, "title");
  title.textContent = DROPPED_IMAGE_TITLE;
  group.appendChild(title);
  for (const node of Array.prototype.slice.call(root.childNodes, first)) group.appendChild(node);
  root.appendChild(group);
}

/**
 * Wraps `win.mxSvgCanvas2D.prototype.image` (once) so it draws only what
 * `localImageSrc` allows, and a placeholder for anything else. Throws when
 * the canvas is missing, so a viewer that could fetch images never draws.
 */
export function hardenImages(win, webappBase) {
  const proto = win.mxSvgCanvas2D?.prototype;
  const original = proto?.image;
  if (typeof original !== "function") throw new Error("draw.io's image drawing didn't load");
  if (original.mahfouzLocal) return;
  const local = function (x, y, w, h, src, ...rest) {
    const allowed = localImageSrc(src, webappBase);
    if (allowed !== null) return original.call(this, x, y, w, h, allowed, ...rest);
    drawImagePlaceholder(this, x, y, w, h);
  };
  local.mahfouzLocal = true;
  proto.image = local;
}

/**
 * The globals that tell draw.io's viewer where its own files are, all under
 * `webappBase` (absolute, ending in "/"), set before the viewer loads. Its
 * defaults are draw.io's servers (`app.diagrams.net` for library images,
 * `viewer.diagrams.net` for stencils, shapes, math and an image proxy), which
 * a preview would otherwise contact, and which `hardenImages` would refuse.
 */
export function viewerPaths(webappBase) {
  return {
    DRAWIO_BASE_URL: webappBase.replace(/\/$/, ""),
    GRAPH_IMAGE_PATH: `${webappBase}img`,
    STENCIL_PATH: `${webappBase}stencils`,
    SHAPES_PATH: `${webappBase}shapes`,
    DRAW_MATH_URL: `${webappBase}math4/es5`,
    // Fetches `http:` images and fonts through draw.io's server; here a path
    // the plugin doesn't serve.
    PROXY_URL: `${webappBase}proxy`,
  };
}

/** The caption under a preview that left `count` images out, or null. */
export function droppedImagesCaption(count) {
  if (!count) return null;
  return count === 1
    ? "1 image from the web isn’t shown in previews."
    : `${count} images from the web aren’t shown in previews.`;
}

/** Adds `droppedImagesCaption` for the placeholders in `holder` to
 * `preview`, under the diagram; nothing when there are none. */
function showDroppedImages(preview, holder) {
  const text = droppedImagesCaption(holder.querySelectorAll(`[${DROPPED_IMAGE_ATTR}]`).length);
  if (!text) return;
  const caption = document.createElement("p");
  caption.className = "cm-drawio-dropped";
  caption.setAttribute("style", "display:flex;align-items:center;gap:6px;margin:4px 0 0;font-size:12.5px;color:var(--cm-muted);");
  caption.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 11l3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  caption.append(text);
  preview.appendChild(caption);
}

// ---- the app's side: embed + tab -------------------------------------------

let viewerScript = null;
function loadViewerScript(baseUrl) {
  if (viewerScript) return viewerScript;
  // Once loaded, the viewer draws every `.mxgraph` element on the page
  // unless this hook is set; each preview draws its own (`drawDiagram`).
  window.onDrawioViewerLoad ??= () => {};
  Object.assign(window, viewerPaths(new URL(`${baseUrl}${WEBAPP}`, document.baseURI).href));
  viewerScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${baseUrl}${WEBAPP}js/viewer.min.js`;
    // Nothing draws until labels get the second pass and images are kept
    // local. A viewer that can't have them stays failed: loading the same
    // script again wouldn't help.
    script.onload = () => {
      try {
        hardenLabelSanitizer(window);
        hardenImages(window, new URL(`${baseUrl}${WEBAPP}`, document.baseURI).href);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => {
      viewerScript = null;
      reject(new Error("failed to load draw.io's viewer"));
    };
    document.head.appendChild(script);
  });
  return viewerScript;
}

// ---- published pages ------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Whether `svg` keeps the rules a published page's diagram must (the
 * publishing service's allowlist, which is stricter): no <foreignObject>,
 * script, image or other embedded document, no link, no event attribute,
 * no reference outside the document (`href` only `#…`, `url()` only
 * `url(#…)`) and no @import. A quick screen so a render that would be
 * refused is published as code straight away; the service still checks
 * every element.
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
  return !/@import|javascript:/i.test(svg);
}

/**
 * The SVG of the diagram `graph` (a GraphViewer's Graph) shows, as an
 * <svg> element: draw.io's own export (`Graph.getSvg`), transparent, links
 * removed, with every label as SVG text. An HTML label is converted to
 * native SVG text (draw.io's `convertHtmlToSvg`, wrapping included); one it
 * can't convert, which the export would put in a <foreignObject>, is drawn
 * as plain text lines instead. Colours are pinned to their light side.
 */
export function exportDiagramSvg(graph, mxUtils) {
  const createSvgCanvas = graph.createSvgCanvas;
  graph.createSvgCanvas = function (...args) {
    const canvas = createSvgCanvas.apply(this, args);
    // Each label sets this from its cell's `convertToSvg` style before it
    // draws; held on for every label here.
    Object.defineProperty(canvas, "allowConvertHtmlToSvg", { get: () => true, set() {}, configurable: true });
    canvas.addForeignObject = function (x, y, w, h, str, align, valign, wrap, format, overflow, clip, rotation, dir, div) {
      const text = div ? mxUtils.extractTextWithWhitespace(div.childNodes) : String(str ?? "");
      this.plainText(x + this.state.dx, y + this.state.dy, w, h, text, align, valign, wrap, overflow, clip, rotation, dir);
    };
    return canvas;
  };
  let root;
  try {
    // (background, scale, border, nocrop, crisp, ignoreSelection, showText,
    // imgExport, linkTarget, hasShadow, incExtFonts, theme, exportType,
    // cells, noCssClass, disableLinks)
    root = graph.getSvg(null, 1, 8, false, true, true, true, null, null, false, false, null, "diagram", null, true, true);
  } finally {
    graph.createSvgCanvas = createSvgCanvas;
  }
  // A cell's link, which disableLinks only makes inert, becomes a plain
  // group: the page shows the diagram without it.
  for (const link of [...root.getElementsByTagNameNS(SVG_NS, "a")]) {
    const group = root.ownerDocument.createElementNS(SVG_NS, "g");
    for (const name of ["id", "class", "transform"]) {
      const value = link.getAttribute(name);
      if (value !== null) group.setAttribute(name, value);
    }
    while (link.firstChild) group.appendChild(link.firstChild);
    link.parentNode.replaceChild(group, link);
  }
  // light-dark() colours resolve to the light side.
  root.setAttribute("style", `${root.getAttribute("style") ?? ""} color-scheme: light;`.trim());
  return root;
}

/**
 * The renderer for `host.registerPublishRenderer`: the fence's diagram drawn
 * off screen by draw.io's viewer (as the preview is), exported by
 * `exportDiagramSvg` and serialized with XMLSerializer. Null for an empty or
 * invalid diagram, on any error, or for an SVG that fails
 * `isPublishableSvg` (an image shape, for one). Leaves nothing in the page.
 * `deps` exist for tests.
 */
export function createPublishRenderer(host, deps = {}) {
  const loadViewer =
    deps.loadViewer ?? (() => loadViewerScript(host.plugin.baseUrl).then(() => ({ viewer: window.GraphViewer, mxUtils: window.mxUtils })));
  const parseXml = deps.parseXml ?? ((xml) => new DOMParser().parseFromString(xml, "text/xml"));
  const serialize = deps.serialize ?? ((node) => new XMLSerializer().serializeToString(node));
  const doc = () => deps.document ?? document;

  return async (_lang, source) => {
    if (!source.trim()) return null;
    let holder = null;
    let drawn = null;
    try {
      const { viewer, mxUtils } = await loadViewer();
      holder = doc().createElement("div");
      holder.setAttribute("style", "position:absolute;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none;");
      holder.setAttribute("aria-hidden", "true");
      doc().body.appendChild(holder);
      drawn = createDiagramViewer(holder, source, viewer, parseXml);
      if (!drawn?.graph || !hasShapes(drawn.graph)) return null;
      const svg = serialize(exportDiagramSvg(drawn.graph, mxUtils));
      return isPublishableSvg(svg) ? svg : null;
    } catch {
      return null;
    } finally {
      try {
        drawn?.graph?.destroy?.();
      } catch {
        // The diagram is gone with its holder either way.
      }
      holder?.remove();
    }
  };
}

function createRenderer(host) {
  const openEditor = (note, ordinal) => {
    if (!note || ordinal < 0) return;
    void host.openTab("editor", note, String(ordinal));
  };

  return {
    label: "Draw.io diagram",
    snippet: STARTER_XML,

    async render(container, source, _theme, _context) {
      container.innerHTML = "";
      const preview = document.createElement("div");
      preview.className = "cm-drawio-preview";
      container.appendChild(preview);
      // The app owns the click: it opens the viewer, or `edit` below when
      // the diagram is empty.

      const EMPTY = "Empty diagram — click to open the editor";
      if (!source.trim()) {
        preview.textContent = EMPTY;
        return;
      }
      // viewer.min.js renders a static SVG from the XML without a full
      // editor, and installs `window.GraphViewer`.
      const holder = document.createElement("div");
      holder.className = "mxgraph";
      holder.setAttribute("style", "max-width:100%;");
      preview.appendChild(holder);
      try {
        await loadViewerScript(host.plugin.baseUrl);
        const parse = (xml) => new DOMParser().parseFromString(xml, "text/xml");
        if (!drawDiagram(holder, source, window.GraphViewer, parse)) preview.textContent = EMPTY;
        else showDroppedImages(preview, holder);
      } catch (err) {
        host.ui.showError(preview, `Draw.io preview failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    // The embed's edit button opens the editor too, rather than revealing
    // the raw XML. (Older apps ignore this and still reveal the XML.)
    edit(context) {
      openEditor(context.note, context.ordinal);
    },

    // A draw.io block is unusable hand-edited, so inserting one from the
    // toolbar goes straight to the editor instead.
    onInsertedAt(view, from, note) {
      openEditor(note, countDrawioBlocksBefore(view.state.doc.toString(), from));
    },
  };
}

function createEditorTab(host) {
  return {
    id: "editor",
    icon: "◇",
    render(container, ctx) {
      const index = Number(ctx.arg);
      const banner = document.createElement("div");
      banner.setAttribute("role", "alert");
      banner.hidden = true;
      container.appendChild(banner);

      const frame = document.createElement("iframe");
      frame.src = `${host.plugin.baseUrl}${WEBAPP}index.html?embed=1&proto=json&spin=1&saveAndExit=0`;
      frame.title = `Diagram editor: ${ctx.note.title}`;
      container.appendChild(frame);

      const session = createEditorSession({
        index,
        readBody: ctx.readBody,
        writeBody: ctx.writeBody,
        post: (msg) => frame.contentWindow?.postMessage(JSON.stringify(msg), "*"),
        close: ctx.close,
        // draw.io's own UI has already said "saved", so a failure must be
        // impossible to miss: shown above the editor, and in the console.
        onError(message) {
          console.error(message);
          host.ui.showError(banner, message);
          banner.hidden = false;
        },
        onSaved() {
          banner.hidden = true;
        },
      });

      const onMessage = (e) => {
        if (e.source !== frame.contentWindow) return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        void session.handle(msg);
      };
      window.addEventListener("message", onMessage);
      return () => {
        window.removeEventListener("message", onMessage);
        void session.flush();
      };
    },
  };
}

export function activate(host) {
  host.registerEmbed("drawio", createRenderer(host));
  host.registerTabType(createEditorTab(host));
  // Absent in apps older than published diagrams.
  host.registerPublishRenderer?.(["drawio"], createPublishRenderer(host));

  if (host.isEnabled()) {
    host.registerToolbarItem({
      kind: "button",
      id: "new-diagram",
      label: "New diagram",
      run: () => {
        if (!host.editor.insertEmbed("drawio")) host.toast("Open a note in the editor first, then add the diagram.");
      },
    });
  }
}
