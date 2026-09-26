import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, fillSlideTokens, layerHtml } from "./header-footer.js";

test("fills page tokens", () => {
  assert.equal(fillSlideTokens("{page} of {total}", 3, 9), "3 of 9");
});

test("layerHtml: nothing configured → null", () => {
  assert.equal(layerHtml(undefined, "footer", 1, 2), null);
  assert.equal(layerHtml({ footer: "x" }, "header", 1, 2), null);
});

test("layerHtml: titleSlide hides slide 1 only", () => {
  const cfg = { header: "h {page}", titleSlide: true };
  assert.equal(layerHtml(cfg, "header", 1, 3), null);
  assert.equal(layerHtml(cfg, "header", 2, 3), "h 2");
});

test("escapeHtml escapes markup", () => {
  assert.equal(escapeHtml(`<b>"a" & 'b'</b>`), "&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
});
