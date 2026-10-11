// What a presented note can reach through the Slidev dev server. A note is
// vault content, which a collaborator's commit can change, and Slidev runs
// its HTML and Vue as script on the deck's localhost origin. That script
// can talk to the dev server, so the server is cut down to what Present
// and export use: reading.
//
// - Slidev's `monaco-write` (a `<<< file {monaco-write}` snippet, then a
//   WebSocket message) writes any file under the project root, which is
//   this plugin's own directory: `sidecar.js` included, which Node runs at
//   the next start. Its server hook is removed.
// - The dev server's POST endpoints write slide edits back into the source
//   note, and Vite's `/__open-in-editor` opens a local editor. Present
//   doesn't use either, so anything but GET/HEAD and that path is refused.
//
// Loaded by Slidev from `setup/vite-plugins.ts`, in the dev server and in
// `slidev export` (which runs one too).

export const MONACO_WRITE = "slidev:monaco-write";

/** Why the dev server refuses `req`, as an HTTP status, or null to let it
 * through. */
export function refusal(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return 405;
  if ((req.url ?? "").startsWith("/__open-in-editor")) return 403;
  return null;
}

/** Disables `monaco-write` in a resolved Vite config. Fails closed: a
 * Slidev that renamed the plugin makes the server refuse to start rather
 * than leave it writable. */
export function disableMonacoWrite(config) {
  if (config.command !== "serve") return;
  const plugin = config.plugins.find((p) => p?.name === MONACO_WRITE);
  if (!plugin) throw new Error(`[mahfouz] Slidev's ${MONACO_WRITE} plugin wasn't found; refusing to start without disabling it`);
  delete plugin.configureServer;
}

export function hardenPlugin() {
  return {
    name: "mahfouz:harden",
    enforce: "pre",
    configResolved: disableMonacoWrite,
    configureServer(server) {
      // At the front of the stack, not appended: Slidev's own plugins
      // register their endpoints before this one runs.
      server.middlewares.stack.unshift({
        route: "",
        handle(req, res, next) {
          const status = refusal(req);
          if (status === null) return next();
          res.statusCode = status;
          res.end();
        },
      });
    },
  };
}
