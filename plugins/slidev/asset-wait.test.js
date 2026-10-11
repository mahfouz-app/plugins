// Run with `npm test` (node --test) from the repo root. The wait global-top.vue
// runs before it removes its `.slidev-slide-loading` marker, against a stub of
// the browser's `document.fonts` (a FontFaceSet: iterable FontFaces, `load`,
// `ready`) and of `document.images`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForAssets } from "./asset-wait.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A FontFaceSet stub: faces appear when `add` is called (as an `@import`ed
 * stylesheet's `@font-face` rules do once it arrives). */
function fakeFonts({ loadNever = false } = {}) {
  const faces = [];
  const loads = [];
  let readyAwaited = false;
  return {
    faces,
    loads,
    get readyAwaited() {
      return readyAwaited;
    },
    add: (family) => faces.push({ family }),
    [Symbol.iterator]: () => faces[Symbol.iterator](),
    texts: [],
    load(descriptor, text) {
      loads.push(descriptor);
      this.texts.push(text);
      return loadNever ? new Promise(() => {}) : Promise.resolve([]);
    },
    get ready() {
      readyAwaited = true;
      return Promise.resolve();
    },
  };
}

test("waits for each family's faces to be declared, then loads 400, 700 and italic", async () => {
  const fonts = fakeFonts();
  const done = waitForAssets({ fonts, families: ["Inter", "mahfouz-brand"], capMs: 1000, pollMs: 5 });
  await delay(30);
  assert.deepEqual(fonts.loads, [], "nothing loads before the faces exist");
  fonts.add("Inter");
  fonts.add('"mahfouz-brand"');
  assert.equal(await done, "ready");
  assert.deepEqual(fonts.loads.sort(), [
    '400 1em "Inter"',
    '400 1em "mahfouz-brand"',
    '700 1em "Inter"',
    '700 1em "mahfouz-brand"',
    'italic 400 1em "Inter"',
    'italic 400 1em "mahfouz-brand"',
  ]);
  assert.ok(fonts.readyAwaited);
});

test("decodes the page's images, and a failed decode doesn't hold it", async () => {
  const fonts = fakeFonts();
  const decoded = [];
  const images = [
    { decode: async () => void decoded.push("a") },
    { decode: async () => Promise.reject(new Error("broken image")) },
  ];
  assert.equal(await waitForAssets({ fonts, images, capMs: 1000, pollMs: 5 }), "ready");
  assert.deepEqual(decoded, ["a"]);
});

test("a family that never arrives (offline) resolves by the cap", async () => {
  const fonts = fakeFonts();
  const started = Date.now();
  assert.equal(await waitForAssets({ fonts, families: ["Inter"], capMs: 80, pollMs: 5 }), "timeout");
  const took = Date.now() - started;
  assert.ok(took >= 70 && took < 1000, `took ${took} ms`);
  assert.deepEqual(fonts.loads, []);
});

test("a load or decode that never settles resolves by the cap", async () => {
  const fonts = fakeFonts({ loadNever: true });
  fonts.add("Inter");
  const images = [{ decode: () => new Promise(() => {}) }];
  assert.equal(await waitForAssets({ fonts, families: ["Inter"], images, capMs: 60, pollMs: 5 }), "timeout");
});

test("loads each face against the page's text, so faces split by unicode-range load what the slide uses", async () => {
  const fonts = fakeFonts();
  fonts.add("Inter");
  assert.equal(await waitForAssets({ fonts, families: ["Inter"], text: "مرحبا Hello", capMs: 1000, pollMs: 5 }), "ready");
  assert.deepEqual(fonts.texts, ["مرحبا Hello", "مرحبا Hello", "مرحبا Hello"]);
  const bare = fakeFonts();
  bare.add("Inter");
  await waitForAssets({ fonts: bare, families: ["Inter"], capMs: 1000, pollMs: 5 });
  assert.deepEqual(bare.texts, [" ", " ", " "], "no text still names a character, as load() requires one to fetch");
});

test("a declared family matches its name ignoring case, as CSS font-family does", async () => {
  const fonts = fakeFonts();
  fonts.add('"INTER"');
  assert.equal(await waitForAssets({ fonts, families: ["Inter"], capMs: 1000, pollMs: 5 }), "ready");
  assert.equal(fonts.loads.length, 3);
});

test("polling stops at the cap", async () => {
  const fonts = fakeFonts();
  let polls = 0;
  fonts[Symbol.iterator] = () => (polls++, [][Symbol.iterator]());
  assert.equal(await waitForAssets({ fonts, families: ["Inter"], capMs: 40, pollMs: 5 }), "timeout");
  const after = polls;
  await delay(40);
  assert.equal(polls, after);
});

test("nothing to wait for is ready at once; names that aren't plain strings are skipped", async () => {
  const fonts = fakeFonts();
  assert.equal(await waitForAssets({ fonts, families: [], capMs: 1000 }), "ready");
  assert.equal(await waitForAssets({ fonts, families: [3, 'x" 1em "y', "a\\b", ""], capMs: 1000, pollMs: 5 }), "ready");
  assert.deepEqual(fonts.loads, []);
});

test("without a fonts API it still decodes images", async () => {
  const decoded = [];
  const images = [{ decode: async () => void decoded.push(1) }];
  assert.equal(await waitForAssets({ fonts: undefined, families: ["Inter"], images, capMs: 100, pollMs: 5 }), "ready");
  assert.deepEqual(decoded, [1]);
});
