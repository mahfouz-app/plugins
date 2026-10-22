// Slidev loads this from the project root (this plugin's directory) and runs
// each `pre` transformer on every slide's Markdown before parsing it; `ctx.s`
// is a MagicString of the slide's content (no frontmatter). The rewrite is in
// ../wikilinks.js, which the tests import; the deck map is in
// ../deck-links.js.
import { deckLinksFor } from "../deck-links.js";
import { wikilinkEdits } from "../wikilinks.js";

interface Ctx {
  s: { toString(): string; original: string; commit(): unknown; overwrite(start: number, end: number, text: string): unknown };
  slide?: { frontmatter?: Record<string, unknown> };
  options: { entry: string };
}

export default () => ({
  pre: [
    (ctx: Ctx) => {
      const deck = deckLinksFor(ctx.options.entry, ctx.slide?.frontmatter?.mahfouzLinksRev);
      if (ctx.s.toString() !== ctx.s.original) ctx.s.commit();
      for (const { start, end, text } of wikilinkEdits(ctx.s.original, deck)) ctx.s.overwrite(start, end, text);
    },
  ],
});
