// Vendored from mahfouz-app/app src/app/src/plugins/tabs.ts — keep in sync.

export interface NoteRef {
  vaultId: string;
  noteId: string;
}

export interface ToolbarButton {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick(): void;
}

export interface PluginTabContext {
  note: NoteRef & { title: string };
  /** The plugin-defined argument the tab was opened with. */
  arg: string;
  /** The note's saved body. */
  readBody(): Promise<string>;
  /** Saves a new body through the app's normal save path (commit, reindex). */
  writeBody(body: string): Promise<void>;
  /** Closes this tab. */
  close(): void;
  /** Buttons shown in the app's toolbar, before Close. Call again to update
   * them (e.g. enable once loaded). */
  setToolbar(buttons: ToolbarButton[]): void;
}

export interface PluginTabType {
  id: string;
  /** One character shown before the note title in the tab strip. */
  icon?: string;
  /** Renders into `container` (below the app's toolbar). The returned
   * function runs when the tab unmounts — switching tabs unmounts too, so
   * flush anything unsaved there. */
  render(container: HTMLElement, ctx: PluginTabContext): void | (() => void);
}
