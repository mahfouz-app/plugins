// Vendored from mahfouz-app/app src/core/src/plugins/tabs.ts — keep in sync.

/** The app's resolved light/dark theme. */
export type ResolvedTheme = "light" | "dark";

export interface NoteRef {
  vaultId: string;
  noteId: string;
}

export interface ToolbarButton {
  label: string;
  title?: string;
  /** Inline SVG body (24×24 viewBox, stroke-based), shown before the label. */
  icon?: string;
  disabled?: boolean;
  /** Makes the button a dropdown: clicking it lists these items instead of
   * calling `onClick`. */
  menu?: { label: string; onSelect(): void }[];
  onClick?(): void;
}

export interface PluginTabContext {
  note: NoteRef & { title: string };
  /** The plugin-defined argument the tab was opened with. */
  arg: string;
  /** The note's saved body. It becomes `writeBody`'s merge base. */
  readBody(): Promise<string>;
  /**
   * Saves a new body through the app's normal save path (commit, reindex),
   * merged with any change made to the note outside this tab since the
   * tab's base: the body of its last `readBody` or its last write,
   * whichever came later (the note's body when the tab opened, before
   * either). Resolves with the body written, which holds those outside
   * changes too. Rejects, with nothing written, and with a message that
   * says what to do; match on `err.name`, since a plugin's own copy of the
   * classes isn't the app's (`instanceof` fails across bundles):
   * - `NoteChangedError`: an outside change overlaps this one;
   * - `NoteKeptError`: the note has edits kept for the user's choice
   *   (open it and choose first);
   * - `EncryptedNoteReadOnlyError`: the note is encrypted, so read-only;
   * - a plain `Error` when the note no longer exists, or its file is
   *   missing; any other failure of the save passes through as it is.
   * On a rejection, keep the user's edit (don't discard it) so they can
   * save again once the note is settled.
   *
   * Apps before this contract resolved with `undefined` and overwrote the
   * note; treat a non-string result as "written as sent".
   */
  writeBody(body: string): Promise<string | void>;
  /** Closes this tab. */
  close(): void;
  /** Buttons shown in the app's toolbar, before Close. Call again to update
   * them (e.g. enable once loaded). */
  setToolbar(buttons: ToolbarButton[]): void;
  /** The app's current light/dark theme. */
  readonly theme: ResolvedTheme;
  /** Calls `fn` when the theme changes (a setting change, or the OS preference
   * while the setting is "system"). Returns an unsubscribe function; any
   * subscription left over ends when the tab unmounts. */
  onThemeChange(fn: (theme: ResolvedTheme) => void): () => void;
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
