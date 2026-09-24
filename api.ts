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
import type { NoteRef, PluginTabContext, PluginTabType } from "./tabs";

export type PluginId = `${string}/${string}`;
export type { EmbedContext, EmbedRenderer, NoteRef, PluginTabContext, PluginTabType };

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
  sidecar: {
    /** JSON-RPC request to this plugin's sidecar process, started on first use. */
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
    /** Notifications the sidecar sends (`{"jsonrpc":"2.0","method":…,"params":…}`). */
    onNotify(method: string, fn: (params: unknown) => void): Disposable;
  };
  /** Status-bar progress for a long task; pass an empty `detail` to clear it. */
  progress(detail: string, percent?: number): void;
  toast(message: string, kind?: "info" | "error"): void;
  /** Whether this plugin is turned on for the current vault. */
  isEnabled(): boolean;
  /** Small pieces of the app's own embed UI, so plugin embeds look native. */
  ui: {
    /** Drag-to-pan and wheel-zoom on a rendered embed that overflows its
     * container; a plain click still falls through. Returns an undo, to call
     * from the renderer's `dispose`. */
    attachPanZoom(container: HTMLElement): () => void;
    /** Replaces `container`'s content with the app's embed error box. */
    showError(container: HTMLElement, message: string): void;
  };
}

/** Shape of a plugin's frontend module. */
export interface PluginModule {
  activate(host: MahfouzPluginHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
