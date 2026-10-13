// Vendored from mahfouz-app/app src/core/src/plugins/{commands,exportFormats,fencedBlocks,notes,overlay}.ts,
// src/core/src/db/slidesTemplates.ts, src/core/src/plugins/slidesPreview.ts and src/core/src/import/types.ts — keep in sync.
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

export interface FencedBlock {
  /** Start of the block's first content line, including its prefix. */
  from: number;
  /** End of the content, before the line break that precedes the closing
   * fence. An empty block (`from === to`) sits at the start of the line the
   * closing fence is on, or at the end of an unclosed fence. */
  to: number;
  /** What a container puts in front of every line of the block: the list
   * indent, a blockquote's `> `, or both. Empty for a top-level fence. */
  prefix: string;
  /** The content with `prefix` stripped and CRLF turned into LF. */
  source: string;
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
  /** The template's raw base css (also inside `stylesheet`). */
  css: string;
  /** The whole look as one CSS string, built from the fields, the applied
   * sections and the css (`slidesStylesheet`). Fonts come from it too
   * (`@import` / `@font-face`), not from Slidev's `fonts:`. Optional here:
   * an app that predates it doesn't send it, and the plugin then builds its
   * own CSS from the v1 keys above. */
  stylesheet?: string;
  /** Slidev's `colorSchema`, from the base background's luminance; unset
   * (Slidev's `auto`) when that's unset or a named colour. */
  colorSchema?: "light" | "dark";
  /** The font families `stylesheet` loads, to wait for before export. */
  fontFamilies?: string[];
}

// ---- slides preview (src/core/src/plugins/slidesPreview.ts)

/** What Settings → Slides' "Render with Slidev" asks a preview renderer
 * for: the app's sample deck rendered with a template. */
export interface SlidesPreviewRequest {
  /** The active vault's absolute path, for the template's `/files/` images. */
  vaultPath: string;
  /** The sample deck: Slidev Markdown, at most 64 KB. */
  markdown: string;
  /** The template to render it with, as `resolveTemplate` returns one. */
  template: ResolvedSlidesTemplate | null;
}

/** The rendered slides, in order: at most 30, each a
 * `data:image/png;base64,…` URL of at most 4 MB. The app checks both. */
export interface SlidesPreviewResult {
  slides: { png: string }[];
}

// ---- import (src/core/src/import/types.ts)
//
// What an importer hands core: an `ImportPlan`, plain data describing the
// pages to create. Importers (registry plugins such as `mahfouz/notion`)
// only read their source and build a plan; every vault write is core's
// (`writeImportPlan`, write.ts), so a plugin never gets a note-create or
// file-write API.
//
// References between pages, to attachments and to people are ordinary
// Markdown links with the `mahfouz-import:` scheme, which every Markdown
// parser keeps intact: `[text](mahfouz-import:page/<id>)`,
// `[text](mahfouz-import:file/<ref>)` (or `![alt](…)` for an embed) and
// `[text](mahfouz-import:person/<id>)`. Core rewrites them (refs.ts); ids
// match `^[A-Za-z0-9-]{1,64}$`.

/** The attribute types a database column can have (the app's `src/core/src/db/attributes.ts`). */
export type AttributeType =
  | "text"
  | "number"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "color"
  | "font"
  | "attachment"
  | "image"
  | "audio"
  | "video";

/** The `ImportPlan` shape this build reads. */
export const IMPORT_PLAN_VERSION = 1;

/**
 * One HTTP request an importer asks core to make. Rust makes it
 * (`plugin_http_request`), under the plugin's manifest allowlist: https
 * only, to the manifest's `network` hosts.
 */
export interface HttpRequestSpec {
  url: string;
  method?: "GET" | "POST" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  /** The name of a session secret (`Importer.credential.secretName`) Rust attaches as a bearer token; never the secret itself. */
  secret?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON, else the text. */
  body: unknown;
}

/** Someone the plan mentions, comments as or assigns tasks to. */
export interface ImportPerson {
  id: string;
  name: string;
  email?: string;
}

