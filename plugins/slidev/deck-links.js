// The presented deck's parts and resolved wikilinks, as the sidecar writes
// them next to the Present stub (`deck-links.json`) and the wikilink
// transformer (setup/transformers.ts) reads them back. Only the Present
// stub's run reads the file: an export or a template preview has its own
// entry, and renders every wikilink as its label.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DECK_LINKS_FILE = "deck-links.json";
/** The Present stub's file name, in the workspace. */
export const PRESENT_ENTRY = "deck.md";

/** A short hash of a deck's parts and links: every importer slide in the
 * stub carries it, so a new map changes every slide's frontmatter and
 * Slidev transforms them all again. */
export function deckRev(parts, links) {
  return createHash("sha256")
    .update(JSON.stringify([parts, links]))
    .digest("hex")
    .slice(0, 12);
}

/** Writes `{ rev, parts, links }` to the workspace's links file through a
 * temporary file and a rename, so a reader never sees half of one. */
export function writeDeckLinks(workspace, deck) {
  const file = path.join(workspace, DECK_LINKS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(deck));
  fs.renameSync(tmp, file);
}

let cache = null;

/**
 * `{ parts, links }` for a slide of the run whose entry is `entry`: the links
 * file beside the Present stub, read again only when `rev` (the slide's
 * `mahfouzLinksRev`) isn't the one last read. Any other entry, a missing or
 * unreadable file, gets an empty map.
 */
export function deckLinksFor(entry, rev) {
  if (typeof entry !== "string" || path.basename(entry) !== PRESENT_ENTRY) return {};
  const file = path.join(path.dirname(entry), DECK_LINKS_FILE);
  if (cache && cache.file === file && rev !== undefined && cache.rev === rev) return cache.deck;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const deck = {
      parts: Array.isArray(data?.parts) ? data.parts : [],
      links: data?.links && typeof data.links === "object" && !Array.isArray(data.links) ? data.links : {},
    };
    cache = { file, rev: data?.rev, deck };
    return deck;
  } catch {
    cache = null;
    return {};
  }
}
