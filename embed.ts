// Vendored from mahfouz-app/app src/app/src/editor/embeds/registry.ts — keep in sync.
import type { EditorView } from "@codemirror/view";

/** Where a rendered block sits. */
export interface EmbedContext {
  /** 0-based position among this note's fenced blocks of the same language. */
  ordinal: number;
  /** The note being shown. Read it when the user acts (e.g. on click), not
   * while rendering: it's kept current by the app, not captured per render. */
  readonly note: { vaultId: string; noteId: string } | null;
}

export interface EmbedRenderer {
  render(
    container: HTMLElement,
    source: string,
    theme: "light" | "dark",
    context?: EmbedContext
  ): Promise<void> | void;
  dispose?(container: HTMLElement): void;
  // Shown in the toolbar's Embed picker. Falls back to the language tag
  // itself when omitted.
  label?: string;
  // Starter content seeded into the fenced block when inserted from the
  // toolbar. Falls back to an empty block when omitted.
  snippet?: string;
  // Called by the toolbar's Embed picker right after inserting this
  // language's starter snippet, with the position of the fence's opening
  // ```<language> line. Most embeds (e.g. mermaid) render in place and need
  // nothing further, but one that needs an external editor to be useful
  // (e.g. drawio) can use this to jump straight there instead of leaving
  // the user to discover the click-to-edit affordance on a block they have
  // no reason to hand-edit. `note` is the note it was inserted into.
  onInsertedAt?(view: EditorView, from: number, note: { vaultId: string; noteId: string } | null): void;
}
