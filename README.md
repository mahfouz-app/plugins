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
| `mahfouz/mermaid` | Renders ```` ```mermaid ```` blocks as diagrams (sized by a `%% size: fit` or `fit-height` line, or the editor's **Size** menu), edits one in a split editor tab, and draws them as images on published pages | The pinned `mermaid` npm package (only its self-contained ESM build, ~25 MB). No Node.js needed |
| `mahfouz/drawio` | Renders ```` ```drawio ```` blocks, edits one in a draw.io tab, and draws them as images on published pages | The pinned jgraph/drawio v31.4.6 web app (~154 MB) |
| `mahfouz/slidev` | **Present** a note as a [Slidev](https://sli.dev) deck, in a tab or full screen (`Mod+Shift+P`), styled by the vault's slides template (`.config/slides.md`) when it has one, and export it as **PowerPoint** (editable `.pptx`, which Google Slides imports) | Node.js 24.21.0 (~50 MB), then Slidev, its default theme and playwright-chromium with `npm ci` from the committed lockfile. No Node.js needed. macOS, Linux and Windows (x64 and Apple Silicon/arm64) |
| `mahfouz/pdf` | **PDF** in the Export dialog, rendered by Slidev | Nothing of its own; depends on `mahfouz/slidev` |
| `mahfouz/lfs` | Puts a managed `git-lfs` on git's PATH, so a vault can store media as Git LFS pointers | git-lfs 3.8.0, macOS (Apple Silicon and Intel) |
| `mahfouz/notion` | **Notion** in the Import dialog: pages, sub-pages, databases (with typed columns), tasks, comments, mentions and files from a Notion workspace, through Notion's API with an internal integration token. Desktop only | Nothing; needs Mahfouz 0.12.0 |
| `mahfouz/encryption` | Encrypts notes end to end with GPG, so only you and the people you choose can read them. Desktop only (macOS) | Its `git-crypt` sidecar binary (built in this repo, see below), macOS (Apple Silicon and Intel). Needs GPG and Mahfouz 0.12.0 (the first release with the host APIs and the manifest `terms` it uses) |

`npm test` runs the plugins' tests and the registry checker's with `node --test` (no
dependencies).

## Encryption plugin

`mahfouz/encryption` encrypts a note's body as one signed and encrypted, ASCII-armored OpenPGP
message, readable only by the keys it was encrypted to. It's **desktop only**: the web app never
decrypts. It needs **GPG** on the Mac ([GPG Suite](https://gpgtools.org), or
`brew install gnupg pinentry-mac`); the sidecar looks for `gpg` on `PATH`, then in
`/opt/homebrew/bin`, `/usr/local/bin` and `/usr/local/MacGPG2/bin`, and reports the path it uses.

- Signing and decrypting use **your** keyring and gpg-agent, so your passphrase or security key
  is asked for by your own pinentry. Nothing is ever imported into your keyring.
- Other people's public keys (fetched from `https://github.com/<login>.gpg`, the plugin's only
  network host) go into a **plugin-owned keyring** in the plugin's data directory.
- A note decrypts only when it's signed by a key you allow. A signer's key that has expired
  since still counts for what it signed while valid; a revoked one never does. Recipients that
  are expired, revoked or can't encrypt are refused, and so is signing with an expired key.

- **Groups** live in the vault's `.config/encryption.md`: a `## <group>` heading per group, each
  with a `| login | fingerprint |` table of full (40- or 64-digit) fingerprints. The app reads the
  same file (`groupSigners`): a group's fingerprints are the only signers its notes' decrypts
  accept, and with your backup key they're the recipients of every encrypt. "Only me" is the
  group `only-<login>`; a group you create lists your signing and backup keys.
- **Your signing key, backup key and GitHub login** are per machine, in the app's `localStorage`
  (`mahfouz.encryption.keys`), never in the vault.
- **Decrypting is the app's:** the host refuses the sidecar's `decrypt` from plugin code. The body
  codec calls `ctx.decryptNote()` on an Unlock, where the desktop reads the note's file itself,
  and `ctx.decryptBlob(ctx.sha)` in a merge, where it reads that commit's version from git.
  Decrypt and a member's re-encryption ask `host.notes.decrypt(note)`, which reads the file too.
- **Adding a member** to a group re-encrypts each of its notes (`host.notes.listEncrypted(group)`,
  `host.notes.decrypt`, encrypt, `host.notes.writeBody(note, armored, expected)`, written only
  while the file still holds what was decrypted), then writes `.config/encryption.md` and commits
  the notes and the config in one `host.vault.commitFiles` (a disk-only note is left out, and the
  plugin says how many). **Stop sharing** only removes their rows: new edits leave their key out.
- **In the app:** Settings → Encryption is a Settings tab (`host.registerSettingsTab`); the dialogs
  and questions are the app's (`host.ui.openDialog`, `host.ui.confirm`). Encrypt… shows only on a
  plain note and Decrypt… only on an encrypted note unlocked this session, from what the app says
  of the note (`CommandNote.encryptedGroup`, `unlocked`), in the note menu, the palette and the
  toolbar. The settings page warns when other enabled plugins can reach the network
  (`host.plugins.list()`). In an app without these (older than 0.12.0) the plugin registers its
  body codec alone, so encrypted notes still unlock and save.

> **Trust:** Installed plugins share one JavaScript realm; any enabled plugin could ask for a
> decrypt. Configure gpg-agent to ask for your passphrase or a YubiKey touch on every decrypt.

### Vault encryption

The plugin can also encrypt a whole vault's git repository, so the remote (GitHub) only ever
holds ciphertext. It uses [git-crypt](https://github.com/AGWA/git-crypt)'s scheme and layout,
byte for byte, so the real `git-crypt` reads a vault the plugin encrypted and the plugin reads
a repository `git-crypt` encrypted. CI checks both directions against the real CLI.

- **Enable** (`initVault`): generates the vault key, stores it in `.git/git-crypt/keys/default`
  (this clone only, 0600), encrypts it to each member's GPG key as
  `.git-crypt/keys/default/0/<fingerprint>.gpg` (committed), and points git's
  `filter.git-crypt` and `diff.git-crypt` at the plugin's binary. It also appends
  `* filter=git-crypt diff=git-crypt` (with `.gitattributes` and `.git-crypt/**` left out) to
  the root `.gitattributes`, since the app has no plugin API that writes that file; Mahfouz then
  renormalizes and commits. One of the members must be one of your own keys; add a second one
  (a backup key) so a lost key doesn't lose the vault. A vault that stores files with Git LFS is
  refused: git-crypt would encrypt the LFS pointer files.
- **Unlock** (`unlockVault`), on another Mac or a fresh clone: decrypts your member file with
  your gpg (pinentry asks), installs the key and the filter, and Mahfouz checks the files out
  again as plaintext. **Lock** (`lockVault`) removes both, and is refused while anything is
  uncommitted (once the key is gone nothing can be encrypted); the files are checked out again
  as ciphertext.
- **Members** (`addVaultMember`, `removeVaultMember`): adding one encrypts the vault key to
  their public key (imported from `https://github.com/<login>.gpg`). **Removing a member doesn't
  rotate the key**: whoever had it can still decrypt everything committed with it, past and
  future, until the key changes.
- **Terms:** `terms.md` (the manifest's `terms`) states git-crypt's limits: names, commit
  messages and change times stay readable, the key can't be rotated, earlier commits stay
  unencrypted, no Git LFS and terminal commands need the real `git-crypt`, and every installed
  plugin can ask your keys to decrypt (set gpg-agent to ask for the passphrase or a YubiKey touch
  on every decrypt). The app shows it at install and enable; the *Encrypt vault* dialog shows it
  too and keeps *Encrypt vault* disabled until "I accept these terms" is ticked, or when the file
  can't be read.
- **What stays visible:** file and folder names, file sizes (to the byte), which files changed
  in each commit, commit messages, authors and dates, and branch names. Two identical files
  give identical ciphertext. Encrypt the content, not the shape.
- **In the app:** Settings → Encryption → *Encrypt this vault on GitHub* encrypts the open vault
  for your signing and backup keys (a renormalize commits what's pending first and refuses an
  edited file; then `initVault`; then a renormalize commits every file encrypted), and once it's
  encrypted shows Lock/Unlock (and the palette's **Unlock vault**) and its members, by login where
  `.config/encryption.md` lists the fingerprint. The sidebar's locked-vault notice gets an
  **Unlock** button (`host.registerVaultUnlocker`). The palette's **Unlock vault** runs that same
  unlocker through `host.vault.unlock()`, so both take the app's steps after the unlock; on an app
  without it, the command unlocks directly.
- **History and naming:** with a remote, the Encrypt dialog asks what happens to the unencrypted
  history, offering only what the app can do: *Move to a new private repository*
  (`host.repo.moveToNewPrivate(name)`), *Rewrite history and force-push*
  (`host.git.rewriteHistory(message)`), and *Encrypt from now on*. The app asks its own
  confirmation and pushes; the plugin never sets a remote or pushes. Where the app has
  `host.settings.setNewNoteNaming("id")` and `host.settings.setCommitMessageNaming("none")`, new
  notes are named by id and commit messages stop naming notes; where it has
  `host.notes.countRenamableById()` and `host.notes.renameAllById()`, the dialog offers to rename
  the existing notes too. Each is feature-detected and left out of the dialog when absent.
- **In a terminal:** git runs the filter by the path Mahfouz configured, so `git` works in an
  unlocked vault. Commands like `git-crypt unlock`, `lock` and `status` need the real
  `git-crypt` installed (`brew install git-crypt`); the plugin's binary only runs git's filters.

The sidecar is a Rust crate in `plugins/encryption/sidecar/`, built into one binary named
`git-crypt`: run with no arguments it's the sidecar, and run as `git-crypt clean`, `smudge` or
`diff` it's git-crypt's filter (the manifest's `gitPath` puts it on the PATH of every git
command Mahfouz runs). It isn't built by the app:
`.github/workflows/encryption-release.yml` builds it for both Macs when a tag
`encryption-v<version>` is pushed and attaches `git-crypt-darwin-<arch>.tar.gz` to that
release, and `plugin.json` downloads it pinned by sha256. A new sidecar version is released in
that order: raise `version` (plugin.json and `Cargo.toml`) and the artifact URLs, push the tag,
then copy the two checksums from the workflow's summary into `plugin.json`. CI's artifact check
fails until they match. CI also runs the crate's `cargo fmt --check`, clippy and tests, with gpg
and git-crypt installed, so the tests against the real gpg and git-crypt run there.

## Releasing

`main` is the release: every Mahfouz install pulls this repository at launch, and shows **Update
available** for any plugin whose `version` differs from the one it installed. So:

1. **Change a plugin → raise its `version`** (semver) above the one on `main`. Without it, nobody
   gets the change. CI fails a PR that changes anything under `plugins/<id>/` while that plugin's
   version isn't above `main`'s. The comparison is always with `main`, the release line, never a
   stacked PR's base: a stack of PRs that ships as one release raises the version once, and a
   plugin that isn't on `main` yet needs no bump until it's released.
2. **Needs something new from the app → raise `mahfouz`** to the first app release that has it,
   so older apps show "Requires Mahfouz …" instead of a broken plugin. It's a Rust `semver` range:
   comparators separated by commas (`">=0.5.0, <1.0.0"`), not spaces or `||`.
3. **Merge.** Users see the update the next time their app pulls the registry (at launch, or
   **Check for updates**), and it's applied only when they approve it.

There's no build step and nothing to publish: every artifact a manifest downloads comes from its
upstream (npm, GitHub releases) and is pinned by sha256.

### CI

`.github/workflows/ci.yml` runs on every PR, on `main`, and weekly:

- `node scripts/check.mjs --base origin/main`: every manifest against the rules the app's
  parser enforces (fields, slugs, versions, the `mahfouz` range, paths staying inside the plugin,
  dependencies, the files `frontend`/`sidecar`/npm steps name, fields newer than the `mahfouz` range
  allows), plus the version-bump rule against `main`
- `npm ci --ignore-scripts` wherever there's a lockfile, so it's known to match its `package.json`
- `npm test`, after those installs, since a plugin's tests can import its own dependencies
- `node scripts/check.mjs --artifacts`: downloads each artifact and checks its sha256 (on a PR,
  only for plugins whose manifest differs from `main`'s; weekly, all of them, in case an upstream URL breaks)

Run the same locally with `npm test && node scripts/check.mjs --base origin/main`.

## Layout

```
registry.json               { "schema": 1, "name": "mahfouz", "description": "…" }
plugins/<id>/plugin.json    the plugin's manifest
plugins/<id>/…              frontend module, sidecar script, package-lock.json, …
api.ts, embed.ts, tabs.ts,  host API types (vendored from the app; keep in sync)
host.ts, toolbar.ts
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
  "mahfouz": ">=0.8.0",
  "apiVersion": 1,
  "icon": "icon.svg",
  "logo": "logo.svg",
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
  "sidecar": { "runtime": "node", "entry": "sidecar.js" },
  "network": { "hosts": ["api.example.com", "*.files.example.com"] },
  "secrets": { "token": { "hosts": ["api.example.com"] } },
  "configFile": "example.md",
  "terms": "terms.md"
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
| `icon` | Optional `.svg` file (≤32 KB), shown as the plugin's toolbar/menu icon. Monochrome and stroke-based: its root element needs `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"` and a `0 0 24 24` viewBox. The app uses its shape as a mask and tints it with the current text color, so any fill or stroke color in the file itself is ignored. |
| `logo` | Optional `.svg` file (≤32 KB), shown next to the plugin in **Settings**. Unlike `icon`, it may be colored — it's drawn as-is, not masked. |
| `dependencies` | Qualified ids installed first. A dependency from a registry the user hasn't added blocks the install. |
| `install` | Steps run in order inside the plugin's installed directory. |
| `install[].type: "npm"` | Runs `npm ci` in `dir` (default `.`). Needs a committed `package-lock.json`. Runs with the plugin's own Node.js when `node` names one for the user's platform, otherwise needs Node.js on the user's machine. `"progress": "npm-fetch"` shows a percentage by counting npm's package downloads against the lockfile. |
| `install[].type: "download"` | Fetches the artifact for the user's platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`, `windows-arm64`), or the `"any"` one for platform-independent files. A **sha256 mismatch aborts the install**. `extract` is `tar.gz`, `zip`, or `none` (the default; with `none`, `to` is the saved file's path). `include` optionally limits unpacking to those archive paths (a directory unpacks its contents). An artifact can set its own `extract` to override the step's for that platform (e.g. a `.zip` for Windows next to `.tar.gz` elsewhere; needs `"mahfouz": ">=0.9.0"`). A platform with no artifact and no `"any"` shows "Not available on this platform". |
| `gitPath` | Directories put on `PATH` for every git command Mahfouz runs (e.g. a `git-lfs` binary). |
| `node` | A Node.js binary the plugin ships, per platform: `{ "<platform>": "<path to the node binary>" }` (`…/bin/node`, or `…/node.exe` on Windows), produced by a `download` step that has an artifact for each platform listed. On a listed platform, `npm` steps run with the `npm` bundled beside that binary and a `node` sidecar runs with it, so the user needs no Node.js of their own; elsewhere both fall back to the user's Node. Needs `"mahfouz": ">=0.9.0"`. |
| `frontend` | ES module the app imports. It must export `activate(host)` and may export `deactivate()`. **Ship a single bundled file**: relative imports aren't refreshed on update until the app restarts. |
| `network` | `{ "hosts": [...] }`: the only hosts `host.http.request` (and the app's downloads for an importer's attachments) may reach, over https. Each is an exact lowercase DNS name with at least two labels (`api.notion.com`), or `*.` followed by one (`*.notion.so`: any subdomain, never `notion.so` itself). No scheme, port, path, IP address, bare `*` or `*.<tld>`. Without it the plugin has no network access through the host. Needs `"mahfouz": ">=0.12.0"`. |
| `secrets` | `{ "<name>": { "hosts": [...] } }`: session secrets the user pastes into the app (an importer's `credential.secretName`), each bound to the hosts it may be sent to. Every host must also be in `network.hosts`; names follow the id rules. The app attaches the secret as a bearer token only to those hosts and never hands it to the plugin. Needs `"mahfouz": ">=0.12.0"`. |
| `sidecar` | Background process. `{ "runtime": "node", "entry": "sidecar.js" }` runs it with the plugin's `node` for the user's platform, or the user's Node when there isn't one. `{ "runtime": "native", "entry": { "<platform>": "bin/tool" } }` runs a binary your `download` step produced. |
| `configFile` | The one file under the vault's `.config/` the plugin may read and write through the host (`encryption.md` → `.config/encryption.md`): a lowercase name of letters, digits and dashes ending in `.md`. Needs `"mahfouz": ">=0.12.0"`. |
| `terms` | A Markdown file in the plugin the user has to accept before installing or enabling it: what the plugin can't do or protect, in plain words. The app shows it in its install and enable dialogs, and the plugin may show the same file in its own dialogs by reading `plugin.json`'s `terms` next to its module. `## ` headings, `- ` bullets and paragraphs only. Needs `"mahfouz": ">=0.12.0"`. |

Checksums live in this repo's git history, so a release asset swapped after the fact can't be
installed silently. Pin artifacts to immutable URLs (release assets, not `latest`).

`icon` and `logo` are plain files: the app never inlines their markup. They're only ever used as
a data URL — an `<img src>` for `logo`, a CSS mask for `icon` — so nothing in either file runs.
A manifest that sets either needs `"mahfouz": ">=0.8.0"`, the first release that reads them —
apps before 0.8.0 reject the unknown field outright and show the plugin as broken (see "Unknown
fields are rejected" above), rather than ignoring it and simply not showing the icon.

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
inserts your snippet. An optional `edit({ ordinal, note })` takes over the block's edit button
(which otherwise reveals the raw source) for an embed edited somewhere else, like draw.io's
editor tab; apps before it existed ignore it.

### Tabs

A plugin can open tabs with `host.registerTabType({ id, icon, render(container, ctx) })` and
`host.openTab(type, note, arg)`. Every plugin tab shows one note. The app draws the toolbar
(icon, note title, Close), keeps the tab in its tab strip, and closes it if the note is
deleted. `render` fills the area below; the function it returns runs when the tab unmounts,
including on a tab switch, so flush unsaved work there. `ctx` has `note`, your `arg`,
`readBody()`, `writeBody(body)` (the app's normal save path) and `close()`. `openTab` saves
the note's pending edits first, so `readBody()` sees them.

`writeBody` merges with changes made to the note outside the tab since the tab's base (its last
`readBody` or its last write, whichever came later), and resolves with the body actually
written, which holds those outside changes too. It rejects, writing nothing, when the note
changed in the same place outside the tab (`err.name === "NoteChangedError"`), when the note
has edits waiting for the user's choice (`"NoteKeptError"`), when it's an encrypted note
(`"EncryptedNoteReadOnlyError"`), or when the note or its file no longer exists. Match on
`err.name`, not `instanceof` (a plugin's copy of the classes isn't the app's), show the error's
message, which says what to do, and keep the user's edit so they can save again. Apps before
this contract resolve with `undefined` after overwriting the note. `ctx.theme` is the app's current
`"light"` or `"dark"`, and `ctx.onThemeChange(fn)` calls `fn` when it changes and returns an
unsubscribe. A toolbar button with `menu: [{ label, onSelect }]` is a dropdown and needs no
`onClick`.

### Toolbar

`host.registerToolbarItem(item)` adds a button, toggle or dropdown to the editor toolbar, acting
on the selected note:

- `{ kind: "button", id, label, icon?, shortcut?, when?(note), run(note) }`
- `{ kind: "toggle", id, label, icon?, shortcut?, when?(note), isActive(note), onChange(fn): Disposable, toggle(note) }` —
  `onChange` should call `fn` whenever `isActive` may have changed, so the app can re-render it.
- `{ kind: "dropdown", id, label, icon?, shortcut?, when?(note), options(note) }`, where each
  option is `{ id, label, icon?, run(note) }`. `options` is recomputed every time the menu opens.

`icon` is inline SVG markup (24×24 viewBox, stroke-based) rendered the same way as
`PluginCommand.icon`; omit it to fall back to the plugin's manifest `icon`. `when(note)` hides the
item for notes it doesn't apply to. `shortcut` is only the default binding (e.g. `Mod+Shift+D`):
users rebind or disable it in `.config/settings.md` under `## Shortcuts`, row
`<registry>/<plugin>:<item id>` — the same row format a command uses, because toolbar item ids and
command ids **share one namespace per plugin**: registering an item with an id a command (or
another item) already holds throws. Only plugins the vault has **enabled** contribute toolbar
items; a plugin loaded solely as another one's dependency contributes none. A button/toggle/option
`run` that throws or rejects is toasted every time it happens; a `when`, `isActive` or `options`
that throws is toasted only once per item.

`host.editor.insertEmbed(language)` inserts one of this plugin's registered embeds at the cursor,
exactly like picking it from the toolbar's Embed menu (including firing its `onInsertedAt`). It
only works for embeds this plugin itself registered, and returns `false` with no effect when no
note editor is open.

### Commands, overlays, export formats, and other plugins

- `host.registerCommand({ id, label, icon?, noteMenu?, shortcut?, when?, palette?, run(note) })`
  adds a command to note menus (`noteMenu`), the command palette (unless `palette: false`) and/or a
  keyboard shortcut. `when(note)` hides it from the menu and the palette, and keeps its shortcut
  from running, for a note it doesn't apply to; it gets the same `CommandNote` as `run`, which for
  an encrypted note also carries `encryptedGroup` and `unlocked`. Keep it cheap and synchronous.
  `shortcut` is only the default: users rebind or disable it in `.config/settings.md` under
  `## Shortcuts`, row `<registry>/<plugin>:<command id>`. `when` and `palette` need Mahfouz 0.12.0;
  older apps show every command for every note.
- `host.registerCommand({ id, label, scope: "vault", when?(vault), palette?, shortcut?, run(vault) })`
  adds a vault command: it gets the open vault (`{ vaultId, name, path, locked }`) instead of a
  note, and the palette lists it (and its shortcut runs) whenever a vault is open, with no note
  too, such as a vault git-crypt keeps locked (`locked`), which shows none. `when(vault)` hides it
  for a vault it doesn't apply to; it's never in note menus. Vault commands need Mahfouz 0.12.0:
  declare `"mahfouz": ">=0.12.0"` (an older app runs one as a note command). A `scope` the app
  doesn't know skips that command, with a console warning. One command holds a key: a later
  command bound to the same keys gets none, even where the first can't run.
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
- A plugin tab's `ctx.setToolbar(buttons)` puts buttons in the app's toolbar — each
  `ToolbarButton` may set `icon` (same inline-SVG convention as `registerToolbarItem`'s `icon`,
  above); `host.ui.openExternal(url)` opens an http(s) URL in the browser.
- Optional members, absent in older apps, so feature-detect each (`if (host.ui.createCodeEditor)`)
  and keep a fallback:
  - `host.markdown.fencedBlocks(body, lang)` finds a note's fenced blocks the way the editor does;
    `host.markdown.replaceFencedBlock(body, lang, index, source)` swaps one block's content.
  - `host.ui.createCodeEditor(container, { value, onChange, language, readOnly })` mounts a source
    editor and returns `{ getValue, setValue, setReadOnly, setDiagnostics, focus, destroy }`.
  - `host.ui.createPanZoom(container)` gives `{ zoomIn, zoomOut, fit, reset, refresh, dispose }`;
    unlike `attachPanZoom` it survives the content being re-rendered.
  - `host.ui.saveFile({ defaultName, filters?, data })` opens the native save dialog and resolves to
    the path written, or null if cancelled. On the web it downloads the file instead and resolves to
    its name.
  - `ctx.theme`, `ctx.onThemeChange` and a toolbar button's `menu` (see Tabs).
  - From Mahfouz 0.12.0: `host.registerSettingsTab({ id, label, render(container) })` adds a page
    to Settings while the vault has the plugin on, and `host.openSettingsTab(id)` opens it;
    `host.ui.openDialog({ title, render(container) })` opens a dialog with the app's look (Escape
    and a click outside close it; returns `{ close }`), and `host.ui.confirm({ title, body,
    confirmLabel, danger? })` asks the app's yes/no question; `host.plugins.list()` lists the
    installed plugins (`{ id, label, enabled, networked }`).
  - From Mahfouz 0.12.0: `host.vault.unlock()` unlocks the open vault with this plugin's own
    vault unlocker (`host.registerVaultUnlocker`), through the same steps as the locked-vault
    notice's **Unlock** button: once the unlocker resolves, the app reads the vault's git-crypt
    lock again and syncs the vault in full. A command that unlocks the vault should call it
    instead of its own unlock, and fall back to that unlock when it's absent. It rejects with the
    unlocker's error (show it the way you show your own), or when the plugin registered no
    unlocker. Only while the vault has the plugin on; desktop only.
  - After Mahfouz 0.12.0 (absent in 0.12.0 and older): `host.commands.refresh()` says this
    plugin's commands' `when` may answer differently now, because state the app doesn't see
    changed. The note menu, toolbar and palette call `when` each time they open and need nothing;
    the desktop OS menu's Note submenu caches it and evaluates it again for the active note.
    Calls in the same task coalesce, and on the web it does nothing. Call it optional-chained
    (`host.commands?.refresh()`).
  - `host.registerImporter(importer)` and `host.http` (see Importers). Absent before Mahfouz 0.12.0
    and on the web.
  - `host.registerPublishRenderer(languages, publishRender)` draws a fence language to an SVG
    when a note is published, so the page shows the diagram instead of its code.
    `publishRender(lang, source)` resolves to the SVG or null (publish the fence as code). It must
    be a light-theme, self-contained SVG serialized with `XMLSerializer` and with text labels: no
    `<foreignObject>`, script, `on*` attributes, `href` other than `#…`, `url(…)` other than
    `url(#…)`, or `@import`. The publishing service checks it against an allowlist
    (`scripts/svg-allowlist.js` is a copy for tests) and drops one that breaks a rule. Call it
    optional-chained (`host.registerPublishRenderer?.(…)`).
- Plugin UI can use the app's `presentation-*` classes (`presentation-status`,
  `presentation-status-title`, `presentation-spinner`, `presentation-log`, `presentation-cta`,
  `presentation-frame`) to match the app's own panes.

### Importers

`host.registerImporter({ id, label, credential?, options?, prepare(ctx) })` adds a source to the
**Import** dialog. The app owns everything around it: the dialog, the destination, the people
mapping, the attachment downloads and every vault write (one commit, undone on a failure).
`prepare` only reads the source and returns an `ImportPlan` (`host.ts`): pages with Markdown
bodies (no title heading), attributes, children, database columns and structured comments, plus
the attachments, people and warnings. References use the `mahfouz-import:` link scheme —
`[text](mahfouz-import:page/<id>)`, `…:file/<ref>`, `…:person/<id>` — and the app rewrites them
into wikilinks, `/files/…` paths and `@login`s. Never emit one from your source's own text.

- `credential: { label, helpUrl, secretName }` puts a secret field in the dialog. The value goes
  straight to the app's native side and stays in memory until the app quits; the plugin never sees
  it. Name it in a request (`secret: "<secretName>"`) and the app attaches it as a bearer token,
  only to the hosts the manifest's `secrets` lists for it.
- `options: [{ id, label, hint?, default }]` are checkboxes; `ctx.options[id]` has the answers.
- `ctx.http.request({ url, method?, headers?, body?, secret? })` resolves to
  `{ status, headers, body }` for every status (the body parsed when it's JSON). Only the
  manifest's `network` hosts, https only; credential and framing headers (`Authorization`,
  `Cookie`, `Host`, `Proxy-*`, `Content-Length`, …) are refused. `ctx.signal` aborts when the user cancels; `ctx.progress(detail, percent?)` shows
  in the dialog.
- An attachment's `resolve()` returns the request for its bytes and is called right before its
  download, after `prepare` has returned, so it can fetch a fresh signed URL.

Plugins share one webview, so this isn't isolation between plugins: another plugin could *use*
a session secret through `host.http`, but only against the hosts it's bound to, and can never
read it.

API v1 covers embeds (`registerEmbed`, `editor.insertEmbed`), tabs (`registerTabType`, `openTab`),
the toolbar (`registerToolbarItem`), commands, overlays, export formats, notes, `provide`/`use`,
the sidecar (`sidecar.call` and `sidecar.onNotify`), `progress`, `toast`, `isEnabled`, and
`ui.attachPanZoom` / `ui.showError` so embeds look like the app's own.

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
