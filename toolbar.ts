// Vendored from mahfouz-app/app src/app/src/plugins/toolbar.ts — keep in sync.
import type { Disposable } from "./api";
import type { CommandNote } from "./host";

interface ToolbarItemBase {
  id: string;
  /** Tooltip and aria-label. */
  label: string;
  /** Inline SVG body (24×24, stroke). Omit to use the plugin's manifest icon. */
  icon?: string;
  /** Default binding, e.g. `Mod+Shift+D`; users rebind it in settings. */
  shortcut?: string;
  /** Hide the item for notes it doesn't apply to. */
  when?(note: CommandNote): boolean;
}

export interface ToolbarDropdownOption {
  id: string;
  label: string;
  icon?: string;
  run(note: CommandNote): void | Promise<void>;
}

export type ToolbarItem =
  | (ToolbarItemBase & { kind: "button"; run(note: CommandNote): void | Promise<void> })
  | (ToolbarItemBase & {
      kind: "toggle";
      isActive(note: CommandNote): boolean;
      /** Call `fn` when `isActive` may have changed. */
      onChange(fn: () => void): Disposable;
      toggle(note: CommandNote): void | Promise<void>;
    })
  | (ToolbarItemBase & {
      kind: "dropdown";
      /** Computed each time the menu opens. */
      options(note: CommandNote): ToolbarDropdownOption[];
    });
