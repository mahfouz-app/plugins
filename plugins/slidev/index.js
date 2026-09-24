// Slidev presentations for Mahfouz (mahfouz/slidev).
//
// - "Present" in a note's menu opens a presentation tab.
// - "Present full screen" (Mod+Shift+P by default) shows the note over the
//   whole app.
// - An API for the PDF export plugin (`host.use("mahfouz/slidev")`).
//
// Slidev itself runs in this plugin's sidecar (sidecar.js); this module
// only shows what it serves. Loaded only as PDF export's dependency (the
// vault has Present off), it provides its API and adds no UI and no server.
// Single file on purpose; see the README's note on frontend modules.

// A deck loaded against a server that was just spawned comes up with
// unstyled chrome and never recovers; one reload after the first paint
// fixes it.
const COLD_START_RELOAD_MS = 1500;

const PRESENT_ICON =
  '<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M10 8l4 2-4 2z" /><path d="M8 20h8M12 16v4" />';

// ---- the engine: the sidecar's methods ---------------------------------------

/** The sidecar calls the UI uses (see sidecar.js for what each does). */
export function sidecarEngine(host) {
  const call = (method, params) => host.sidecar.call(method, params);
  return {
    ready: () => call("ready"),
    warm: () => call("warm"),
    start: (vaultPath, relPath) => call("start", { vaultPath, relPath }),
    exportPdf: (vaultPath, relPath, { orientation, content }) =>
      call("export", { vaultPath, relPath, orientation, content }),
    stop: () => call("stop"),
    log: () => call("log"),
  };
}

// ---- presentation tag --------------------------------------------------------

/**
 * Adds `presentation` to a note's `type` attribute the first time it's
 * presented — the vault-open plugin wizard's signal that Slidev is in use
 * (any note can be presented, so there's no body syntax to detect). Appends
 * to an existing value and returns the same object when already tagged.
 */
