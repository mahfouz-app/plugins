// The contract between Mahfouz and a registry plugin's frontend module.
//
// A plugin's `plugin.json` names an ES module (`"frontend": "index.js"`);
// the app imports it and calls its `activate(host)` export with the object
// described here, and `deactivate()` (optional) before unloading it. Every
// registration returns a `Disposable`, and anything still registered when the
// plugin is unloaded — disabled for this vault, vault switched, updated, or
// uninstalled — is disposed automatically.
//
// The plugins repo vendors a copy of this file. Changing an existing member
// is a breaking change and needs a new `apiVersion`; adding one is not.

// Vendored from mahfouz-app/app src/core/src/plugins/api.ts — keep in sync.
import type { EmbedContext, EmbedRenderer } from "./embed";
import type {
  BodyCodec,
  BodyCodecContext,
  CommandNote,
  CommitFilesResult,
  CreatedRepo,
  EncryptionSwitch,
  ExportFormat,
  ExportRequest,
  ExportResult,
  FencedBlock,
  HttpRequestSpec,
  HttpResponse,
  ImportAttachment,
  ImportColumn,
  ImportComment,
  ImportCommentEntry,
  ImportContext,
  Importer,
  ImporterOption,
  ImportPage,
  ImportPerson,
  ImportPlan,
  NoteInfo,
  OverlaySpec,
  PluginCommand,
  ResolvedSlidesTemplate,
  SlidesPreviewRequest,
  SlidesPreviewResult,
  VaultInfo,
} from "./host";
import type { NoteRef, PluginTabContext, PluginTabType, ToolbarButton } from "./tabs";
import type { ToolbarItem } from "./toolbar";

/** A qualified plugin id, `<registry>/<id>` (the app's `src/core/src/settings.ts`). */
type PluginId = `${string}/${string}`;

/** Draws a fence to an SVG for a published page, or null when it can't. `source` is the fence's text as the app's publish/fenceKey.ts normalizes it (the app's `src/core/src/plugins/publishRender.ts`). */
type PublishRenderer = (lang: string, source: string) => Promise<string | null>;

export type {
  BodyCodec,
  BodyCodecContext,
  CommandNote,
  CommitFilesResult,
  CreatedRepo,
  EncryptionSwitch,
  EmbedContext,
  EmbedRenderer,
  ExportFormat,
  ExportRequest,
  ExportResult,
  FencedBlock,
  HttpRequestSpec,
  HttpResponse,
  ImportAttachment,
  ImportColumn,
  ImportComment,
  ImportCommentEntry,
  ImportContext,
  Importer,
  ImporterOption,
  ImportPage,
  ImportPerson,
  ImportPlan,
  NoteInfo,
  NoteRef,
  OverlaySpec,
  PluginCommand,
  PluginId,
  PluginTabContext,
  PluginTabType,
  PublishRenderer,
  ResolvedSlidesTemplate,
  SlidesPreviewRequest,
  SlidesPreviewResult,
  ToolbarButton,
  VaultInfo,
};
export type { ToolbarItem, ToolbarDropdownOption } from "./toolbar";

export const API_VERSION = 1;

export interface Disposable {
  dispose(): void;
}

export interface PluginInfo {
  /** Qualified id, `<registry>/<id>`. */
  id: PluginId;
  registry: string;
  version: string;
  /** URL of the plugin's installed directory, ending in `/`; resolve assets against it. */
  baseUrl: string;
}

/** The token kinds a `CodeLanguage` rule can produce; the host colors each
 * with its own theme. */
export type CodeToken =
  | "keyword"
  | "type"
  | "string"
  | "comment"
  | "operator"
  | "number"
  | "variable"
  | "punctuation";

/** A declarative syntax for `createCodeEditor`. At each position the rules
 * are tried in order and the first that matches there (non-empty) wins; text
 * no rule matches is skipped a character at a time, unstyled. `regex` and
 * `flags` are `RegExp` source and flags; a rule that doesn't compile is
 * ignored. Rules see one line at a time. */
export interface CodeLanguage {
  /** What Toggle Comment puts before a line, e.g. `%%`. */
  lineComment?: string;
  rules: { regex: string; flags?: string; token: CodeToken }[];
}

export interface CodeEditorOptions {
  value: string;
  /** Called after every edit the user makes, with the whole text; not
   * called by `setValue`. */
  onChange?(value: string): void;
  language?: CodeLanguage;
  readOnly?: boolean;
}

/** An inline error or warning mark. `line` and `column` are 1-based;
 * `endColumn` is exclusive. Without `column` the whole line is marked,
 * without `endColumn` the rest of the line from `column`. Positions past the
 * document are clamped to it. */
