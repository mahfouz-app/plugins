# Mahfouz plugins

The official plugin registry for [Mahfouz](https://github.com/mahfouz-app). Mahfouz has it built in
as the `mahfouz` registry. Other registries use the same layout and can be added in
**Preferences → Plugins → Registries** with a git URL or a GitHub `owner/repo`.

> **Trust:** a plugin runs with the user's full permissions. That covers its frontend module
> in the app's webview and its optional background process (a "sidecar"). Only add
> registries you trust.

## Plugins

| Plugin | What it does | Installs |
|---|---|---|
| `mahfouz/mermaid` | Renders ```` ```mermaid ```` blocks as diagrams | The pinned `mermaid` npm package (only its self-contained ESM build, ~25 MB). No Node.js needed |
| `mahfouz/drawio` | Renders ```` ```drawio ```` blocks, and edits one in a draw.io tab | The pinned jgraph/drawio v31.4.6 web app (~154 MB) |
| `mahfouz/slidev` | **Present** a note as a [Slidev](https://sli.dev) deck, in a tab or full screen (`Mod+Shift+P`) | Slidev, its default theme and playwright-chromium, with `npm ci` from the committed lockfile. Needs Node.js 22.12+ |
| `mahfouz/pdf` | **PDF** in the Export dialog, rendered by Slidev | Nothing of its own; depends on `mahfouz/slidev` |
| `mahfouz/lfs` | Puts a managed `git-lfs` on git's PATH, so a vault can store media as Git LFS pointers | git-lfs 3.8.0, macOS (Apple Silicon and Intel) |

`npm test` runs the plugins' tests and the registry checker's with `node --test` (no
dependencies).

## Releasing

`main` is the release: every Mahfouz install pulls this repository at launch, and shows **Update
available** for any plugin whose `version` differs from the one it installed. So:

1. **Change a plugin → raise its `version`** (semver) in the same PR. Without it, nobody gets the
   change. CI fails a PR that changes anything under `plugins/<id>/` without raising that
   plugin's version above the base branch's.
2. **Needs something new from the app → raise `mahfouz`** to the first app release that has it,
   so older apps show "Requires Mahfouz …" instead of a broken plugin. It's a Rust `semver` range:
   comparators separated by commas (`">=0.5.0, <1.0.0"`), not spaces or `||`.
3. **Merge.** Users see the update the next time their app pulls the registry (at launch, or
   **Check for updates**), and it's applied only when they approve it.

There's no build step and nothing to publish: every artifact a manifest downloads comes from its
upstream (npm, GitHub releases) and is pinned by sha256.

### CI

`.github/workflows/ci.yml` runs on every PR, on `main`, and weekly:

- `npm test`
- `node scripts/check.mjs --base <base branch>`: every manifest against the rules the app's
  parser enforces (fields, slugs, versions, the `mahfouz` range, paths staying inside the plugin,
  dependencies, the files `frontend`/`sidecar`/npm steps name), plus the version-bump rule
- `npm ci --ignore-scripts` wherever there's a lockfile, so it's known to match its `package.json`
- `node scripts/check.mjs --artifacts`: downloads each artifact and checks its sha256 (on a PR,
  only for plugins whose manifest changed; weekly, all of them, in case an upstream URL breaks)

Run the same locally with `npm test && node scripts/check.mjs --base origin/main`.

## Layout

```
registry.json               { "schema": 1, "name": "mahfouz", "description": "…" }
plugins/<id>/plugin.json    the plugin's manifest
plugins/<id>/…              frontend module, sidecar script, package-lock.json, …
api.ts, embed.ts, tabs.ts,  host API types (vendored from the app; keep in sync)
host.ts
```

- **Registry `name`:** lowercase letters, digits and `-`, up to 32 characters, and unique on
  the user's machine. `mahfouz` is reserved for this repo.
- **Plugin `id`:** follows the same rules. Everywhere outside its manifest, a plugin is referred
  to by its **qualified id**, `<registry>/<id>` (e.g. `mahfouz/mermaid`). That is also the key
  vaults use in `.config/settings.md` under `## Plugins`.

Mahfouz clones a registry with `git clone --depth 1` and refreshes it at every launch. An
installed plugin is a **copy** of `plugins/<id>/` taken at install time. Pushing a new version
here only shows users an "Update available" button; nothing changes on their machine until they
approve the update.

## `plugin.json` (schema 1)

```json
{
  "schema": 1,
  "id": "example",
  "version": "1.0.0",
  "label": "Example",
  "description": "One line shown next to the toggle",
  "mahfouz": ">=0.4.0",
  "apiVersion": 1,
  "dependencies": ["mahfouz/other"],
  "install": [
    { "type": "npm", "dir": "." },
    { "type": "download", "extract": "tar.gz", "to": "bin",
      "artifacts": {
        "darwin-arm64": { "url": "https://…/tool-darwin-arm64.tar.gz", "sha256": "<64 hex>" }
      } }
  ],
  "gitPath": ["bin"],
  "frontend": "index.js",
  "sidecar": { "runtime": "node", "entry": "sidecar.js" }
}
```

Only `schema`, `id`, `version`, `label`, `description`, `mahfouz` and `apiVersion` are required.
Unknown fields are rejected, so a typo fails loudly instead of being ignored. Every path must be
relative and stay inside the plugin's directory.

| Field | Meaning |
|---|---|
| `version` | Semver. The user sees an update whenever it differs from the installed version. |
| `mahfouz` | Semver range the app version must satisfy. Otherwise the plugin shows "Requires Mahfouz …". |
| `apiVersion` | Host API major version (`api.ts`). Currently `1`. |
| `dependencies` | Qualified ids installed first. A dependency from a registry the user hasn't added blocks the install. |
| `install` | Steps run in order inside the plugin's installed directory. |
| `install[].type: "npm"` | Runs `npm ci` in `dir` (default `.`). Needs a committed `package-lock.json`. Needs Node.js on the user's machine. `"progress": "npm-fetch"` shows a percentage by counting npm's package downloads against the lockfile. |
| `install[].type: "download"` | Fetches the artifact for the user's platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `windows-x64`), or the `"any"` one for platform-independent files. A **sha256 mismatch aborts the install**. `extract` is `tar.gz`, `zip`, or `none` (the default; with `none`, `to` is the saved file's path). `include` optionally limits unpacking to those archive paths (a directory unpacks its contents). A platform with no artifact and no `"any"` shows "Not available on this platform". |
| `gitPath` | Directories put on `PATH` for every git command Mahfouz runs (e.g. a `git-lfs` binary). |
| `frontend` | ES module the app imports. It must export `activate(host)` and may export `deactivate()`. **Ship a single bundled file**: relative imports aren't refreshed on update until the app restarts. |
| `sidecar` | Background process. `{ "runtime": "node", "entry": "sidecar.js" }` runs it with the user's Node. `{ "runtime": "native", "entry": { "<platform>": "bin/tool" } }` runs a binary your `download` step produced. |

Checksums live in this repo's git history, so a release asset swapped after the fact can't be
installed silently. Pin artifacts to immutable URLs (release assets, not `latest`).

## Frontend (`api.ts`)

```js
export function activate(host) {
  host.registerEmbed("example", {
    label: "Example block",
    snippet: "hello",
    render(container, source) {
      container.textContent = source.toUpperCase();
    },
  });
}
```

Everything a plugin registers is disposed when the user turns it off for the vault, switches
to a vault that doesn't use it, updates it, or uninstalls it. `host.plugin.baseUrl` is the URL
of the plugin's installed directory. Load assets relative to it.

Embed renderers also get a fourth `render` argument, `{ ordinal, note }`: which block of their
language this is in the note, and the note itself. Read `note` when the user acts (e.g. on
click), not while rendering. `onInsertedAt(view, from, note)` runs right after the toolbar
inserts your snippet.

### Tabs

A plugin can open tabs with `host.registerTabType({ id, icon, render(container, ctx) })` and
`host.openTab(type, note, arg)`. Every plugin tab shows one note. The app draws the toolbar
(icon, note title, Close), keeps the tab in its tab strip, and closes it if the note is
deleted. `render` fills the area below; the function it returns runs when the tab unmounts,
including on a tab switch, so flush unsaved work there. `ctx` has `note`, your `arg`,
`readBody()`, `writeBody(body)` (the app's normal save path) and `close()`. `openTab` saves
the note's pending edits first, so `readBody()` sees them.

### Commands, overlays, export formats, and other plugins

- `host.registerCommand({ id, label, icon?, noteMenu?, shortcut?, run(note) })` adds a command to
  note menus (`noteMenu`) and/or a keyboard shortcut. `shortcut` is only the default: users rebind
  or disable it in `.config/settings.md` under `## Shortcuts`, row `<registry>/<plugin>:<command id>`.
- `host.ui.openOverlay({ title, render(container, { close }) })` covers the whole window (native
  full screen). The app handles Esc, View → Stop Presenting and the close button.
- `host.registerExportFormat({ id, label, export(request, progress) })` adds a format to the Export
  dialog. You get the note and, when the dialog's options changed it, the Markdown to render; you
  return a file you rendered in the OS temp dir, and the app asks where to save it.
- `host.notes.get(note)` gives the note's title, path, vault path, attributes and body;
  `host.notes.updateAttributes(note, update)` rewrites its frontmatter.
- `host.provide(api)` makes an API available to plugins that list yours in `dependencies`; they call
  `await host.use("<registry>/<plugin>")`. A dependency is loaded first, even when the vault has it
  turned off — then `host.isEnabled()` is false, and it should only `provide`.
- A plugin tab's `ctx.setToolbar(buttons)` puts buttons in the app's toolbar;
  `host.ui.openExternal(url)` opens an http(s) URL in the browser.
- Plugin UI can use the app's `presentation-*` classes (`presentation-status`,
  `presentation-status-title`, `presentation-spinner`, `presentation-log`, `presentation-cta`,
  `presentation-frame`) to match the app's own panes.

API v1 covers embeds (`registerEmbed`), tabs (`registerTabType`, `openTab`), commands, overlays,
export formats, notes, `provide`/`use`, the sidecar (`sidecar.call` and `sidecar.onNotify`),
`progress`, `toast`, `isEnabled`, and `ui.attachPanZoom` / `ui.showError` so embeds look like
the app's own.

## Sidecar protocol

Newline-delimited JSON-RPC 2.0 over stdin and stdout:

- **The app sends requests:** `{"jsonrpc":"2.0","id":1,"method":"render","params":{…}}`. Answer
  each with `{"jsonrpc":"2.0","id":1,"result":…}` or `{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"…"}}`.
- **The sidecar can send notifications:** `{"jsonrpc":"2.0","method":"progress","params":{…}}`.
  They're delivered to `host.sidecar.onNotify(method, fn)`.
- **stderr** is shown in the plugin's page in Settings (the last 200 lines).
- **Environment:** `MAHFOUZ_PLUGIN_DIR` (installed directory, also the cwd),
  `MAHFOUZ_PLUGIN_DATA_DIR` (survives updates, deleted on uninstall) and `MAHFOUZ_API_VERSION`.
- **Lifecycle:** the process starts on the first call and runs in its own process group. It is
  stopped when the plugin is disabled, updated or uninstalled, and when the app quits. After 3
  crashes within 60 seconds it isn't restarted until the next launch.
