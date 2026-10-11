// Run with `npm test` (node --test) from the repo root. The layer
// components themselves, mounted: slide-top.vue and global-top.vue are
// compiled with @vue/compiler-sfc and rendered with Vue's own renderer over
// a few fake nodes, with `@slidev/client` and `#slidev/layouts` stubbed.
// What's checked is what Slidev's export and a template's stylesheet see:
// the `data-layout`/`data-class` stamps on the page element, and the
// `.slidev-slide-loading` marker. Vue and the compiler come from the
// plugin's npm install (through @slidev); skipped without it, and CI fails
// instead.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let sfc = null;
let vue = null;
let vueUrl = null;
try {
  sfc = require("@vue/compiler-sfc");
  vueUrl = pathToFileURL(require.resolve("vue/dist/vue.runtime.esm-bundler.js")).href;
  vue = await import(vueUrl);
} catch (err) {
  if (process.env.CI) throw err;
}
const withVue = { skip: sfc && vue ? false : "vue or @vue/compiler-sfc isn't installed (npm ci in plugins/slidev)" };

const LAYOUTS = ["cover", "default", "quote", "two-cols", "center"];
const dataModule = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
// Read live, so each test's stub applies to the one cached module.
const CLIENT = dataModule(
  "export const configs = new Proxy({}, { get: (_, key) => globalThis.__slidevStub.configs[key] });\n" +
    "export const useSlideContext = () => globalThis.__slidevStub.context;\n"
);
const LAYOUTS_MODULE = dataModule(`export default ${JSON.stringify(Object.fromEntries(LAYOUTS.map((l) => [l, {}])))};`);

/** The component in `file`, compiled the way Slidev's Vite plugin does
 * (`<script setup>` with the template inlined) and imported. */
