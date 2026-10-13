// Serves a deck's root-absolute attachment links (`/files/<name>`, in note
// bodies and in a slides template's CSS) from the vault that run belongs
// to. Every Slidev process (Present's dev server, and each `slidev export`,
// which runs one too) has one entry file; the sidecar writes the vault's
// link id into its headmatter (VAULT_KEY), and this reads it on every
// request. So Present for one vault and an export or preview of another,
// running at once, each get their own vault's files: there's no shared
// `public/files` link for one run to repoint under another.
//
// Vault content is untrusted, and its script runs on the server's origin,
// so this serves less than a public dir would: regular files whose real
// path is inside the vault's own `files/` directory, itself a real
// directory of the vault. A symlink leading out of it, `..`, or a vault
// that isn't linked under `vaults/` is a 404.
//
// The Vue compiler turns `<img src="/files/x.png">` in a slide into an
// import of `/files/x.png`, which Vite would look up in the public dir. The
// import resolves here instead, to a module exporting the URL itself, which
// the browser then fetches through the middleware.
//
// Files are streamed, and a single `Range: bytes=…` gets a 206 (a 416 when
// it lies past the end), so a deck's `<video src="/files/…">` can seek. A
// malformed or multi-range request, or one with `If-Range` (nothing here
// sends a validator to match it), gets the whole file.
//
// Loaded by Slidev from `setup/vite-plugins.ts`, with the run's options.

import fs from "node:fs";
import path from "node:path";

/** The entry headmatter key naming the vault's link id. */
export const VAULT_KEY = "mahfouzVault";

const PREFIX = "/files/";
const VIRTUAL = "\0mahfouz-files:";

const TYPES = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".css": "text/css",
};

/** The vault link id an entry's headmatter names, or null. */
export function entryVaultId(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!head) return null;
  const m = new RegExp(`^${VAULT_KEY}: "([0-9a-f]{16})"$`, "m").exec(head[1]);
  return m ? m[1] : null;
}

function within(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

/** The real path of `name` (already URL-decoded) in the `files/` of the
 * vault `entry` names, or null when there's none to serve. */
export function resolveVaultFile(workspace, entry, name) {
  if (!name || name.includes("\0") || name.includes("\\")) return null;
  if (name.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  let id;
  try {
    id = entryVaultId(fs.readFileSync(entry, "utf8"));
  } catch {
    return null;
  }
  if (!id) return null;
  try {
    const vault = fs.realpathSync(path.join(workspace, "vaults", id));
    const files = path.join(vault, "files");
    // `files/` itself must be the vault's own directory, not a link elsewhere.
    if (!fs.lstatSync(files).isDirectory()) return null;
    const real = fs.realpathSync(path.join(files, ...name.split("/")));
    if (!within(files, real) || real === files) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The name after `/files/` in a request URL, decoded, or null. */
function requestedName(url) {
  const pathname = url.replace(/[?#].*$/, "");
  if (!pathname.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(pathname.slice(PREFIX.length));
  } catch {
    return "";
  }
}

/** The `[start, end]` (inclusive) a `Range` header asks of a `size`-byte
 * file; "unsatisfiable" when it lies past the end; null to serve it whole. */
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    return suffix === 0 || size === 0 ? "unsatisfiable" : [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return [start, m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)];
}

/** The Vite plugin for one run, given Slidev's resolved options (`entry`,
 * absolute, and `userRoot`, its directory: this plugin's workspace). */
export function vaultFilesPlugin({ entry, userRoot }) {
  return {
    name: "mahfouz:vault-files",
    enforce: "pre",
    resolveId(source) {
      const clean = source.replace(/[?#].*$/, "");
      return clean.startsWith(PREFIX) ? VIRTUAL + clean : null;
    },
    load(id) {
      return id.startsWith(VIRTUAL) ? `export default ${JSON.stringify(id.slice(VIRTUAL.length))};` : null;
    },
    configureServer(server) {
      // At the front, before Vite's own public-dir and SPA handlers.
      server.middlewares.stack.unshift({
        route: "",
        handle(req, res, next) {
          const name = requestedName(req.url ?? "");
          if (name === null) return next();
          const file = resolveVaultFile(userRoot, entry, name);
          if (!file) {
            res.statusCode = 404;
            return res.end();
          }
          let fd;
          let size;
          try {
            fd = fs.openSync(file, "r");
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw new Error("not a file");
            size = stat.size;
          } catch {
            if (fd !== undefined) fs.closeSync(fd);
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Accept-Ranges", "bytes");
          const range = req.headers?.["if-range"] ? null : byteRange(req.headers?.range, size);
          if (range === "unsatisfiable") {
            fs.closeSync(fd);
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${size}`);
            res.setHeader("Content-Length", "0");
            return res.end();
          }
          const [start, end] = range ?? [0, size - 1];
          if (range) {
            res.statusCode = 206;
            res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          }
          res.setHeader("Content-Length", String(end - start + 1));
          if (req.method === "HEAD" || size === 0) {
            fs.closeSync(fd);
            return res.end();
          }
          const stream = fs.createReadStream(null, { fd, start, end });
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
        },
      });
    },
  };
}
