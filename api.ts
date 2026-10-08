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

// Vendored from mahfouz-app/app src/app/src/plugins/api.ts — keep in sync.
import type { EmbedContext, EmbedRenderer } from "./embed";
import type {
  CommandNote,
  ExportFormat,
  ExportRequest,
  ExportResult,
  FencedBlock,
  NoteInfo,
  OverlaySpec,
  PluginCommand,
  ResolvedSlidesTemplate,
} from "./host";
import type { NoteRef, PluginTabContext, PluginTabType, ToolbarButton } from "./tabs";

export type PluginId = `${string}/${string}`;
export type {
  CommandNote,
  EmbedContext,
  EmbedRenderer,
  ExportFormat,
  ExportRequest,
  ExportResult,
  FencedBlock,
  NoteInfo,
  NoteRef,
  OverlaySpec,
  PluginCommand,
  PluginTabContext,
  ResolvedSlidesTemplate,
  PluginTabType,
  ToolbarButton,
};

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
  notes: {
    get(note: NoteRef): Promise<NoteInfo>;
    /** Rewrites the note's attributes (frontmatter) and saves it. */
    updateAttributes(
      note: NoteRef,
      update: (attributes: Record<string, string>) => Record<string, string>
    ): Promise<void>;
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
     * attribute, else the vault default from `.config/slides.md` — or null
     * (none defined, or the note opted out with `none`). Image paths are
     * root-absolute `/files/<name>`. Absent before Mahfouz 0.8.0. */
    resolveTemplate(note: NoteRef): Promise<ResolvedSlidesTemplate | null>;
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
  /** Status-bar progress for a long task; pass an empty `detail` to clear it. */
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
     * Rejects where there is no save dialog (the web). */
    saveFile?(options: SaveFileOptions): Promise<string | null>;
  };
}

/** Shape of a plugin's frontend module. */
export interface PluginModule {
  activate(host: MahfouzPluginHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
