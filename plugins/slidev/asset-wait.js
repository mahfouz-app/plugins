// The wait global-top.vue runs before it removes its `.slidev-slide-loading`
// marker, which `slidev export` waits on before it renders a page. A v2
// template's fonts arrive through the stylesheet (`@import` of Google Fonts,
// `@font-face` for `/files/*.woff2`): until that stylesheet is in, the faces
// don't exist and `document.fonts.load` resolves with nothing, so each family
// is polled for first, then its 400, 700 and italic faces are loaded against
// the page's text (a family split by `unicode-range`, as Google Fonts serves
// them, only fetches the subsets that text needs). The page's images are
// decoded too. Everything is capped, so an offline export still finishes,
// with the fallback fonts.

export const WAIT_CAP_MS = 5000;
const POLL_MS = 50;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const unquote = (s) => String(s).replace(/^["']|["']$/g, "");
const PLAIN = /^[\w -]+$/;

function hasFamily(fonts, family) {
  const want = family.toLowerCase();
  for (const face of fonts) if (unquote(face.family).toLowerCase() === want) return true;
  return false;
}

async function loadFamily(fonts, family, text, stopped, pollMs) {
  while (!hasFamily(fonts, family)) {
    await delay(pollMs);
    if (stopped()) return;
  }
  await Promise.all(
    [`400 1em "${family}"`, `700 1em "${family}"`, `italic 400 1em "${family}"`].map((d) => fonts.load(d, text).catch(() => {}))
  );
}

/** Resolves "ready" once `families` are loaded and `images` decoded (a
 * failure counts as done), or "timeout" at `capMs`. `fonts` is a
 * FontFaceSet (`document.fonts`); without one, only images are waited on.
 * `text` is what the faces are loaded for (the page's text); empty, it's a
 * space, since `load` fetches nothing for no characters. */
export async function waitForAssets({ fonts, families = [], images = [], text = "", capMs = WAIT_CAP_MS, pollMs = POLL_MS }) {
  let timedOut = false;
  const stopped = () => timedOut;
  const sample = text || " ";
  const names = fonts ? [...new Set(families)].filter((f) => typeof f === "string" && PLAIN.test(f)) : [];
  const work = Promise.all([
    ...names.map((f) => loadFamily(fonts, f, sample, stopped, pollMs)),
    ...Array.from(images, (img) => Promise.resolve().then(() => img.decode()).catch(() => {})),
  ]).then(async () => {
    if (fonts) await fonts.ready;
    return "ready";
  });
  let timer;
  const cap = new Promise((r) => (timer = setTimeout(() => r("timeout"), capMs)));
  try {
    return await Promise.race([work, cap]);
  } finally {
    timedOut = true;
    clearTimeout(timer);
  }
}
