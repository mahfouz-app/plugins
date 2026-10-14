// Run with `npm test` (node --test) from the repo root. What slide-top.vue
// stamps on each slide's page element: `data-layout` (the layout Slidev
// renders the slide with) and `data-class` (the slide's `class:` tokens), so
// a template's stylesheet can scope rules with
// `.slidev-page:where([data-layout="quote"])` and `[data-class~="wide"]`.
// The component itself is mounted in layers.test.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deckDefaults, slideClass, slideLayout, stampPage } from "./layout-stamp.js";

test("the slide's own layout wins, then defaults.layout, then cover for slide 1 and default after", () => {
  assert.equal(slideLayout({ layout: "quote" }, { layout: "center" }, 3), "quote");
  assert.equal(slideLayout({}, { layout: "center" }, 1), "center");
  assert.equal(slideLayout({}, { layout: "center" }, 4), "center");
  assert.equal(slideLayout({}, undefined, 1), "cover");
  assert.equal(slideLayout({}, undefined, 2), "default");
  assert.equal(slideLayout(undefined, null, 2), "default");
});

test("an empty layout falls through like the server's `||`", () => {
  // serve: (frontmatter.layout ?? defaults.layout) || (index === 0 ? "cover" : "default")
  assert.equal(slideLayout({ layout: "" }, { layout: "center" }, 1), "cover");
  assert.equal(slideLayout({ layout: null }, { layout: "center" }, 2), "center");
});

test("a name that isn't a layout is stamped as written (Slidev renders it with default); a non-string is default", () => {
  // The client can't list the layouts: `#slidev/layouts` doesn't compile
  // when a layout's name has a hyphen (slidev-contract.test.js).
  assert.equal(slideLayout({ layout: "nope" }, undefined, 2), "nope");
  assert.equal(slideLayout({}, { layout: "two-cols" }, 1), "two-cols");
  assert.equal(slideLayout({ layout: 3 }, undefined, 2), "default");
  assert.equal(slideLayout({ layout: ["quote"] }, undefined, 2), "default");
});

test("defaults come from slide 1's frontmatter in the deck's slide list", () => {
  const nav = (frontmatter) => ({ slides: [{ meta: { slide: { frontmatter } } }, { meta: { slide: { frontmatter: {} } } }] });
  assert.deepEqual(deckDefaults(nav({ defaults: { layout: "center" } })), { layout: "center" });
  assert.equal(slideLayout({}, deckDefaults(nav({ defaults: { layout: "center" } })), 2), "center");
  assert.equal(slideLayout({}, deckDefaults(nav({ defaults: { layout: "center" } })), 1), "center");
  assert.equal(slideLayout({ layout: "quote" }, deckDefaults(nav({ defaults: { layout: "center" } })), 2), "quote");
  // A later slide's defaults don't count, as on the server.
  const later = { slides: [{ meta: { slide: { frontmatter: {} } } }, { meta: { slide: { frontmatter: { defaults: { layout: "center" } } } } }] };
  assert.equal(slideLayout({}, deckDefaults(later), 2), "default");
  // defaults that aren't a mapping, or no slides yet, give no layout.
  assert.equal(slideLayout({}, deckDefaults(nav({ defaults: "center" })), 2), "default");
  assert.equal(slideLayout({}, deckDefaults(nav({ defaults: { layout: 3 } })), 2), "default");
  assert.equal(deckDefaults({ slides: [] }), undefined);
  assert.equal(deckDefaults(undefined), undefined);
});

test("class tokens come from a string or an array, keeping only plain names", () => {
  assert.equal(slideClass("wide  text-center\tdark"), "wide text-center dark");
  assert.equal(slideClass(["wide", "a b", 3, null, 'x"]']), "wide a b");
  assert.equal(slideClass('wide x"] y'), "wide y");
  assert.equal(slideClass(undefined), "");
  assert.equal(slideClass({ wide: true }), "");
});

test("stamping sets data-layout and data-class, and clears data-class when there's none", () => {
  const page = { dataset: {} };
  stampPage(page, { layout: "quote", cls: "wide" });
  assert.deepEqual({ ...page.dataset }, { layout: "quote", class: "wide" });
  stampPage(page, { layout: "default", cls: "" });
  assert.deepEqual({ ...page.dataset }, { layout: "default" });
  assert.doesNotThrow(() => stampPage(null, { layout: "cover", cls: "" }));
});
