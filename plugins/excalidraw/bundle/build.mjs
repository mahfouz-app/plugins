// Builds the Excalidraw bundle the mahfouz/excalidraw plugin downloads:
// `dist/excalidraw.js` (entry.js and everything it imports, with its lazy
// chunks beside it in `dist/chunks/`), `dist/excalidraw.css`, and
// Excalidraw's fonts in `dist/fonts/`, where the plugin points
// `window.EXCALIDRAW_ASSET_PATH`. Then packs `dist/` as
// `excalidraw-bundle.tar.gz`, byte-reproducibly (sorted entries, fixed
// times and owners, gzip without a timestamp), so the same lockfile always
// gives the same sha256.
//
//   npm ci && node build.mjs        (on Node 22)
//
// .github/workflows/excalidraw-release.yml runs this and attaches the
// archive to a release.

import { build } from "esbuild";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

// gzip's output differs between Node's zlib versions (26 compresses
// differently from 22), so the sha256 only holds on the Node that CI and the
// release build with.
const NODE_MAJOR = "22";
if (process.versions.node.split(".")[0] !== NODE_MAJOR) {
  console.error(`build.mjs needs Node ${NODE_MAJOR} (this is ${process.versions.node}): npx -y node@${NODE_MAJOR} build.mjs`);
  process.exit(1);
}

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "dist");
const pkg = join(here, "node_modules/@excalidraw/excalidraw");

rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: { excalidraw: join(here, "entry.js") },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  target: "es2022",
  conditions: ["production"],
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: { ".woff2": "file", ".png": "file", ".svg": "file" },
  legalComments: "linked",
  logLevel: "warning",
});

cpSync(join(pkg, "dist/prod/fonts"), join(dist, "fonts"), { recursive: true });

// ---- a reproducible tar.gz of dist/ ---------------------------------------

/** Every directory (as "dir/") and file under `dir`, relative to `root`, a
 * directory before what's in it. */
function entries(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const path = join(dir, e.name);
      return e.isDirectory() ? [`${relative(root, path)}/`, ...entries(path, root)] : [relative(root, path)];
    })
    .sort();
}

function header(name, size, isDir) {
  const h = Buffer.alloc(512);
  const put = (value, offset, length) => h.write(value, offset, length, "utf8");
  const octal = (n, length) => n.toString(8).padStart(length - 1, "0") + "\0";
  if (Buffer.byteLength(name) > 100) {
    // ustar's prefix field holds what's before a "/" the rest fits after.
    const cut = name.indexOf("/", name.length - 101);
    if (cut < 0 || cut > 155) throw new Error(`path too long for ustar: ${name}`);
    put(name.slice(0, cut), 345, 155);
    name = name.slice(cut + 1);
  }
  put(name, 0, 100);
  put(octal(isDir ? 0o755 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8);
  put(isDir ? "5" : "0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 7) + " ", 148, 8);
  return h;
}

const parts = [];
for (const name of entries(dist)) {
  if (name.endsWith("/")) {
    parts.push(header(name, 0, true));
    continue;
  }
  const data = readFileSync(join(dist, name));
  parts.push(header(name, data.length, false), data, Buffer.alloc((512 - (data.length % 512)) % 512));
}
parts.push(Buffer.alloc(1024));
const archive = join(here, "excalidraw-bundle.tar.gz");
const gz = gzipSync(Buffer.concat(parts), { level: 9 });
// The header's OS byte is zlib's build platform; pin it to Unix so macOS
// and Linux builds agree.
gz[9] = 3;
writeFileSync(archive, gz);
console.log(`wrote ${relative(process.cwd(), archive)}`);
