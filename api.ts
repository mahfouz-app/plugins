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
import type { EmbedRenderer } from "./embed";
export type PluginId = `${string}/${string}`;

export type { EmbedRenderer };

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
}

/** Shape of a plugin's frontend module. */
export interface PluginModule {
  activate(host: MahfouzPluginHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
