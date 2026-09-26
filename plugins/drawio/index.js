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
 * that doesn't parse, or XML that isn't a diagram.
 *
 * Draws only `holder`, via `createViewerForElement`: `processElements`
 * would redraw every `.mxgraph` element on the page, and catches its own
 * errors instead of reporting them.
 */
export function drawDiagram(holder, source, viewer, parseXml) {
  if (!viewer?.createViewerForElement) throw new Error("draw.io's viewer didn't load");
  const doc = parseXml(source);
  const parseError = parseErrorOf(doc);
  if (parseError) throw new Error(`the diagram isn't valid XML: ${parseError}`);
  const root = doc.documentElement?.nodeName;
  if (root !== "mxfile" && root !== "mxGraphModel") {
    throw new Error(`expected an <mxfile> or <mxGraphModel> diagram, found <${root}>`);
  }
  holder.setAttribute("data-mxgraph", JSON.stringify({ xml: source }));
  viewer.createViewerForElement(holder);
}

// ---- the app's side: embed + tab -------------------------------------------

let viewerScript = null;
function loadViewerScript(baseUrl) {
  if (viewerScript) return viewerScript;
  // Once loaded, the viewer draws every `.mxgraph` element on the page
  // unless this hook is set; each preview draws its own (`drawDiagram`).
  window.onDrawioViewerLoad ??= () => {};
  viewerScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${baseUrl}${WEBAPP}js/viewer.min.js`;
    script.onload = () => resolve();
    script.onerror = () => {
      viewerScript = null;
      reject(new Error("failed to load draw.io's viewer"));
    };
    document.head.appendChild(script);
  });
  return viewerScript;
}

function createRenderer(host) {
  const openEditor = (note, ordinal) => {
    if (!note || ordinal < 0) return;
    void host.openTab("editor", note, String(ordinal));
  };

  return {
    label: "Draw.io diagram",
    snippet: STARTER_XML,

    async render(container, source, _theme, context) {
      container.innerHTML = "";
      const preview = document.createElement("div");
      preview.className = "cm-drawio-preview";
      container.appendChild(preview);
      // Clicking a preview opens the editor tab for this block (rather
      // than revealing the raw XML, which nobody edits by hand).
      preview.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditor(context?.note ?? null, context?.ordinal ?? -1);
      });

      if (!source.trim()) {
        preview.textContent = "Empty diagram — click to open the editor";
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
        drawDiagram(holder, source, window.GraphViewer, (xml) => new DOMParser().parseFromString(xml, "text/xml"));
      } catch (err) {
        host.ui.showError(preview, `Draw.io preview failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
}
