// The wait global-top.vue runs before it removes its `.slidev-slide-loading`
// marker, which `slidev export` waits on before it renders a page. A v2
// template's fonts arrive through the stylesheet (`@import` of Google Fonts,
// `@font-face` for `/files/*.woff2`): until that stylesheet is in, the faces
// don't exist and `document.fonts.load` resolves with nothing, so each family
// is polled for first, then its 400, 700 and italic faces are loaded. The
// page's images are decoded too. Everything is capped, so an offline export
// still finishes, with the fallback fonts.

export const WAIT_CAP_MS = 5000;
const POLL_MS = 50;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const unquote = (s) => String(s).replace(/^["']|["']$/g, "");
const PLAIN = /^[\w -]+$/;

function hasFamily(fonts, family) {
  for (const face of fonts) if (unquote(face.family) === family) return true;
  return false;
}

async function loadFamily(fonts, family, deadline, pollMs) {
  while (!hasFamily(fonts, family)) {
    if (Date.now() >= deadline) return;
    await delay(pollMs);
  }
  await Promise.all(
    [`400 1em "${family}"`, `700 1em "${family}"`, `italic 400 1em "${family}"`].map((d) => fonts.load(d).catch(() => {}))
  );
}

/** Resolves "ready" once `families` are loaded and `images` decoded (a
 * failure counts as done), or "timeout" at `capMs`. `fonts` is a
 * FontFaceSet (`document.fonts`); without one, only images are waited on. */
export async function waitForAssets({ fonts, families = [], images = [], capMs = WAIT_CAP_MS, pollMs = POLL_MS }) {
  const deadline = Date.now() + capMs;
  const names = fonts ? [...new Set(families)].filter((f) => typeof f === "string" && PLAIN.test(f)) : [];
  const work = Promise.all([
    ...names.map((f) => loadFamily(fonts, f, deadline, pollMs)),
    ...Array.from(images, (img) => Promise.resolve().then(() => img.decode()).catch(() => {})),
  ]).then(async () => {
    if (Date.now() >= deadline) return "timeout";
    if (fonts) await fonts.ready;
    return "ready";
  });
  let timer;
  const cap = new Promise((r) => (timer = setTimeout(() => r("timeout"), capMs)));
  try {
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}