async function load(file) {
  const url = new URL(file, import.meta.url);
  const { descriptor, errors } = sfc.parse(fs.readFileSync(url, "utf8"), { filename: url.pathname });
  assert.deepEqual(errors, []);
  const { content } = sfc.compileScript(descriptor, { id: file, inlineTemplate: true });
  const code = content.replace(/(\bfrom\s*)(['"])([^'"]+)\2/g, (_m, from, _q, spec) => {
    if (spec === "vue") return `${from}"${vueUrl}"`;
    if (spec === "@slidev/client") return `${from}"${CLIENT}"`;
    if (spec === "#slidev/layouts") return `${from}"${LAYOUTS_MODULE}"`;
    if (spec.startsWith("./")) return `${from}"${new URL(spec, url).href}"`;
    throw new Error(`unexpected import ${spec} in ${file}`);
  });
  return (await import(dataModule(code))).default;
}

/** Just enough of a DOM node for Vue's renderer and `closest`. */
class FakeNode {
  constructor(tag, text = "") {
    Object.assign(this, { tag, text, parent: null, children: [], attrs: {}, dataset: {} });
  }
  closest(selector) {
    const cls = selector.replace(/^\./, "");
    for (let n = this; n; n = n.parent) if (String(n.attrs.class ?? "").split(/\s+/).includes(cls)) return n;
    return null;
  }
  find(cls) {
    if (String(this.attrs.class ?? "").split(/\s+/).includes(cls)) return this;
    for (const c of this.children) {
      const hit = c.find?.(cls);
      if (hit) return hit;
    }
    return null;
  }
}

function fakeRenderer() {
  const detach = (n) => {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
    n.parent = null;
  };
  return vue.createRenderer({
    createElement: (tag) => new FakeNode(tag),
    createText: (text) => new FakeNode("#text", text),
    createComment: (text) => new FakeNode("#comment", text),
    setText: (n, text) => void (n.text = text),
    setElementText: (n, text) => void ((n.children = []), (n.text = text)),
    insert(child, parent, anchor) {
      detach(child);
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(at < 0 ? parent.children.length : at, 0, child);
      child.parent = parent;
    },
    remove: detach,
    parentNode: (n) => n.parent,
    nextSibling: (n) => (n.parent ? n.parent.children[n.parent.children.indexOf(n) + 1] ?? null : null),
    patchProp: (n, key, _prev, next) => void (next == null ? delete n.attrs[key] : (n.attrs[key] = next)),
  });
}

/** Mounts `Comp` inside a fake `.slidev-page`, as SlideWrapper renders it. */
function mountInPage(Comp) {
  const page = new FakeNode("div");
  page.attrs.class = "slidev-page slidev-page-1";
  const { createApp } = fakeRenderer();
  const app = createApp(Comp);
  app.config.warnHandler = (msg) => assert.fail(`Vue warned: ${msg}`);
  app.mount(page);
  return { page, unmount: () => app.unmount() };
}

function stub({ configs = {}, page = 1, frontmatter = {} } = {}) {
  const context = { $page: vue.ref(page), $nav: vue.ref({ total: 3 }), $frontmatter: vue.reactive(frontmatter) };
  globalThis.__slidevStub = { configs, context };
  return context;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("slide-top stamps its page's layout and class on mount, and again when the frontmatter changes", withVue, async () => {
  const SlideTop = await load("./slide-top.vue");
  const ctx = stub({ page: 2, frontmatter: { layout: "quote", class: "wide" } });
  const { page, unmount } = mountInPage(SlideTop);
  assert.deepEqual({ ...page.dataset }, { layout: "quote", class: "wide" });
  ctx.$frontmatter.layout = "two-cols";
  ctx.$frontmatter.class = ["dark", "a b"];
  await vue.nextTick();
  assert.deepEqual({ ...page.dataset }, { layout: "two-cols", class: "dark a b" });
  delete ctx.$frontmatter.class;
  ctx.$frontmatter.layout = "nope";
  await vue.nextTick();
  assert.deepEqual({ ...page.dataset }, { layout: "default" });
  unmount();
});

test("slide-top stamps slide 1 with no layout as cover, and follows defaults.layout", withVue, async () => {
  const SlideTop = await load("./slide-top.vue");
  stub({ page: 1 });
  const first = mountInPage(SlideTop);
  assert.equal(first.page.dataset.layout, "cover");
  first.unmount();
  stub({ page: 4, configs: { defaults: { layout: "center" } } });
  const later = mountInPage(SlideTop);
  assert.equal(later.page.dataset.layout, "center");
  later.unmount();
});

/** A FontFaceSet stub: a family's faces exist once `add` is called. */
function fakeFonts() {
  const faces = [];
  return {
    add: (family) => faces.push({ family }),
    [Symbol.iterator]: () => faces[Symbol.iterator](),
    load: async () => [],
    ready: Promise.resolve(),
  };
}

test("global-top holds the export with a loading marker until the template's fonts are in", withVue, async () => {
  const GlobalTop = await load("./global-top.vue");
  const fonts = fakeFonts();
  globalThis.document = { fonts, images: [], body: { innerText: "Hello" } };
  try {
    stub({ configs: { mahfouz: { css: ".slidev-page { color: red }", fontFamilies: ["Inter"] } } });
    const { page, unmount } = mountInPage(GlobalTop);
    assert.ok(page.find("slidev-slide-loading"), "the marker is in the DOM at mount");
    const style = page.children.find((c) => c.tag === "style");
    assert.equal(style && (style.text || style.children.map((c) => c.text).join("")), ".slidev-page { color: red }");
    await delay(120);
    assert.ok(page.find("slidev-slide-loading"), "still waiting while the family isn't declared");
    fonts.add("Inter");
    for (let i = 0; i < 40 && page.find("slidev-slide-loading"); i++) await delay(25);
    assert.equal(page.find("slidev-slide-loading"), null, "the marker is gone once the fonts load");
    unmount();
  } finally {
    delete globalThis.document;
  }
});

test("global-top renders no marker and no style without a template", withVue, async () => {
  const GlobalTop = await load("./global-top.vue");
  globalThis.document = { fonts: fakeFonts(), images: [], body: { innerText: "" } };
  try {
    stub({ configs: { mahfouz: null } });
    const { page, unmount } = mountInPage(GlobalTop);
    assert.equal(page.find("slidev-slide-loading"), null);
    assert.equal(page.children.some((c) => c.tag === "style"), false);
    unmount();
  } finally {
    delete globalThis.document;
  }
});
