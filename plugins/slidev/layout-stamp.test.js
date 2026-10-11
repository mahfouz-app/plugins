// Run with `npm test` (node --test) from the repo root. What slide-top.vue
// stamps on each slide's page element: `data-layout` (the layout Slidev
// renders the slide with) and `data-class` (the slide's `class:` tokens), so
// a template's stylesheet can scope rules with
// `.slidev-page:where([data-layout="quote"])` and `[data-class~="wide"]`.
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("without the layout list, the name is kept as Slidev's fallback picks it", () => {
  assert.equal(slideLayout({ layout: "anything" }, undefined, 2, null), "anything");
  assert.equal(slideLayout({}, undefined, 1, null), "cover");
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

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");

test("slide-top.vue stamps its page on mount and after each change, once the DOM is patched", () => {
  const src = read("./slide-top.vue");
  assert.match(src, /from '\.\/layout-stamp\.js'/);
  assert.match(src, /closest\('\.slidev-page'\)/);
  assert.match(src, /onMounted\(stamp\)/);
  assert.match(src, /watch\([^)]*,\s*stamp,\s*\{\s*flush:\s*'post'\s*\}\)/);
  assert.doesNotMatch(src, /immediate:\s*true/);
});

test("global-top.vue holds the export with a loading marker until the template's assets are in", () => {
  const src = read("./global-top.vue");
  assert.match(src, /from '\.\/asset-wait\.js'/);
  assert.match(src, /class="slidev-slide-loading/);
});
