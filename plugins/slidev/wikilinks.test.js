// Run with `npm test` (node --test) from the repo root. The wikilink rewrite
// the Present transformer runs on every slide (setup/transformers.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { literalLabel, rewriteWikilinks, scanWikilinks, wikilinkKey } from "./wikilinks.js";

// Raw text → the keys the app's replaceWikilinks reads from it
// (src/core/src/markdown/wikilinkScan.ts in mahfouz-app/app), which is what
// host.slides.deck keys its links by. Checked against the app's scanner.
const KEYS = JSON.parse(fs.readFileSync(new URL("./wikilink-keys.fixture.json", import.meta.url), "utf8"));

test("the scan reads the same keys as the app's", () => {
  for (const { text, keys } of KEYS) {
    const seen = [];
    scanWikilinks(text, (_s, _e, target, alias) => seen.push(wikilinkKey(target, alias)));
    assert.deepEqual(seen, keys, JSON.stringify(text));
  }
});

test("the scan stays linear on a long run of [[ with no close", () => {
  const s = "[[".repeat(200_000);
  const t = Date.now();
  scanWikilinks(s, () => assert.fail("no link"));
  assert.ok(Date.now() - t < 1000);
});

const DECK = {
  parts: ["talk/talk.md", "talk/child.md"],
  links: {
    child: { path: "talk/child.md", title: "The Child" },
    "child|see this": { path: "talk/child.md", title: "The Child" },
    "child\\|in a table": { path: "talk/child.md", title: "The Child" },
    "child#Part two": { path: "talk/child.md", title: "The Child" },
    outside: { path: "other.md", title: "Elsewhere" },
    secret: { path: "s.md", title: null },
    missing: null,
    ["__proto__"]: { path: "talk/talk.md", title: "Proto" },
    "x|{{ boom }}": { path: "other.md", title: "X" },
    "x|<img src=x onerror=alert(1)>": { path: "other.md", title: "X" },
    "a|costs $5 `x`": { path: "other.md", title: "A" },
  },
};
const span = (s) => `<span v-pre>${literalLabel(s)}</span>`;
const jump = (k, s) => `<MahfouzLink :part="${k}">${span(s)}</MahfouzLink>`;

test("a link to a part jumps there; any other is its alias, the title, or the target", () => {
  assert.equal(rewriteWikilinks("Go to [[child]].", DECK), `Go to ${jump(1, "The Child")}.`);
  assert.equal(rewriteWikilinks("[[child|see this]]", DECK), jump(1, "see this"));
  assert.equal(rewriteWikilinks("[[child#Part two]]", DECK), jump(1, "The Child"));
  assert.equal(rewriteWikilinks("[[__proto__]]", DECK), jump(0, "Proto"));
  assert.equal(rewriteWikilinks("[[outside]]", DECK), span("Elsewhere"));
  assert.equal(rewriteWikilinks("[[secret]]", DECK), span("secret"));
  assert.equal(rewriteWikilinks("[[missing]] [[unknown|Shown]]", DECK), `${span("missing")} ${span("Shown")}`);
  assert.equal(rewriteWikilinks("[[constructor]] [[toString]]", DECK), `${span("constructor")} ${span("toString")}`);
});

test("in a table, the escaped pipe's alias is the label and no pipe is left", () => {
  const out = rewriteWikilinks("| a | [[child\\|in a table]] |\n|---|---|", DECK);
  assert.equal(out, `| a | ${jump(1, "in a table")} |\n|---|---|`);
});

test("labels can't be markup: Markdown, HTML and Vue all show them as text", () => {
  assert.equal(literalLabel("{{ boom }}"), "&#123;&#123; boom &#125;&#125;");
  assert.equal(literalLabel("<b>*x*</b> & `y` | z"), "&#60;b&#62;&#42;x&#42;&#60;&#47;b&#62; &#38; &#96;y&#96; &#124; z");
  assert.equal(literalLabel("two\n  lines"), "two lines");
  const out = rewriteWikilinks("[[x|{{ boom }}]] [[x|<img src=x onerror=alert(1)>]]", DECK);
  assert.doesNotMatch(out, /\{\{|<img|onerror=/);
  assert.match(out, /^<span v-pre>&#123;&#123; boom &#125;&#125;<\/span> <span v-pre>/);
});

test("only part indexes reach the markup, never a path", () => {
  const deck = { parts: ['a".md', "b<script>.md"], links: { a: { path: 'a".md', title: "A" }, b: { path: "b<script>.md", title: "B" } } };
  assert.equal(rewriteWikilinks("[[a]] [[b]]", deck), `${jump(0, "A")} ${jump(1, "B")}`);
});

test("with no deck (an export or a preview), every link is its label", () => {
  assert.equal(rewriteWikilinks("[[child]] [[child|alias]]"), `${span("child")} ${span("alias")}`);
  assert.equal(rewriteWikilinks("[[child]]", { parts: "x", links: [] }), span("child"));
});

test("code, math and raw HTML are left as written", () => {
  const untouched = [
    "```\n[[child]]\n```",
    "````md\n```\n[[child]]\n```\n````",
    "~~~\n[[child]]\n~~~",
    "```js\n[[child]]",
    "    [[child]] indented code",
    "`[[child]]`",
    "``a ` [[child]] ``",
    "$[[child]]$",
    "$$[[child]]$$",
    "$$\n[[child]]\n$$",
    "<script>\nlet a = '[[child]]'\n</script>",
    "<style>/* [[child]] */</style>",
    "<div>\n[[child]]\n</div>",
    "<!--\n[[child]]\n-->",
    '<a href="[[child]]">x</a>',
  ];
  for (const md of untouched) assert.equal(rewriteWikilinks(md, DECK), md, JSON.stringify(md));
});

test("prose around code is still rewritten", () => {
  const L = jump(1, "The Child");
  assert.equal(rewriteWikilinks("```\n[[child]]\n```\n[[child]]", DECK), `\`\`\`\n[[child]]\n\`\`\`\n${L}`);
  assert.equal(rewriteWikilinks("`code` [[child]] `more`", DECK), `\`code\` ${L} \`more\``);
  assert.equal(rewriteWikilinks("Costs $5 and [[child]] $10", DECK), `Costs $5 and ${L} $10`);
  assert.equal(rewriteWikilinks("<div>\n\n[[child]]\n\n</div>", DECK), `<div>\n\n${L}\n\n</div>`);
  assert.equal(rewriteWikilinks("text\n    [[child]] lazy continuation", DECK), `text\n    ${L} lazy continuation`);
  assert.equal(rewriteWikilinks("- item\n\n    - nested [[child]]", DECK), `- item\n\n    - nested ${L}`);
  assert.equal(rewriteWikilinks("# [[child]]\n    code [[child]]", DECK), `# ${L}\n    code [[child]]`);
  assert.equal(rewriteWikilinks("an unclosed ` and [[child]]", DECK), `an unclosed \` and ${L}`);
  // A link that starts first isn't opened into by what's inside it.
  assert.equal(rewriteWikilinks("[[a|costs $5 `x`]] $y$", DECK), `${span("costs $5 `x`")} $y$`);
});