export function withPresentationType(attributes) {
  const types = (attributes.type ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (types.includes("presentation")) return attributes;
  return { ...attributes, type: [...types, "presentation"].join(", ") };
}

// ---- getting a note on screen ------------------------------------------------

/**
 * Checks Node, points the server at the note (starting it if needed), and
 * reports each phase: checking → starting → running, or error.
 */
export function startDeck(engine, target, onPhase) {
  let attempt = 0;
  const run = async () => {
    const mine = ++attempt;
    const set = (p) => {
      if (mine === attempt) onPhase(p);
    };
    try {
      set({ kind: "checking" });
      await engine.ready();
      set({ kind: "starting" });
      const { vaultPath, relPath } = await target();
      const running = await engine.start(vaultPath, relPath);
      set({ kind: "running", url: running.url, fresh: running.fresh });
    } catch (err) {
      console.error("slidev start failed", err);
      let message = err instanceof Error ? err.message : String(err);
      const nodeMissing = /needs Node\.js/.test(message);
      if (!nodeMissing) {
        try {
          const log = String((await engine.log()) ?? "").trim();
          if (log) message += `\n\n${log}`;
        } catch {
          // The log is a nicety; the error above is what matters.
        }
      }
      set({ kind: "error", title: nodeMissing ? "Node.js not found" : "Slidev could not start", message });
    }
  };
  void run();
  return {
    retry: () => void run(),
    restart: () => void Promise.resolve(engine.stop()).finally(() => void run()),
    dispose: () => {
      attempt += 1;
    },
  };
}

/** The non-running phases as a status panel (the app's presentation-* styles). */
function renderDeckStatus(el, phase, onRetry) {
  el.replaceChildren();
  el.className = "presentation-status";
  if (phase.kind !== "error") {
    const spinner = document.createElement("span");
    spinner.className = "presentation-spinner";
    spinner.setAttribute("aria-label", "Loading slides");
    el.appendChild(spinner);
    return;
  }
  const title = document.createElement("p");
  title.className = "presentation-status-title";
  title.textContent = phase.title;
  const log = document.createElement("pre");
  log.className = "presentation-log";
  log.textContent = phase.message;
  const retry = document.createElement("button");
  retry.className = "presentation-cta";
  retry.textContent = "Retry";
  retry.addEventListener("click", onRetry);
  el.append(title, log, retry);
}

// ---- the fullscreen deck frame -------------------------------------------------
//
// One long-lived iframe over the whole window for fullscreen presenting.
// Slidev in dev mode paints progressively while hundreds of modules stream
// in, so a page load in front of the user always flashes unstyled content.
// This frame is created hidden as soon as the server is up and stays
// loaded; presenting a note only rewrites the server's stub deck, which
// Slidev applies inside the loaded page (an HMR patch, or a full reload when
// the note's feature set differs). The frame is only revealed once the page
// has settled, and any reload happens while it's hidden.

const FRAME_ID = "mahfouz-slidev-deck-frame";
// How long after a stub rewrite to watch for Slidev starting a full reload.
const SWAP_WATCH_MS = 700;
const SETTLE_MS = 250;
// Never leave the user staring at black.
const REVEAL_TIMEOUT_MS = 6000;
// display:none (not visibility:hidden) so the hidden frame leaves the
// compositor's layer tree: a visibility toggle can leave a stale layer that
// survives the window's fullscreen-exit transition and keeps painting the
// last slide over the editor.
const FRAME_CSS = `#${FRAME_ID}{position:fixed;inset:0;z-index:1001;width:100%;height:100%;border:0;background:#000;display:none;pointer-events:none}#${FRAME_ID}.is-visible{display:block;pointer-events:auto}`;

const deck = { frame: null, style: null, url: null, settled: Promise.resolve(), hideTimer: null, generation: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function navigate(el, url) {
  const done = new Promise((resolve) => el.addEventListener("load", () => resolve(), { once: true }));
  el.src = url;
  deck.settled = done;
  return done;
}

/** Makes sure the hidden frame exists and shows `url`. With `cold` it
 * reloads itself once after its first paint, still hidden. */
function ensureDeckFrame(url, cold = false) {
  if (deck.frame && deck.url === url) return deck.settled;
  if (!deck.frame) {
    deck.style = document.createElement("style");
    deck.style.textContent = FRAME_CSS;
    document.head.appendChild(deck.style);
    deck.frame = document.createElement("iframe");
    deck.frame.id = FRAME_ID;
    deck.frame.title = "Presentation";
    deck.frame.allow = "fullscreen";
    deck.frame.setAttribute("aria-hidden", "true");
    document.body.appendChild(deck.frame);
  }
  const el = deck.frame;
  deck.url = url;
  const first = navigate(el, url);
  if (!cold) return first;
  deck.settled = (async () => {
    await first;
    await sleep(COLD_START_RELOAD_MS);
    if (deck.url === url) await navigate(el, url);
  })();
  return deck.settled;
}

/** Reveals the frame once the page for the new stub has settled. */
async function showDeckFrame(url) {
  const gen = ++deck.generation;
  if (deck.hideTimer !== null) {
    clearTimeout(deck.hideTimer);
    deck.hideTimer = null;
  }
  const reveal = (async () => {
    await ensureDeckFrame(url);
    if (deck.frame) {
      const reloaded = new Promise((resolve) => deck.frame.addEventListener("load", () => resolve(), { once: true }));
      await Promise.race([reloaded, sleep(SWAP_WATCH_MS)]);
    }
    await sleep(SETTLE_MS);
  })();
  await Promise.race([reveal, sleep(REVEAL_TIMEOUT_MS)]);
  // Superseded by a hide (e.g. Esc while still settling).
  if (gen !== deck.generation || !deck.frame) return;
  deck.frame.classList.add("is-visible");
  deck.frame.removeAttribute("aria-hidden");
  deck.frame.focus();
}

/** Hides the frame, then — out of sight — reloads it so the next
 * presentation starts on slide one. */
function hideDeckFrame() {
  deck.generation++;
  if (!deck.frame) return;
  deck.frame.classList.remove("is-visible");
  deck.frame.setAttribute("aria-hidden", "true");
  if (deck.hideTimer !== null) clearTimeout(deck.hideTimer);
  deck.hideTimer = setTimeout(() => {
    deck.hideTimer = null;
    if (deck.frame && deck.url) void navigate(deck.frame, deck.url);
  }, 50);
}

/** Removes the frame and its styles (the plugin is unloading). */
function destroyDeckFrame() {
  hideDeckFrame();
  deck.frame?.remove();
  deck.style?.remove();
  Object.assign(deck, { frame: null, style: null, url: null, settled: Promise.resolve() });
}

// ---- the tab and the overlay ---------------------------------------------------

function renderPresentTab(host, engine, container, ctx, target) {
  let url = null;
  let phase = { kind: "checking" };
  const status = document.createElement("div");
  const frame = document.createElement("iframe");
  frame.className = "presentation-frame";
  frame.title = `Presentation: ${ctx.note.title}`;
  frame.allow = "fullscreen";
  let coldReloadPending = false;
  frame.addEventListener("load", () => {
    // Slidev navigates with the keyboard; focus it without a click first.
    frame.focus();
    if (!coldReloadPending) return;
    coldReloadPending = false;
    setTimeout(() => {
      if (url) frame.src = url;
    }, COLD_START_RELOAD_MS);
  });

  let session = null;
  const toolbar = () => {
    const running = phase.kind === "running";
    ctx.setToolbar([
      { label: "Reload", title: "Reload the deck", disabled: !running, onClick: () => url && (frame.src = url) },
      {
        label: "Presenter",
        title: "Open presenter view (notes, timer) in your browser",
        disabled: !running,
        onClick: () => url && void host.ui.openExternal(`${url}presenter/`),
      },
      { label: "Browser", title: "Open the deck in your browser", disabled: !running, onClick: () => url && void host.ui.openExternal(url) },
      { label: "Restart", title: "Restart the Slidev server", disabled: phase.kind === "starting", onClick: () => session?.restart() },
    ]);
  };

  renderDeckStatus(status, phase, () => session?.retry());
  container.appendChild(status);
  toolbar();
  session = startDeck(engine, target, (next) => {
    phase = next;
    if (next.kind === "running") {
      url = next.url;
      coldReloadPending = next.fresh;
      status.remove();
      frame.src = next.url;
      if (!frame.isConnected) container.appendChild(frame);
    } else {
      frame.remove();
      renderDeckStatus(status, next, () => session?.retry());
      if (!status.isConnected) container.appendChild(status);
    }
    toolbar();
  });
  return () => session.dispose();
}

/** Overlay content: a status panel until the shared, pre-warmed deck frame
 * points at this note and is safe to reveal. */
function renderOverlay(engine, container, target) {
  let alive = true;
  const status = document.createElement("div");
  container.appendChild(status);
  let session = null;
  renderDeckStatus(status, { kind: "checking" }, () => session?.retry());
  session = startDeck(engine, target, (phase) => {
    renderDeckStatus(status, phase, () => session?.retry());
    if (phase.kind !== "running") return;
    void showDeckFrame(phase.url)
      .then(() => {
        if (alive) status.remove();
      })
      .catch(console.error);
  });
  return () => {
    alive = false;
    session.dispose();
    hideDeckFrame();
  };
}

// ---- activation ----------------------------------------------------------------

export function activate(host, engine = sidecarEngine(host)) {
  const target = (note) => async () => {
    const info = await host.notes.get(note);
    return { vaultPath: info.vaultPath, relPath: info.path };
  };

  host.provide({
    /** Renders a note to a PDF in the temp dir; returns the file's path. */
    async exportPdf(note, options, progress) {
      await engine.ready();
      progress("Exporting…");
      const { vaultPath, relPath } = await target(note)();
      try {
        return await engine.exportPdf(vaultPath, relPath, options);
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err);
        const log = String((await Promise.resolve(engine.log()).catch(() => "")) ?? "").trim();
        if (log) message += `\n\n${log}`;
        throw new Error(message);
      }
    },
  });

  // Only here for PDF export, which runs its own one-shot render.
  if (!host.isEnabled()) return;

  // Start the server now and load the hidden deck frame, so the first
  // Present of the session doesn't load anything in front of the user.
  void Promise.resolve(engine.warm())
    .then((url) => (url ? ensureDeckFrame(url, true) : undefined))
    .catch((err) => console.warn("slidev warm-up failed", err));

  host.registerTabType({
    id: "present",
    icon: "▶",
    render: (container, ctx) => renderPresentTab(host, engine, container, ctx, target(ctx.note)),
  });

  host.registerCommand({
    id: "present",
    label: "Present",
    icon: PRESENT_ICON,
    noteMenu: true,
    run: (note) => host.openTab("present", note, ""),
  });

  host.registerCommand({
    id: "present-fullscreen",
    label: "Present full screen",
    shortcut: "Mod+Shift+P",
    run(note) {
      void host.notes
        .updateAttributes(note, withPresentationType)
        .catch((err) => console.warn("marking the note as a presentation failed", err));
      host.ui.openOverlay({
        title: `Presenting ${note.title}`,
        render: (container) => renderOverlay(engine, container, target(note)),
      });
    },
  });
}

// The app stops the sidecar (and with it the server) when unloading.
export function deactivate() {
  destroyDeckFrame();
}
