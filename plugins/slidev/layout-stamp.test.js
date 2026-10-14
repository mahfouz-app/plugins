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

test("defaults come from the first slide's own frontmatter, which is where the server reads them", () => {
  // serve: data.slides[0]?.frontmatter?.defaults?.layout. With the note
  // imported by `src:`, that's the note's frontmatter (the stub's headmatter
  // spread over it), or the first shown slide's when slide 1 is hidden;
  // never the stub's own headmatter, which is what `configs` holds.
  const slide = (frontmatter) => ({ meta: { slide: { frontmatter } } });
  assert.deepEqual(deckDefaults([slide({ defaults: { layout: "center" } }), slide({ layout: "quote" })]), { layout: "center" });
  assert.equal(deckDefaults([slide({ layout: "cover" }), slide({ defaults: { layout: "center" } })]), undefined);
  assert.equal(deckDefaults([]), undefined);
  assert.equal(deckDefaults(undefined), undefined);
  assert.equal(deckDefaults([{ meta: {} }]), undefined);
  assert.equal(slideLayout({}, deckDefaults([slide({ defaults: { layout: "center" } })]), 1), "center");
});

test("a name that isn't a layout is stamped as written (Slidev renders it with default); a non-string is default", () => {
  // The client can't list the layouts: `#slidev/layouts` doesn't compile
  // when a layout's name has a hyphen (slidev-contract.test.js).
  assert.equal(slideLayout({ layout: "nope" }, undefined, 2), "nope");
  assert.equal(slideLayout({}, { layout: "two-cols" }, 1), "two-cols");
  assert.equal(slideLayout({ layout: 3 }, undefined, 2), "default");
  assert.equal(slideLayout({ layout: ["quote"] }, undefined, 2), "default");
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
