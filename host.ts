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

/** A note's slides template (`host.slides.resolveTemplate`), from the
 * vault's `.config/slides.md`. Unset fields are omitted; image paths are
 * root-absolute `/files/<name>`. */
export interface ResolvedSlidesTemplate {
  name: string;
  background?: string;
  backgroundImage?: string;
  textColor?: string;
  accentColor?: string;
  /** A Google Fonts family, e.g. `Inter`. */
  font?: string;
  logo?: string;
  logoPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** One line of inline Markdown drawn at the top of every slide. Fields
   * are expanded by `resolveSlidesTemplateForNote`; `{page}`/`{total}` are
   * left for the Slidev plugin. */
  header?: string;
  /** One line of inline Markdown drawn at the bottom of every slide. Fields
   * are expanded by `resolveSlidesTemplateForNote`; `{page}`/`{total}` are
   * left for the Slidev plugin. */
  footer?: string;
  /** Slide 1 is a title slide: the plugin draws no header or footer on it
   * (the note's `title_slide` attribute). */
  titleSlide?: boolean;
  /** Overrides for the first slide. */
  cover: {
    background?: string;
    backgroundImage?: string;
    textColor?: string;
    logo?: string;
  };
  css: string;
}