/**
 * A file the plan references by `ref`. `resolve` gives a fresh request for
 * its bytes right before the download (signed URLs expire). Its name and
 * type are hints only: core picks the file's name and how it's linked.
 */
export interface ImportAttachment {
  ref: string;
  filenameHint: string;
  resolve(): Promise<HttpRequestSpec>;
}

/** An attachment downloaded into a staging directory (import/download.ts), ready to copy into the vault. */
export interface StagedAttachment {
  ref: string;
  /** Absolute path of the staged file, as `vaultFs.copyInto` takes it. */
  path: string;
  size: number;
  /** Hex SHA-256 of the bytes, computed while staging: files with the same one are copied once. */
  sha256: string;
}

/** One comment of a thread. `text` is plain text that may hold `mahfouz-import:` references. */
export interface ImportCommentEntry {
  personId: string;
  /** ISO 8601 date or date-time. */
  date: string;
  text: string;
}

/**
 * A comment thread, structured (core renders it as CriticMarkup). `page`
 * anchors it to the page; `blockIndex` to the page body's top-level
 * Markdown block at that 0-based index, as the editor's grammar reads the
 * body.
 */
export interface ImportComment {
  anchor: "page" | { blockIndex: number };
  entries: ImportCommentEntry[];
}

/** A database column. `key` names it in the rows' `attributes`; core derives the attribute key from `label`. */
export interface ImportColumn {
  key: string;
  label: string;
  type: AttributeType;
  /** select and multiselect only. */
  options?: string[];
}

export interface ImportPage {
  /** The page's id in its source; page references name it. */
  sourceId: string;
  title: string;
  /** Markdown, with no title heading: core puts `# <title>` first. */
  body: string;
  /**
   * Attributes by key (a database row's by its columns' `key`). A
   * multiselect value is a list of its members; any other value a string.
   * Values may hold `mahfouz-import:` references.
   */
  attributes: Record<string, string | string[]>;
  /** Sub-pages; a database's rows. */
  children: ImportPage[];
  /** Set when the page is a database: its children are its rows. */
  database?: { columns: ImportColumn[] };
  comments?: ImportComment[];
}

export interface ImportPlan {
  version: typeof IMPORT_PLAN_VERSION;
  /** The roots, each landing directly in the destination. */
  pages: ImportPage[];
  attachments: ImportAttachment[];
  people: ImportPerson[];
  /** What the importer couldn't bring over, for the preview. */
  warnings: string[];
}

/** What an importer's `prepare` gets from core. */
export interface ImportContext {
  progress(detail: string, percent?: number): void;
  /** Aborted when the user cancels. */
  signal: AbortSignal;
  /** Requests through Rust under the importer's plugin's allowlist; a `secret` names the session secret Rust attaches. */
  http: { request(spec: HttpRequestSpec): Promise<HttpResponse> };
  /** The dialog's value for each of `Importer.options`, by id. */
  options: Record<string, boolean>;
}

/** A checkbox the Import dialog shows for an importer. */
export interface ImporterOption {
  id: string;
  label: string;
  /** A line under the label. */
  hint?: string;
  default: boolean;
}

export interface Importer {
  id: string;
  label: string;
  /**
   * A secret the user pastes into the Import dialog. Core hands it straight
   * to Rust, which keeps it in memory under `secretName` until the app
   * quits; plugin code never sees it. `helpUrl` (http or https) says where
   * to get one.
   */
  credential?: { label: string; helpUrl: string; secretName: string };
  options?: ImporterOption[];
  prepare(ctx: ImportContext): Promise<ImportPlan>;
}

/** Where an import lands: the vault root, inside a note (made a directory note first), or a plain folder. */
export type ImportDestination = { kind: "root" } | { kind: "note"; noteId: string } | { kind: "folder"; folderPath: string };

/** What a finished import created. */
export interface ImportResult {
  /** The created notes' ids, parent-first. */
  ids: string[];
  /** The ids of the plan's roots, in order. */
  rootIds: string[];
  /** Vault-relative paths of the copied attachments. */
  files: string[];
  /** The plan's warnings followed by the writer's own. */
  warnings: string[];
}
