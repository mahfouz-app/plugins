// Vendored from mahfouz-app/app src/app/src/plugins/{commands,exportFormats,notes,overlay}.ts — keep in sync.
import type { NoteRef } from "./tabs";

export interface CommandNote {
  vaultId: string;
  noteId: string;
  path: string;
  title: string;
}

export interface PluginCommand {
  id: string;
  label: string;
  /** Inline SVG markup for the menu icon (24×24 viewBox, stroke-based). */
  icon?: string;
  /** Show it in note context menus. */
  noteMenu?: boolean;
  /** Default binding, e.g. `Mod+Shift+P`. */
  shortcut?: string;
  run(note: CommandNote): void | Promise<void>;
}

export interface ExportRequest {
  note: { vaultId: string; noteId: string; path: string; title: string; attributes: Record<string, string> };
  /** The Markdown to render when the dialog's options changed it (children
   * appended, attachments stripped); undefined means "the note as saved". */
  content?: string;
}

export interface ExportResult {
  /** Absolute path of the rendered file, which the app moves or deletes. */
  path: string;
  suggestedName: string;
  /** File-type filter for the save dialog, e.g. `{ name: "PDF", extensions: ["pdf"] }`. */
  filter?: { name: string; extensions: string[] };
}

export interface ExportFormat {
  id: string;
  label: string;
  export(
    request: ExportRequest,
    progress: (detail: string, percent?: number) => void
  ): Promise<ExportResult>;
}

export interface NoteInfo extends NoteRef {
  title: string;
  /** Vault-relative path of the note's file. */
  path: string;
  /** Absolute path of the vault's root directory. */
  vaultPath: string;
  attributes: Record<string, string>;
  body: string;
}

export interface OverlaySpec {
  /** Shown to assistive tech and as the close button's context. */
  title: string;
  /** Renders into the overlay; the returned function runs when it closes. */
  render(container: HTMLElement, ctx: { close(): void }): void | (() => void);
}
