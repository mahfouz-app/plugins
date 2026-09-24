// Run with `npm test` (node --test) from the repo root.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activate, pdfFileName } from "./index.js";

test("adds a PDF format that renders through Slidev with the note's orientation", async () => {
  const formats = [];
  const exports = [];
  const host = {
    use: async (id) => {
      assert.equal(id, "mahfouz/slidev");
      return { exportPdf: async (...args) => (exports.push(args), "/tmp/r.pdf") };
    },
    registerExportFormat: (f) => formats.push(f),
  };
  await activate(host);
  assert.deepEqual(formats.map((f) => [f.id, f.label]), [["pdf", "PDF"]]);
  const note = { vaultId: "v", noteId: "n", path: "a.md", title: "Q3: plan/draft", attributes: { orientation: "portrait" } };
  const progress = () => {};
  const result = await formats[0].export({ note, content: "# x" }, progress);
  assert.deepEqual(exports, [[note, { orientation: "portrait", content: "# x" }, progress]]);
  assert.deepEqual(result, { path: "/tmp/r.pdf", suggestedName: "Q3- plan-draft.pdf", filter: { name: "PDF", extensions: ["pdf"] } });

  await formats[0].export({ note: { ...note, attributes: {} } }, progress);
  assert.equal(exports[1][1].orientation, "landscape");
});

test("file names", () => {
  assert.equal(pdfFileName(""), "Untitled.pdf");
  assert.equal(pdfFileName('a<b>|c?"d'), "a-b--c--d.pdf");
});
