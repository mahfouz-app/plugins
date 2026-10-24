# Mahfouz plugins

The official plugin registry for [Mahfouz](https://github.com/mahfouz-app/app): one plugin per
directory under `plugins/`, each with its `plugin.json`. `main` is the release (every Mahfouz
install pulls it at launch), and CI's `scripts/check.mjs` guards it. The host API plugins build
on (the `plugin.json` schema, the frontend `api.ts`, the sidecar protocol) is documented in
`README.md`.

## Issues: the Mahfouz Issue Tracker, not GitHub Issues

**Stop using GitHub Issues.** Every bug, follow-up, deferred review finding
and feature idea, for this repo and every other mahfouz-app repo, goes into
the **Issue Tracker** database in the **kb** vault (`mahfouz-app/kb`, cloned
at `/Users/o/Projects/github/mahfouz/kb`). Don't run `gh issue create`,
`list`, `edit` or `close`, or `gh api …/issues`. This overrides any skill
or older note that says to file a GitHub issue. The open GitHub issues were
imported into the tracker on 2026-10-24.

- **Where:** the database note `issue_tracker/issue_tracker.md` (id
  `01a16c9ba1b67962b25a4739f187b5cf`); each issue is a child note in
  `issue_tracker/`. Views: All, Open, Board.
- **Columns:** `status` (`Open`, `In Progress`, `Closed`, `Not planned`),
  `labels` (`bug`, `enhancement`), `opened` and `closed` (dates). `number`
  and `github` are for imported issues only; leave them empty. The title
  carries an area prefix (`Mermaid: …`, `Slidev: …`); the body is the issue,
  self-contained, with acceptance criteria.
- **How:** through the Mahfouz MCP tools (the kb vault's id from
  `list_vaults`): `query_database` with view `Open` to read, `search_notes`
  to check for a duplicate, `add_database_row` to file (status `Open`, a
  label, `opened` today), `set_attributes` to close (status `Closed`, the
  `closed` date). Without the MCP server, edit the kb clone: a row is
  `issue_tracker/<slug>.md` with frontmatter (`id`: 32 random hex
  characters, `status`, `labels`, `opened`) and a `# Title`; pull, commit,
  push.
- **Rules:** one row per finding, never a checklist row; check for a
  duplicate first; cite the row from the PR (`tracked in kb: <title>`); set
  it Closed when the fix merges; don't take a follow-up into the current PR.

The app repo's `.riprap/instructions/issue-tracker.md` has the full rules.
