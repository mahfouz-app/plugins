// Run with `npm test` (node --test) from the repo root. What slide-top.vue
// stamps on each slide's page element: `data-layout` (the layout Slidev
// renders the slide with) and `data-class` (the slide's `class:` tokens), so
// a template's stylesheet can scope rules with
// `.slidev-page:where([data-layout="quote"])` and `[data-class~="wide"]`.
// The component itself is mounted in layers.test.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { slideClass, slideLayout, stampPage } from "./layout-stamp.js";

const KNOWN = ["cover", "default", "quote", "two-cols", "center"];

test("the slide's own layout wins, then defaults.layout, then cover for slide 1 and default after", () => {
  assert.equal(slideLayout({ layout: "quote" }, { layout: "center" }, 3, KNOWN), "quote");
  assert.equal(slideLayout({}, { layout: "center" }, 1, KNOWN), "center");
  assert.equal(slideLayout({}, { layout: "center" }, 4, KNOWN), "center");
  assert.equal(slideLayout({}, undefined, 1, KNOWN), "cover");
  assert.equal(slideLayout({}, undefined, 2, KNOWN), "default");
  assert.equal(slideLayout(undefined, null, 2, KNOWN), "default");
});

test("an empty layout falls through like the server's `||`", () => {
  // serve: (frontmatter.layout ?? defaults.layout) || (index === 0 ? "cover" : "default")
  assert.equal(slideLayout({ layout: "" }, { layout: "center" }, 1, KNOWN), "cover");
  assert.equal(slideLayout({ layout: null }, { layout: "center" }, 2, KNOWN), "center");
});

test("an unknown layout is stamped as default, as the server renders it", () => {
  assert.equal(slideLayout({ layout: "nope" }, undefined, 2, KNOWN), "default");
  assert.equal(slideLayout({}, { layout: "nope" }, 1, KNOWN), "default");
  assert.equal(slideLayout({ layout: "toString" }, undefined, 2, KNOWN), "default");
  assert.equal(slideLayout({ layout: 3 }, undefined, 2, KNOWN), "default");
});

test("the layout list is required", () => {
  assert.throws(() => slideLayout({ layout: "quote" }, undefined, 2, null), TypeError);
  assert.throws(() => slideLayout({ layout: "quote" }, undefined, 2), TypeError);
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