export interface CodeDiagnostic {
  line: number;
  column?: number;
  endColumn?: number;
  message: string;
}

export interface CodeEditorHandle {
  getValue(): string;
  /** Replaces the whole text as one undoable step, without `onChange`. */
  setValue(value: string): void;
  setReadOnly(readOnly: boolean): void;
  /** Replaces the editor's diagnostics; an empty list clears them. */
  setDiagnostics(diagnostics: CodeDiagnostic[]): void;
  focus(): void;
  /** Removes the editor from its container. */
  destroy(): void;
}

export interface PanZoomControls {
  zoomIn(): void;
  zoomOut(): void;
  /** Scales and centres the content to fit the container. */
  fit(): void;
  /** Back to 100%, top-left. */
  reset(): void;
  /** Re-applies the current transform; call after replacing the content. */
  refresh(): void;
  /** Removes the drag and wheel handlers. */
  dispose(): void;
}

export interface SaveFileOptions {
  /** Suggested file name; only its last path component is used. */
  defaultName: string;
  filters?: { name: string; extensions: string[] }[];
  data: Uint8Array;
}

export interface MahfouzPluginHost {
  apiVersion: typeof API_VERSION;
  plugin: PluginInfo;
  /** Render fenced code blocks tagged `language` with `renderer`. */
  registerEmbed(language: string, renderer: EmbedRenderer): Disposable;
  /** A kind of tab this plugin can open. Every plugin tab shows one note;
   * the app draws its toolbar (icon, note title, Close) and the plugin
   * renders the area below. */
  registerTabType(type: PluginTabType): Disposable;
  /** Opens (or focuses) one of this plugin's tabs for `note`. `arg` is
   * handed back as `ctx.arg` (e.g. which block to edit). Pending note saves
   * are flushed first. */
  openTab(type: string, note: NoteRef, arg: string): Promise<void>;
  /** A command on notes: in note context menus (`noteMenu`) and/or on a
   * shortcut (`shortcut` is the default; users rebind it in
   * `.config/settings.md` under `<plugin>:<command id>`). */
  registerCommand(command: PluginCommand): Disposable;
  /** A format in the Export dialog. The app collects the dialog's options,
   * passes the content to render, and offers to save the file you return. */
  registerExportFormat(format: ExportFormat): Disposable;
  /** A button, toggle or dropdown on the editor toolbar, acting on the
   * selected note. Only plugins the vault has enabled show items (a plugin
   * loaded only as a dependency gets a no-op). With `shortcut`, users
   * rebind it in `.config/settings.md` under `<plugin>:<item id>`, like a
   * command; item and command ids share one namespace. */
  registerToolbarItem(item: ToolbarItem): Disposable;
  /** Draws `languages` fences (e.g. `["mermaid"]`) to an SVG when a note
   * is published, so the page shows the diagram instead of its code.
   * `publishRender(lang, source)` gets the fence's text (CRLF as LF, shared
   * indentation and the trailing newline removed) and resolves to the SVG,
   * or null to publish the fence as code. Used only while the vault has this
   * plugin on; a render that takes over 10 seconds, throws, or returns over
   * 2 MB is published as code. The SVG must use a light theme and text
   * labels (Mermaid `htmlLabels: false`, Draw.io's text export): no
   * `<foreignObject>`, script, `on*` attributes, `href` other than `#…`,
   * `url(…)` other than `url(#…)`, or `@import`. The publishing service
   * sanitizes it with an allowlist and drops one that breaks a rule. Absent
   * in apps older than published diagrams. */
  registerPublishRenderer?(languages: string[], publishRender: PublishRenderer): Disposable;
  /** Turns an encrypted note's body (a note whose frontmatter says
   * `encrypted: <group>` and whose body is one ASCII-armored OpenPGP
   * message) into plaintext for the main editor, and back. `matches` picks
   * the notes this codec handles by their frontmatter. The app calls
   * `decode` only when the user acts on that note (Unlock, a reload after
   * the file changed, a Sync now merge of a note already unlocked), never at
   * boot or in the background; it calls `encode` once per save whose text
   * changed, and the result must be one armored message. The plaintext is
   * kept in memory only, never written anywhere, and every note this codec
   * decoded is locked again (its editor closed) when the plugin unloads.
   * Used only while the vault has this plugin on; the latest registration
   * that matches wins. Desktop only: absent on the web, which never decrypts,
   * and in apps older than encrypted notes.
   *
   * In `decode`, call `ctx.decryptNote()`: the desktop reads the note's
   * file itself and has the `mahfouz/encryption` plugin's sidecar decrypt
   * only its armored body, so no API decrypts ciphertext a caller hands in.
   * Installed plugins share one JavaScript realm and are one trust domain:
   * any enabled plugin could ask for a decrypt. The gate is gpg-agent:
   * configure it to ask for the passphrase or a YubiKey touch on every
   * decrypt (no cache) if other plugins are installed. */
  registerBodyCodec?(codec: BodyCodec): Disposable;
  /** A source in the Import dialog. The app owns the dialog, the
   * credential field (the secret goes straight to the app's native side,
   * never to `prepare`), the people mapping, the attachment downloads and
   * every vault write; `prepare` only reads the source and returns an
   * `ImportPlan`. Desktop only: absent where the app can't import (the
   * web), as it is in apps older than importers. */
  registerImporter?(importer: Importer): Disposable;
  /** HTTP through the app's native side, limited to the hosts this
   * plugin's manifest lists under `network` (https only). `secret` names a
   * session secret (an importer's `credential.secretName`) the app attaches
   * as a bearer token, only to the hosts the manifest lists for it. Every
   * status resolves; the body is parsed when the response is JSON, else
   * it's text. Desktop only: absent on the web. */
  http?: { request(spec: HttpRequestSpec): Promise<HttpResponse> };
  editor: {
    /** Inserts one of this plugin's registered embeds at the cursor, as
     * the Embed menu does. False when no note editor is open. */
    insertEmbed(language: string): boolean;
  };
  notes: {
    get(note: NoteRef): Promise<NoteInfo>;
    /**
     * Rewrites the note's attributes (frontmatter) and saves it. A list
     * attribute (one the note already holds as a list, such as a dash list
     * `tags:`) is a compact flow list, `["a", "b"]`: JSON strings separated
     * by a comma and one space. Return it in exactly that form to keep it a
     * list (an untouched one keeps its lines as written); any other value,
     * list-shaped text on a key that isn't a list included, is written as a
     * string.
     *
     * A relation key of a database row (a column linking rows of another
     * database, `authors!` with a visibility marker included) is set as the
     * exact list of linked rows: a flow list of note ids or link text
     * (`[[authors/herbert|Frank Herbert]]`), every added item a row of the
     * related database; an item already there and returned as written is
     * kept; a removed key removes every link. The other side follows: each
     * row added or removed gets or loses its link back to this note, in one
     * commit per relation key. Relation keys are written first and every
     * other key after them, so a refused relation value (an item that isn't
     * a row, a note that isn't a database row, a row whose value can't take
     * the link back) rejects with nothing written.
     */
    updateAttributes(
      note: NoteRef,
      update: (attributes: Record<string, string>) => Record<string, string>
    ): Promise<void>;
    /**
     * Writes `body` as the note's body, and saves it like an edit (the
     * auto-commit commits it). A note of the open vault only, and never in
     * a vault git-crypt has locked.
     *
     * An encrypted note (`encrypted: <group>` in its frontmatter) takes only
     * one ASCII-armored OpenPGP message, and `expected` must be the armored
     * body it was made from (`get(note).body`): a re-encryption, refused
     * when the file holds anything else by then. The note is locked again
     * (its editor closes): its unlocked plaintext came from the body this
     * replaces. Any other note is changed in its editor when it's open;
     * with `expected`, only while its body is still that.
     *
     * Desktop only, and only while the vault has this plugin on: absent on
     * the web and in apps older than encrypted notes.
     */
    writeBody?(note: NoteRef, body: string, expected?: string): Promise<void>;
    /**
     * Encrypts or decrypts the note in one write of its file, saved like an
     * edit (the auto-commit commits it):
     *
     * - `{group, armored, expected}`: a plaintext note becomes encrypted for
     *   `group` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`): `encrypted: <group>`
     *   and `armored` (one armored message) are written together. Its file
     *   keeps its path (its name stays visible) and its other attributes
     *   (strip them with `updateAttributes` if they mustn't be readable).
     * - `{plaintext, expected}`: an encrypted note becomes a plain one with
     *   `plaintext` as its body. Ask the user before you do this.
     *
     * `expected` is the body the change was made from (`get(note).body`):
     * refused, with nothing written, when the file holds anything else, or
     * the note's editor has edits not saved yet. Also refused for a note of
     * another vault, a note already in the asked state, and in a vault
     * git-crypt has locked. The note's editor closes either way.
     *
     * Desktop only, and only while the vault has this plugin on.
     */
    setEncryption?(note: NoteRef, change: EncryptionSwitch): Promise<void>;
  };
  /**
   * The open vault. Desktop only: absent on the web and in older apps.
   * `commitFiles` only while the vault has this plugin on.
   */
  vault?: {
    /** The open vault's id and absolute path, or null when none is open. */
    current(): VaultInfo | null;
    /** Called with each vault that becomes the open one; not for the one open now (read `current`). */
    onOpen(fn: (vault: VaultInfo) => void): Disposable;
    /** Called with each vault that stops being the open one. */
    onClose(fn: (vault: VaultInfo) => void): Disposable;
    /**
     * Commits exactly `paths` (relative to the vault, `/`-separated) with
     * `message`, and nothing else that's uncommitted; a note's rename
     * origin goes with it. Only `.gitattributes`, files under `.git-crypt/`,
     * this plugin's own `.config/<configFile>` and note files: anything
     * else, an absolute path or a `..` refuses the whole call with nothing
     * committed, as does a vault git-crypt has locked. A disk-only note (one
     * the user keeps out of commits) is skipped, never committed: its path
     * is listed in `skipped`. Resolves with whether anything was committed.
     */
    commitFiles(paths: string[], message: string): Promise<CommitFilesResult>;
  };
  /**
   * This plugin's own config file in the open vault: `.config/<configFile>`,
   * where `configFile` is its manifest's (`^[a-z0-9-]+\.md$`, never one of
   * the app's own: settings, bookmarks, fields, attributes, slides,
   * dictionary, commands). Every collaborator reads it; keep it readable
   * Markdown. Refused for a plugin that declares none, when another
   * installed plugin declares the same file, and when `.config` or the file
   * is a link. Desktop only, and only while the vault has this plugin on.
   */
  config?: {
    /** The file's text, or null when it doesn't exist (or the vault is locked). */
    read(): Promise<string | null>;
    /** Replaces the file's text (at most 1 MB), committed by the auto-commit; refused while the vault is git-crypt locked. */
    write(text: string): Promise<void>;
  };
  /**
   * git-crypt for the open vault. Desktop only, and only while the vault
   * has this plugin on.
   */
  git?: {
    /**
     * Stages `.gitattributes`, `.git-crypt/` and every tracked file cleaned
     * afresh (`git add --renormalize .`), then commits them with `message`
     * (the vault's own pending edits are committed first, apart). Refused
     * while the vault is locked or a git operation is stopped, while any
     * other tracked file holds an uncommitted edit (a disk-only note's
     * included: it would be swept into this commit), and when a file
     * git-crypt should encrypt would be committed in plaintext.
     * Resolves whether it committed.
     */
    renormalize(message: string): Promise<boolean>;
    /**
     * Checks out again every file a git-crypt filter covers, so git-crypt's
     * smudge runs (after an unlock: plaintext) or doesn't (with its config
     * removed, a lock: ciphertext), then rebuilds the vault's index. Runs
     * with the vault's auto-commit paused and file watching off. Refused
     * while anything in the vault is uncommitted. When the checkout fails
     * (a smudge that refuses), the files are put back as HEAD stores them
     * before it rejects, so nothing is left deleted. Resolves with the
     * paths written.
     */
    forceCheckout(): Promise<string[]>;
  };
  /** GitHub. Desktop only, and only while the vault has this plugin on. */
  repo?: {
    /** Creates a private repository named `name` for the signed-in user; resolves with its clone (SSH) URL. */
    createPrivate(name: string): Promise<CreatedRepo>;
  };
  /** Fenced code blocks in a note body, found as the editor finds them. */
  markdown?: {
    /** The blocks tagged `lang`, in document order. Index `i` is the block
     * whose `EmbedContext.ordinal` is `i`: `~~~` and longer fences, indented
     * fences and fences inside lists or blockquotes count, fences inside
     * other code blocks don't. `from`/`to` are offsets into `body` covering
     * the content lines, prefix included (empty for an empty block), `prefix`
     * is what a list or blockquote puts before each line, and `source` is the content with
     * that stripped and CRLF turned into LF. */
    fencedBlocks(body: string, lang: string): FencedBlock[];
    /** `body` with the `index`th `lang` block's content replaced by `source`
     * (LF line endings, no prefix): the block's prefix is re-applied to its
     * lines, the document's line ending is kept, and everything else stays
     * byte-for-byte. Works on an empty or unclosed fence. Throws when there
     * is no such block, and when a line of `source` would close the block's
     * fence (the same fence character, at least as many as the opening
     * fence, at most three spaces of indent, only whitespace after). */
    replaceFencedBlock(body: string, lang: string, index: number, source: string): string;
  };
  slides: {
    /** The slides template that applies to `note` — its `slides_template`
     * attribute, else the vault default from `.config/slides.md` — with the
     * note's own `header` / `footer` attributes applied over the template's
     * (`none` turns one off) and fields expanded; `{page}` and `{total}` are
     * left for you to fill per slide. `titleSlide` means draw neither on
     * slide 1. Null when there's no template and the note sets no header or
     * footer of its own; with no template but its own header/footer, a bare
     * template (name "") carrying just those. Image paths are root-absolute
     * `/files/<name>`. `stylesheet` is the whole look as one CSS string (the
     * fields, the `###` layout and slide-1 sections, the raw css, and the
     * fonts as `@import` / `@font-face`); `colorSchema` is Slidev's, from the
     * background; `fontFamilies` are the families it loads, to wait for
     * before export. `css` is the raw template css, already inside
     * `stylesheet`; the older keys (`background` … `cover`) stay filled for
     * a plugin that predates `stylesheet` (empty `stylesheet` on a bare
     * template). */
    resolveTemplate(note: NoteRef): Promise<ResolvedSlidesTemplate | null>;
    /** Draws Settings → Slides' sample deck with Slidev, for its "Render
     * with Slidev" button (desktop only). `req.markdown` is the sample deck
     * as Slidev Markdown (headmatter for slide 1, then `---` blocks with
     * `layout:` and `class:`); `req.template` is the template being edited,
     * resolved as `resolveTemplate` resolves one, with the sample deck's
     * header and footer applied; `req.vaultPath` is the vault's absolute
     * path, for its `/files/`. Resolve with one PNG per slide, in order, as
     * `data:image/png;base64,…` data URLs: at most 30 slides of at most
     * 4 MB each, within 200 seconds; anything else is refused. Used only
     * while the vault has this plugin on; the latest registration wins.
     * Optional: absent in apps older than Render with Slidev. */
    registerPreviewRenderer?(render: (req: SlidesPreviewRequest) => Promise<SlidesPreviewResult>): Disposable;
  };
  /** Makes `api` available to plugins that declare this one as a dependency. */
  provide(api: object): void;
  /** The API a declared dependency `provide`d. Dependencies are activated
   * first — even when the vault has them off, in which case their
   * `isEnabled()` is false. */
  use<T = unknown>(dependency: PluginId): Promise<T>;
  sidecar: {
    /** JSON-RPC request to this plugin's sidecar process, started on first use. */
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
    /** Notifications the sidecar sends (`{"jsonrpc":"2.0","method":…,"params":…}`). */
    onNotify(method: string, fn: (params: unknown) => void): Disposable;
  };
  /** Notification-center progress for a long task; pass an empty `detail` to clear it. */
  progress(detail: string, percent?: number): void;
  toast(message: string, kind?: "info" | "error"): void;
  /** Whether this plugin is turned on for the current vault (false when it
   * was only loaded as another plugin's dependency). */
  isEnabled(): boolean;
  /** Small pieces of the app's own embed UI, so plugin embeds look native. */
  ui: {
    /** Drag-to-pan and wheel-zoom on a rendered embed that overflows its
     * container; a plain click still falls through. Returns an undo, to call
     * from the renderer's `dispose`. */
    attachPanZoom(container: HTMLElement): () => void;
    /** Replaces `container`'s content with the app's embed error box. */
    showError(container: HTMLElement, message: string): void;
    /** Covers the whole app window (native fullscreen) with plugin content;
     * the app handles Esc, View → Stop Presenting and the close button.
     * Returns a function that closes it. */
    openOverlay(spec: OverlaySpec): () => void;
    /** Opens an http(s) URL in the user's browser. */
    openExternal(url: string): Promise<void>;
    /** Mounts a source editor in `container`, styled like the note
     * editor, with line numbers, undo history, bracket matching and Tab to
     * indent. Call `destroy` from your tab's or embed's `dispose`. */
    createCodeEditor?(container: HTMLElement, options: CodeEditorOptions): CodeEditorHandle;
    /** Drag-to-pan and wheel-zoom for `container`, plus buttons' actions.
     * Unlike `attachPanZoom`, the target (the container's first child) is
     * looked up on every call, so a preview that is re-rendered keeps
     * working: call `refresh` after replacing the content. */
    createPanZoom?(container: HTMLElement): PanZoomControls;
    /** Asks where to save `data` in the native save dialog and writes it
     * there. Resolves to the path written, or null when the user cancelled.
     * On the web it downloads `data` instead and resolves to the file name. */
    saveFile?(options: SaveFileOptions): Promise<string | null>;
  };
}

/** Shape of a plugin's frontend module. */
export interface PluginModule {
  activate(host: MahfouzPluginHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
