// Header and footer on each slide, shared by the sidecar (which renders them
// into the entry's `mahfouz:` headmatter) and slide-top.vue (which draws
// them). The app resolves the text — template vs. the note's own, fields
// expanded — and leaves `{page}` and `{total}`, which need the slide.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function fillSlideTokens(html, page, total) {
  return html.replace(/\{page\}/gi, String(page)).replace(/\{total\}/gi, String(total));
}

/** What slide `page` shows for `side`, or null for nothing. */
export function layerHtml(config, side, page, total) {
  const html = config?.[side];
  if (typeof html !== "string" || html === "") return null;
  if (config.titleSlide && page === 1) return null;
  return fillSlideTokens(html, page, total);
}
