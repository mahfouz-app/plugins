// Vendored from mahfouz-app/app src/core/src/plugins/{bodyCodec,commands,dialogs,exportFormats,fencedBlocks,hostRepo,hostVault,notes,overlay,settingsTabs,vaultUnlockers}.ts,
// src/core/src/db/slidesTemplates.ts, src/core/src/plugins/slidesPreview.ts and src/core/src/import/types.ts — keep in sync.
import type { NoteRef } from "./tabs";

export interface CommandNote {
  vaultId: string;
  noteId: string;
  path: string;
  title: string;
  /** The group an encrypted note is encrypted for (its `encrypted:` value); absent for any other note. */
  encryptedGroup?: string;
  /** An encrypted note this session holds the plaintext of (crypto/unlocked.ts); absent for any other note. */
  unlocked?: boolean;
}

/** The open vault, as a vault command receives it. */
export interface CommandVault {
  vaultId: string;
  name: string;
  /** Where the vault lives: an absolute directory on desktop, `handle:<id>` or `opfs:<uuid>` on the web. */
  path: string;
  /** git-crypt keeps it locked on this device: its notes can't be read, so none are shown. */
  locked: boolean;
}

interface CommandBase {
  id: string;
  label: string;
  /** Default binding, e.g. `Mod+Shift+P`. */
  shortcut?: string;
  /** `false` leaves it out of the command palette (its shortcut, and a note command's note menu, still run it). */
  palette?: false;
}

/** A command on one note (the default scope). */
export interface NoteCommand extends CommandBase {
  scope?: "note";
  /** Inline SVG markup for the menu icon (24×24 viewBox, stroke-based). */
  icon?: string;
  /** Show it in note context menus. */
  noteMenu?: boolean;
  /**
   * Whether the command applies to `note`: false hides it from the note
   * menu and the palette, and its shortcut does nothing for that note.
   * Called on every render of those, so keep it cheap and synchronous; one
   * that throws counts as false.
   */
  when?(note: CommandNote): boolean;
  run(note: CommandNote): void | Promise<void>;
}

/** A command on the open vault: in the palette and on its shortcut whenever a vault is open, note or not. */
export interface VaultCommand extends CommandBase {
  scope: "vault";
  /**
   * Whether the command applies to `vault`: false leaves it out of the
   * palette, and its shortcut does nothing. Called on every render of the
   * palette, so keep it cheap and synchronous; one that throws counts as
   * false.
   */
  when?(vault: CommandVault): boolean;
  run(vault: CommandVault): void | Promise<void>;
}

export type PluginCommand = NoteCommand | VaultCommand;

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
  /** The template being edited, resolved as `resolveTemplate` resolves
   * one, with the sample deck's header and footer applied. */
  template: ResolvedSlidesTemplate;
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

/** What a body codec is told about the note it decodes or encodes (the app's `src/core/src/plugins/bodyCodec.ts`). */
export interface BodyCodecContext {
  vaultId: string;
  noteId: string;
  /** Vault-relative path of the note's file. */
  path: string;
  /** The group the note is encrypted for (its `encrypted:` value). */
  group: string;
  /** The armored body: the one to decode, or (encode) the one being replaced, "" for a new note. */
  armored: string;
  /**
   * In `decode` for a user's Unlock (or the changed-on-disk banner): the
   * plaintext of this note, which the desktop reads from its file and has
   * the `mahfouz/encryption` plugin's sidecar decrypt (`decrypt`, given only
   * the armored body and the fingerprints `.config/encryption.md` lists for
   * the group, the only signers it accepts). A codec should call it rather than decrypt
   * `armored` itself: no API decrypts ciphertext a caller hands in. Rejects
   * when the file no longer holds `armored`. Absent in a merge's decode (a
   * base or theirs from history, not the file: `decryptBlob` is that) and
   * in apps older than it.
   *
   * Installed plugins share one JavaScript realm and are one trust domain:
   * any enabled plugin could ask for a decrypt. The gate is gpg-agent:
   * configure it to ask for the passphrase or a YubiKey touch on every
   * decrypt (no cache) if other plugins are installed.
   */
  decryptNote?(): Promise<string>;
  /**
   * In a merge's decode: the commit this version of the note comes from (a
   * merge's base, ours or theirs).
   */
  sha?: string;
  /**
   * In `decode` for a merge the user started (Sync now, of a note unlocked
   * this session): the plaintext of this version, which the desktop reads
   * from git itself (commit `sha`, which must be `ctx.sha`, at `ctx.path`)
   * and decrypts like `decryptNote`, with the same checks. Rejects when that
   * version's armored body isn't `armored`. Absent in an Unlock's decode, in
   * background merges (which never decrypt: the conflict notice's Keep both
   * settles them) and in apps older than it.
   */
  decryptBlob?(sha: string): Promise<string>;
}

export interface BodyCodec {
  /** Unique within the plugin. */
  id: string;
  /** Whether this codec handles a note with this frontmatter (`encrypted` included). */
  matches(frontmatter: Readonly<Record<string, string>>): boolean;
  /** The plaintext of `ctx.armored`. Called only from a user action. */
  decode(ctx: BodyCodecContext): Promise<string>;
  /** `plaintext` as one ASCII-armored OpenPGP message for `ctx.group`. */
  encode(ctx: BodyCodecContext, plaintext: string): Promise<string>;
}

/** The open vault, as a plugin sees it (the app's `src/core/src/plugins/hostVault.ts`). */
export interface VaultInfo {
  vaultId: string;
  /** Absolute path of the vault's root directory. */
  path: string;
}

/** What `host.vault.commitFiles` resolves with: whether it committed, and the disk-only notes' paths it left out (the app's `src/core/src/db/vaultGitOps.ts`). */
export interface CommitFilesResult {
  committed: boolean;
  skipped: string[];
}

/** What `host.notes.setEncryption` takes. */
export type EncryptionSwitch = { group: string; armored: string; expected: string } | { plaintext: string; expected: string };

/** What `host.repo.createPrivate` resolves with. */
export interface CreatedRepo {
  /** `owner/name`. */
  fullName: string;
  /** The SSH URL to set as the vault's remote. */
  cloneUrl: string;
  htmlUrl: string;
}

/** A page in Settings a plugin adds (the app's `src/core/src/plugins/settingsTabs.ts`). */
export interface SettingsTab {
  /** Unique within the plugin. */
  id: string;
  /** The tab's name in Settings' list. */
  label: string;
  /** Renders the page into `container`; the returned function runs when the page closes. */
  render(container: HTMLElement): void | (() => void);
}

/** A dialog a plugin opens with `host.ui.openDialog` (the app's `src/core/src/plugins/dialogs.ts`). */
export interface DialogSpec {
  /** The dialog's title, and its accessible name. */
  title: string;
  /** Renders the dialog's content into `container`; the returned function runs when it closes. */
  render(container: HTMLElement): void | (() => void);
}

/** `host.ui.confirm`'s question (the app's `src/core/src/plugins/dialogs.ts`). */
export interface PluginConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

/** A button on the locked-vault notice (the app's `src/core/src/plugins/vaultUnlockers.ts`). */
export interface VaultUnlocker {
  /** The button's label, e.g. "Unlock". */
  label: string;
  /** Unlocks the open vault; rejects with what went wrong. */
  unlock(): Promise<unknown>;
}

/** What `host.repo.moveToNewPrivate` resolves with (the app's `src/core/src/plugins/hostRepo.ts`). */
export interface MovedRepo {
  /** `owner/name`. */
  fullName: string;
  htmlUrl: string;
}
