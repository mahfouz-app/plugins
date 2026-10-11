// What slide-top.vue stamps on each slide's page element (`.slidev-page`, the
// wrapper Slidev renders around a slide, in Present and in print alike):
// `data-layout`, the layout the slide renders with, and `data-class`, its
// `class:` tokens. A v2 template's stylesheet scopes rules on them
// (`.slidev-page:where([data-layout="quote"])`, `[data-class~="wide"]`).
// The layout's own class names can't serve: two-cols renders `two-columns`
// and image has none.

/** The layout Slidev renders slide `page` (1-based) with, by the server's
 * rule (sidecar.js, "Facts this relies on"). A name that isn't a layout is
 * kept as written, where the server renders `default`: the client has no
 * list of layouts to check it against (`#slidev/layouts` doesn't compile). */
export function slideLayout(frontmatter, defaults, page) {
  const name = frontmatter?.layout ?? defaults?.layout;
  const layout = name || (page === 1 ? "cover" : "default");
  if (typeof layout !== "string") return "default";
  return layout;
}

/** A slide's `class:` (a string or a list) as space-separated tokens, keeping
 * only plain names an attribute selector can match. */
export function slideClass(value) {
  const parts = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  return parts
    .flatMap((p) => p.split(/\s+/))
    .filter((t) => /^[\w-]+$/.test(t))
    .join(" ");
}

/** Sets the stamps on `page` (a no-op without one). Vue binds only
 * `data-slidev-no`, `class`, `style` and `lang` on that element, so these
 * survive its re-renders. */
export function stampPage(page, { layout, cls }) {
  if (!page) return;
  page.dataset.layout = layout;
  if (cls) page.dataset.class = cls;
  else delete page.dataset.class;
}
