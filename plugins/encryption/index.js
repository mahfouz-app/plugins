// Encryption for Mahfouz: per-note OpenPGP encryption through the user's gpg.
//
// The work happens in the sidecar (`sidecar/`, built into the `git-crypt`
// binary the install step downloads): `status`, `secretFingerprints`,
// `importPublic` and `encrypt` over the app's sidecar JSON-RPC, and for
// whole-vault encryption `vaultStatus`, `initVault`, `unlockVault`,
// `lockVault`, `addVaultMember` and `removeVaultMember`. `decrypt` is the
// app's alone: the host refuses it from this module, and a note is only ever
// decrypted by the app, through `ctx.decryptNote()` (or, in a merge,
// `ctx.decryptBlob(sha)`) in the body codec and `host.notes.decrypt` for a
// re-encryption or a Decrypt, reading the file or git itself. The
// same binary is git-crypt's filter (`clean`, `smudge`, `diff`); `gitPath`
// puts it on git's PATH.
//
// Where things live:
//
// - `.config/encryption.md` (`host.config`, shared through the vault): one
//   `## <group>` section per group, each a `| login | fingerprint |` table.
//   The app reads it with `groupSigners` (crypto/decrypt.ts), copied below:
//   the fingerprints under a group's heading are the only signers a decrypt
//   accepts, and (with your backup key) the recipients of an encrypt.
// - Your signing and backup keys, and your GitHub login once known: this
//   machine's `localStorage` (`mahfouz.encryption.keys`). They're per user
//   and per machine, so they never go in the vault.
// - Nothing about notes: whether a note is encrypted or unlocked comes from
//   the app with each command (`CommandNote.encryptedGroup`, `unlocked`).
// - Whole-vault encryption: git-crypt's own files in the vault
//   (`.git-crypt/`, the root `.gitattributes` block, both written by the
//   sidecar and committed by the app) and this clone's key in `.git/`. Its
//   members are the fingerprints of `.git-crypt/keys/default/0/`; their
//   logins are read from `.config/encryption.md`'s group rows, never stored
//   apart.
//
// Single file on purpose; see the README's note on frontend modules.

export const CONFIG_PATH = ".config/encryption.md";
export const STORAGE_KEY = "mahfouz.encryption.keys";
export const GUIDE_URL = "https://docs.mahfouz.app/guide/encryption/";
export const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const FPR_RE = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/;
const HEADING_RE = /^##\s+(.+?)\s*#*\s*$/;
const ARMOR_KEY = "-----BEGIN PGP PUBLIC KEY BLOCK-----";

export const NOT_FOUND_TEXT = "Not found? Install GPG Suite, or run brew install gnupg pinentry-mac, then check again.";
export const BACKUP_TEXT = "Notes are encrypted to your backup key too, so losing one key doesn't lose them.";
export const ENCRYPT_TEXT =
  "Only the group's members can read it, on Mahfouz for desktop with their GPG key. Its file name, attributes and earlier versions in history stay readable.";
export const NO_BACKUP_TEXT = "You have no backup key. If you lose your key, you lose this note.";
export const DECRYPT_TEXT =
  "Its text will be stored unencrypted, in the vault and on GitHub, from the next commit. Earlier versions stay encrypted in history.";
export const STOP_SHARING_TEXT =
  "New edits are re-encrypted without their key. They can still read anything they already decrypted or that's in history.";
const NO_SIGNING_KEY = "Choose your signing key in Settings → Encryption.";

export const VAULT_SECTION = "Encrypt this vault on GitHub";
export const VAULT_TEXT = "Notes stay readable on this Mac. On GitHub and in every clone without a key, they're encrypted with git-crypt.";
export const VAULT_DIALOG_TEXT = "Encrypted for you and your backup key. Add members afterwards.";
export const HISTORY_QUESTION = "Your history on GitHub is unencrypted. What happens to it?";
/** The history options, in the dialog's order. */
export const HISTORY_OPTIONS = [
  {
    id: "move",
    label: "Move to a new private repository",
    recommended: true,
    text: "The old one keeps the unencrypted history. Mahfouz doesn't delete repositories.",
  },
  {
    id: "rewrite",
    label: "Rewrite history and force-push",
    text: "Old copies stay reachable on GitHub by commit until GitHub support removes them. Collaborators must clone again.",
  },
  { id: "now", label: "Encrypt from now on", text: "Earlier commits stay unencrypted on GitHub." },
];
export const NAMES_TEXT = "File and folder names and commit messages stay readable on GitHub.";
export const NAMES_BY_ID_TEXT = "New notes will be named by their ID, and commit messages won't name notes.";
export const REMOVE_MEMBER_TEXT =
  "Removing a member stops new access only if the key changes; git-crypt can't rotate it. To shut someone out, move the vault to a fresh repository.";
export const NO_VAULT_KEY_TEXT = "None of your GPG keys can unlock it. Ask a member to add yours:";
export const LFS_TEXT = "This vault stores files with Git LFS, which git-crypt can't encrypt, so it can't be encrypted.";
const VAULT_MESSAGE = "Encrypt vault";

const LOCK_OPEN = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>';
const LOCK_CLOSED = '<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';

// ---- .config/encryption.md -----------------------------------------------------

/** A cell as a fingerprint (spaces and backticks dropped, upper-cased), or null. */
export function normalizeFpr(cell) {
  const fpr = String(cell ?? "").replace(/[`\s]/g, "").toUpperCase();
  return FPR_RE.test(fpr) ? fpr : null;
}

/**
 * The fingerprints listed for `group`: the app's `groupSigners`
 * (src/core/src/crypto/decrypt.ts), copied so encryption and decryption
 * agree on who is in a group. Keep the two identical.
 */
export function groupSigners(md, group) {
  const out = [];
  let inGroup = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = HEADING_RE.exec(line);
    if (heading && !line.startsWith("###")) {
      inGroup = heading[1].replace(/`/g, "") === group;
      continue;
    }
    if (!inGroup || !line.startsWith("|")) continue;
    for (const cell of line.replace(/^\||\|$/g, "").split("|")) {
      const fpr = cell.replace(/[`\s]/g, "").toUpperCase();
      if (FPR_RE.test(fpr) && !out.includes(fpr)) out.push(fpr);
    }
  }
  return out;
}

/**
 * The groups as `groupSigners` reads them, in file order: `{name, heading,
 * end, members: [{login, fpr, line}]}` with 0-based line numbers (`end` is
 * the next `##` heading's line, or the file's end). A member is a table row
 * holding a fingerprint, one per fingerprint; its login is the row's first
 * other non-empty cell's first word, without `@` and backticks. The editors below change
 * only the lines they add or remove.
 */
export function parseConfig(md) {
  const lines = md.split(/\r?\n/);
  const groups = [];
  let current = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const heading = HEADING_RE.exec(line);
    if (heading && !line.startsWith("###")) {
      if (current) current.end = i;
      current = { name: heading[1].replace(/`/g, ""), heading: i, end: lines.length, members: [] };
      groups.push(current);
      return;
    }
    if (!current || !line.startsWith("|")) return;
    const cells = line.replace(/^\||\|$/g, "").split("|");
    const fprs = cells.map(normalizeFpr);
    const loginCell = cells.find((c, j) => !fprs[j] && c.replace(/[`@\s]/g, "") !== "");
    const login = loginCell ? loginCell.replace(/[`@]/g, "").trim().split(/\s+/)[0] : "";
    for (const fpr of fprs) if (fpr) current.members.push({ login, fpr, line: i });
  });
  return { lines, groups };
}

const eolOf = (md) => (md.includes("\r\n") ? "\r\n" : "\n");

/** What a new `.config/encryption.md` starts with. */
export const CONFIG_PREAMBLE =
  "# Encryption\n\nEach group lists the keys that can read its encrypted notes: a GitHub login and the key's full fingerprint. The Encryption plugin keeps this file.\n";

function joinLines(lines, eol) {
  let text = lines.join(eol);
  if (!text.endsWith(eol)) text += eol;
  return text;
}

function memberRow({ login, fpr }) {
  if (!LOGIN_RE.test(login ?? "")) throw new Error(`“${login ?? ""}” isn't a GitHub login.`);
  const f = normalizeFpr(fpr);
  if (!f) throw new Error(`“${fpr}” isn't a full fingerprint.`);
  return `| ${login} | ${f} |`;
}

/** `md` with a `## <group>` section holding `members` appended (the file started when empty). */
export function addGroup(md, group, members) {
  if (!GROUP_RE.test(group)) throw new Error("A group name is letters, digits, - and _, starting with a letter or digit.");
  if (parseConfig(md).groups.some((g) => g.name === group)) throw new Error(`There's already a group named “${group}”.`);
  const eol = eolOf(md);
  const base = md.trim() === "" ? CONFIG_PREAMBLE : md;
  const lines = base.replace(/(\r?\n)+$/, "").split(/\r?\n/);
  lines.push("", `## ${group}`, "", "| login | fingerprint |", "|---|---|");
  const seen = new Set();
  for (const m of members) {
    const fpr = normalizeFpr(m.fpr);
    if (fpr && seen.has(fpr)) continue;
    lines.push(memberRow(m));
    seen.add(fpr);
  }
  return joinLines(lines, eol);
}

/** `md` with `member` added to `group`'s table (the group created when it's missing); unchanged when the key is already listed there. */
export function addMember(md, group, member) {
  const { lines, groups } = parseConfig(md);
  const g = groups.find((x) => x.name === group);
  if (!g) return addGroup(md, group, [member]);
  const row = memberRow(member);
  if (g.members.some((m) => m.fpr === normalizeFpr(member.fpr))) return md;
  let lastRow = -1;
  for (let i = g.heading + 1; i < g.end; i++) if (lines[i].trim().startsWith("|")) lastRow = i;
  if (lastRow >= 0) lines.splice(lastRow + 1, 0, row);
  else lines.splice(g.heading + 1, 0, "", "| login | fingerprint |", "|---|---|", row);
  return joinLines(lines, eolOf(md));
}

/** `md` without `login`'s rows in `group` (compared ignoring case); unchanged when there are none. */
export function removeMember(md, group, login) {
  const { lines, groups } = parseConfig(md);
  const g = groups.find((x) => x.name === group);
  const drop = new Set((g?.members ?? []).filter((m) => m.login.toLowerCase() === login.toLowerCase()).map((m) => m.line));
  if (drop.size === 0) return md;
  return joinLines(
    lines.filter((_, i) => !drop.has(i)),
    eolOf(md)
  );
}

/** The recipients of a group's note: its listed keys plus your backup key, once each. */
export function computeRecipients(groupFprs, backup) {
  const out = [];
  for (const f of [...groupFprs, backup]) {
    const fpr = normalizeFpr(f);
    if (fpr && !out.includes(fpr)) out.push(fpr);
  }
  return out;
}

/** The group "Only me" encrypts for. */
export const onlyMeGroup = (login) => `only-${login}`;

/** Your login: the stored one, else the login listed beside one of your keys. */
export function selfLogin(md, ownFprs, stored) {
  if (stored && LOGIN_RE.test(stored)) return stored;
  const own = new Set(ownFprs.map(normalizeFpr).filter(Boolean));
  for (const g of parseConfig(md).groups) {
    for (const m of g.members) if (own.has(m.fpr) && LOGIN_RE.test(m.login)) return m.login;
  }
  return null;
}

// ---- small helpers ------------------------------------------------------------------

/** A fingerprint in groups of four. */
export const formatFpr = (fpr) => fpr.replace(/(.{4})(?=.)/g, "$1 ");
/** The last 16 digits, as people quote a key id. */
export const shortFpr = (fpr) => formatFpr(fpr.slice(-16));

/** The name part of a user id (`Ada Lovelace (work) <ada@example.com>` → `Ada Lovelace`), or "". */
export function uidName(uid) {
  return String(uid ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A sidecar error's stable code (`unknownRecipient`, …), or "". */
export function errorCode(err) {
  const code = err?.data?.code ?? err?.code;
  if (typeof code === "string") return code;
  const m = /^([a-zA-Z]+):/.exec(String(err?.message ?? ""));
  return m ? m[1] : "";
}

/** The disk-only notes' paths `commitFiles` left out (`{committed, skipped}`; an older app resolved a boolean). */
export function skippedOf(result) {
  return Array.isArray(result?.skipped) ? result.skipped.filter((p) => typeof p === "string") : [];
}

/** What a commit that left disk-only notes out says. */
export function skippedText(n) {
  return n === 1 ? "1 note wasn't committed: it's disk-only on this Mac." : `${n} notes weren't committed: they're disk-only on this Mac.`;
}

/** The last component of a vault's path, as its name. */
export const vaultName = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop() || "vault";

export const usableForSigning = (k) => !!k.canSign && !k.expired && !k.revoked;
export const usableForEncryption = (k) => !!k.canEncrypt && !k.expired && !k.revoked;
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/** Your keys on this machine: `{signing, backup, login}`, each possibly null. */
export function loadKeys(storage) {
  try {
    const v = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    return {
      signing: normalizeFpr(v?.signing),
      backup: normalizeFpr(v?.backup),
      login: typeof v?.login === "string" && LOGIN_RE.test(v.login) ? v.login : null,
    };
  } catch {
    return { signing: null, backup: null, login: null };
  }
}

export function saveKeys(storage, keys) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ signing: keys.signing ?? null, backup: keys.backup ?? null, login: keys.login ?? null }));
  } catch {
    // Storage unavailable: the choice lasts this session only.
  }
}

// ---- the controller: everything that isn't DOM ---------------------------------------

/**
 * The plugin's logic over `host` and `storage`, testable without a DOM.
 * `onChange` listeners hear when this plugin encrypted or decrypted a note,
 * or read the vault's state (the toolbar's toggles re-render on it).
 */
export function createController(host, storage) {
  const listeners = new Set();
  const changed = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  };

  const readConfig = async () => (host.config ? ((await host.config.read()) ?? "") : "");

  /** `host.vault.commitFiles`, telling the user about the disk-only notes it left out. Resolves with those paths. */
  async function commit(paths, message) {
    const skipped = skippedOf(await host.vault?.commitFiles(paths, message));
    if (skipped.length > 0) host.toast(skippedText(skipped.length), "info");
    return skipped;
  }

  async function fetchGithubKeys(login) {
    if (!LOGIN_RE.test(login)) throw new Error(`“${login}” isn't a GitHub login.`);
    if (!host.http) throw new Error("This version of Mahfouz can't reach GitHub from plugins.");
    const res = await host.http.request({ url: `https://github.com/${login}.gpg` });
    if (res.status === 404) throw new Error(`GitHub has no user @${login}.`);
    if (res.status !== 200) throw new Error(`GitHub answered ${res.status} for @${login}'s keys.`);
    const text = typeof res.body === "string" ? res.body : "";
    if (!text.includes(ARMOR_KEY)) throw new Error(`@${login} has no GPG keys on GitHub.`);
    return text;
  }

  /** Imports each listed login's keys from GitHub into the plugin keyring; a login that fails is skipped. */
  async function importGroupKeys(md, group, skip) {
    const g = parseConfig(md).groups.find((x) => x.name === group);
    const logins = [...new Set((g?.members ?? []).map((m) => m.login))].filter((l) => LOGIN_RE.test(l) && l !== skip);
    for (const login of logins) {
      try {
        await host.sidecar.call("importPublic", { armored: await fetchGithubKeys(login) });
      } catch (err) {
        console.warn(`couldn't import @${login}'s keys`, err);
      }
    }
  }

  /**
   * The sidecar's encrypt. A recipient's key that isn't in the plugin
   * keyring yet (someone else added them) is fetched from GitHub once and
   * the encrypt retried: the fingerprint is pinned by the config, so a key
   * GitHub swapped would still not be found.
   */
  async function encryptTo(plaintext, recipients, signer, md, group) {
    const call = async () => (await host.sidecar.call("encrypt", { plaintext, recipients, signer })).armored;
    try {
      return await call();
    } catch (err) {
      if (errorCode(err) !== "unknownRecipient") throw err;
      await importGroupKeys(md, group, loadKeys(storage).login);
      return call();
    }
  }

  /** `plaintext` encrypted for `group` as `md` lists it, plus your backup key, signed with your signing key. */
  async function encryptFor(group, plaintext, md) {
    const keys = loadKeys(storage);
    if (!keys.signing) throw new Error(NO_SIGNING_KEY);
    const signers = groupSigners(md, group);
    if (signers.length === 0) throw new Error(`The “${group}” group has no keys in ${CONFIG_PATH}.`);
    // Signed by a key the group doesn't list, the note couldn't be read by anyone, you included.
    if (!signers.includes(keys.signing)) throw new Error(`Your signing key isn't in the “${group}” group.`);
    return encryptTo(plaintext, computeRecipients(signers, keys.backup), keys.signing, md, group);
  }

  const codec = {
    id: "gpg",
    matches: (fm) => typeof fm.encrypted === "string",
    // An Unlock's decode gets decryptNote (the file); a merge's base, ours or theirs gets decryptBlob (that commit's version).
    // The host keeps the sidecar's decrypt from plugins, so neither hands ciphertext over.
    decode(ctx) {
      return typeof ctx.decryptNote === "function" ? ctx.decryptNote() : ctx.decryptBlob(ctx.sha);
    },
    async encode(ctx, plaintext) {
      return encryptFor(ctx.group, plaintext, await readConfig());
    },
  };

  /** A note this plugin can encrypt: not encrypted, as the app says (`CommandNote.encryptedGroup`). */
  const isPlain = (note) => !note?.encryptedGroup && typeof host.notes.setEncryption === "function";
  /** An encrypted note unlocked this session (`CommandNote.unlocked`), so Decrypt applies. */
  const isUnlocked = (note) =>
    !!note?.encryptedGroup && note.unlocked === true && typeof host.notes.setEncryption === "function" && typeof host.notes.decrypt === "function";

  /** Your secret keys, your stored keys and login, and the config. */
  async function context() {
    const [md, secret] = await Promise.all([readConfig(), host.sidecar.call("secretFingerprints", {})]);
    const keys = loadKeys(storage);
    const own = [...new Set([...secret.map((k) => k.fpr), keys.signing, keys.backup].map(normalizeFpr).filter(Boolean))];
    const login = selfLogin(md, own, keys.login);
    if (login && login !== keys.login) saveKeys(storage, { ...keys, login });
    return { md, secret, keys: { ...keys, login }, own };
  }

  /** The groups you can encrypt for (they list one of your keys), "Only me" apart. */
  function yourGroups(md, own, login) {
    const mine = new Set(own);
    return parseConfig(md)
      .groups.filter((g) => GROUP_RE.test(g.name) && g.members.some((m) => mine.has(m.fpr)))
      .map((g) => g.name)
      .filter((name, i, all) => all.indexOf(name) === i && (!login || name !== onlyMeGroup(login)));
  }

  /** Your rows in a group you create: your signing key and your backup key, so others' edits stay readable by your backup too. */
  const selfMembers = (keys, login) => [keys.signing, keys.backup].filter(Boolean).map((fpr) => ({ login, fpr }));

  /** The note's info, refused when it's already encrypted. */
  async function plainNote(note) {
    const info = await host.notes.get(note);
    if (typeof info.attributes?.encrypted === "string") throw new Error(`“${info.title}” is already encrypted.`);
    return info;
  }

  /**
   * Encrypts `note` for `choice`: `{group}`, or `{onlyMe: true, login}`,
   * which creates your `only-<login>` group first when it's missing (written
   * only once the note is encrypted).
   */
  async function encryptNote(note, choice) {
    const keys = loadKeys(storage);
    if (!keys.signing) throw new Error(NO_SIGNING_KEY);
    let md = await readConfig();
    let group = choice.group;
    let configChanged = false;
    if (choice.onlyMe) {
      if (!LOGIN_RE.test(choice.login ?? "")) throw new Error(`“${choice.login ?? ""}” isn't a GitHub login.`);
      if (choice.login !== keys.login) saveKeys(storage, { ...keys, login: choice.login });
      group = onlyMeGroup(choice.login);
      if (!parseConfig(md).groups.some((g) => g.name === group)) {
        md = addGroup(md, group, selfMembers(keys, choice.login));
        configChanged = true;
      }
    }
    const info = await plainNote(note);
    const armored = await encryptFor(group, info.body, md);
    if (configChanged) await host.config.write(md);
    await host.notes.setEncryption(note, { group, armored, expected: info.body });
    changed();
    return group;
  }

  /** The note Decrypt asks about, refused when it isn't encrypted. */
  async function encryptedNote(note) {
    const info = await host.notes.get(note);
    if (typeof info.attributes?.encrypted !== "string") throw new Error(`“${info.title}” isn't encrypted.`);
    return info;
  }

  /**
   * Decrypts `note` for good: the app decrypts its file (`notes.decrypt`),
   * and the plaintext is written only while the file still holds the
   * armored body it came from.
   */
  async function decryptNote(note) {
    const { plaintext, armored } = await host.notes.decrypt(note);
    await host.notes.setEncryption(note, { plaintext, expected: armored });
    changed();
  }

  /** Whether this app can list, decrypt and rewrite a group's notes, which Add member needs. */
  const canReencrypt = () =>
    typeof host.notes.listEncrypted === "function" && typeof host.notes.decrypt === "function" && typeof host.notes.writeBody === "function";

  /** The group's notes, from the app's index. */
  const groupNotes = (group) => host.notes.listEncrypted(group);

  /** `login`'s keys from GitHub, imported into the plugin keyring: those that can be encrypted to. */
  async function lookUpMember(login) {
    const imported = await host.sidecar.call("importPublic", { armored: await fetchGithubKeys(login) });
    const usable = (imported ?? []).filter(usableForEncryption);
    if (usable.length === 0) throw new Error(`None of @${login}'s keys on GitHub can be encrypted to.`);
    return usable;
  }

  /**
   * Adds `member` (`{login, fpr}`) to `group`: re-encrypts each of the
   * group's notes to the new recipients (decrypted by the app from its
   * file, written back only while the file still holds what was decrypted),
   * then writes the config and commits the notes and the config in one
   * commit. A failure stops before the config is written; the notes already
   * re-encrypted stay readable by the group, and adding again finishes.
   */
  async function addMemberAndReencrypt(group, member) {
    const notes = await groupNotes(group);
    const keys = loadKeys(storage);
    if (!keys.signing) throw new Error(NO_SIGNING_KEY);
    const md = await readConfig();
    const next = addMember(md, group, member);
    const signers = groupSigners(next, group);
    if (!signers.includes(keys.signing)) throw new Error(`Your signing key isn't in the “${group}” group.`);
    const recipients = computeRecipients(signers, keys.backup);
    const paths = [];
    try {
      for (const [i, note] of notes.entries()) {
        host.progress(`Re-encrypting notes for “${group}”`, Math.round((i / notes.length) * 100));
        const info = await host.notes.get(note);
        const { plaintext, armored } = await host.notes.decrypt(note);
        const out = await encryptTo(plaintext, recipients, keys.signing, next, group);
        await host.notes.writeBody(note, out, armored);
        paths.push(info.path);
      }
    } finally {
      host.progress("");
    }
    if (next !== md) await host.config.write(next);
    await commit([...paths, CONFIG_PATH], `Add @${member.login} to ${group}`);
    changed();
    return paths.length;
  }

  /** Takes `login` out of `group` and commits the config. Nothing is re-encrypted now: new edits leave their key out. */
  async function stopSharing(group, login) {
    const md = await readConfig();
    const next = removeMember(md, group, login);
    if (next === md) return false;
    await host.config.write(next);
    await commit([CONFIG_PATH], `Stop sharing ${group} with @${login}`);
    changed();
    return true;
  }

  /** A new group listing you, committed. */
  async function newGroup(name, login) {
    const keys = loadKeys(storage);
    if (!keys.signing) throw new Error(NO_SIGNING_KEY);
    if (!LOGIN_RE.test(login ?? "")) throw new Error(`“${login ?? ""}” isn't a GitHub login.`);
    if (login !== keys.login) saveKeys(storage, { ...keys, login });
    const next = addGroup(await readConfig(), name, selfMembers(keys, login));
    await host.config.write(next);
    await commit([CONFIG_PATH], `Add encryption group ${name}`);
    changed();
  }

  /** The labels of the other enabled plugins that may reach the network, or null when this app can't say (`plugins.list`). */
  async function networkedPlugins() {
    if (!host.plugins?.list) return null;
    const all = await host.plugins.list();
    return all.filter((p) => p.enabled && p.networked && p.id !== host.plugin.id).map((p) => p.label || p.id);
  }

  function forgetAll() {
    vaultState = null;
    changed();
  }

  // ---- whole-vault encryption ----

  let vaultState = null; // the open vault's last vaultStatus, for `when`

  function vaultPath() {
    const path = host.vault?.current()?.path;
    if (!path) throw new Error("Open a vault first.");
    return path;
  }

  /** The open vault's `vaultStatus` (`{encrypted, unlocked, members, usesLfs, hasRemote}`), remembered for `isVaultLocked`. */
  async function vaultStatus() {
    vaultState = await host.sidecar.call("vaultStatus", { vault: vaultPath() });
    changed();
    return vaultState;
  }

  /** The vault is encrypted and locked on this machine, as last read. */
  const isVaultLocked = () => !!vaultState?.encrypted && !vaultState.unlocked;

  /**
   * What this app lets the vault section and the Encrypt dialog do; what it
   * can't is left out of them. Encrypting, locking and unlocking need
   * `git.renormalize` and `git.forceCheckout`; moving to a new repository
   * needs `repo.moveToNewPrivate` and rewriting `git.rewriteHistory` (both
   * ask the user themselves, then push); naming new notes by id and keeping
   * notes out of commit messages need `settings.setNewNoteNaming` and
   * `settings.setCommitMessageNaming`; renaming the existing notes needs
   * `notes.renameAllById` (with `notes.countRenamableById`).
   */
  function vaultFeatures() {
    const fn = (f) => typeof f === "function";
    return {
      encrypt: fn(host.git?.renormalize),
      lock: fn(host.git?.renormalize) && fn(host.git?.forceCheckout),
      unlock: fn(host.git?.forceCheckout),
      move: fn(host.repo?.moveToNewPrivate),
      rewrite: fn(host.git?.rewriteHistory),
      now: true,
      nameById: fn(host.settings?.setNewNoteNaming) && fn(host.settings?.setCommitMessageNaming),
      renameExisting: fn(host.notes?.renameAllById) && fn(host.notes?.countRenamableById),
    };
  }

  /** The vault's members, `{fpr, login, you}`: logins from `.config/encryption.md` rows with that fingerprint, else "". */
  function vaultMembers(md, members, own) {
    const rows = parseConfig(md).groups.flatMap((g) => g.members);
    const mine = new Set(own);
    return (members ?? []).map((f) => {
      const fpr = normalizeFpr(f) ?? String(f);
      const login = rows.find((m) => m.fpr === fpr && LOGIN_RE.test(m.login))?.login ?? "";
      return { fpr, login, you: mine.has(fpr) };
    });
  }

  /**
   * Encrypts the open vault with git-crypt for your signing and backup
   * keys. `history` is `now`, `move` or `rewrite`, and `renameExisting`
   * renames the existing notes by id first: each only where `vaultFeatures`
   * says the app can (the dialog offers nothing else). Order: a renormalize
   * commits what's pending and refuses an edited file before anything
   * changes; the sidecar writes the key, `.git-crypt/` and the root
   * `.gitattributes` block; a renormalize commits them with every file
   * encrypted; then the naming settings and the history option, whose
   * confirm and push are the app's.
   */
  async function encryptVault({ history = "now", renameExisting = false } = {}) {
    const keys = loadKeys(storage);
    if (!keys.signing) throw new Error(NO_SIGNING_KEY);
    const features = vaultFeatures();
    const vault = vaultPath();
    const st = await vaultStatus();
    if (st.usesLfs) throw new Error(LFS_TEXT);
    if (st.encrypted) throw new Error("This vault is already encrypted.");
    // Commits what's pending, and refuses (with nothing changed yet) while a tracked file holds an edit.
    await host.git.renormalize("Commit before encrypting the vault");
    const members = [keys.signing, keys.backup].filter(Boolean);
    const init = await host.sidecar.call("initVault", { vault, members: [...new Set(members)] });
    // The app's renormalize stages `.gitattributes` and `.git-crypt/` itself, then every file cleaned afresh.
    await host.git.renormalize(VAULT_MESSAGE);
    await vaultStatus();
    if (features.nameById) {
      await host.settings.setNewNoteNaming("id");
      await host.settings.setCommitMessageNaming("none");
    }
    if (renameExisting) await host.notes.renameAllById();
    if (history === "move") await host.repo.moveToNewPrivate(`${vaultName(vault)}-encrypted`);
    else if (history === "rewrite") await host.git.rewriteHistory(VAULT_MESSAGE);
    return init;
  }

  /** Unlocks the open vault with one of your keys, then checks its files out again as plaintext. */
  async function unlockVault() {
    try {
      await host.sidecar.call("unlockVault", { vault: vaultPath() });
    } catch (err) {
      if (errorCode(err) !== "noMemberKey") throw err;
      const keys = loadKeys(storage);
      const fpr = keys.signing ?? keys.backup ?? (await host.sidecar.call("secretFingerprints", {})).find(usableForEncryption)?.fpr ?? null;
      const e = new Error(fpr ? `${NO_VAULT_KEY_TEXT} ${formatFpr(fpr)}` : NO_VAULT_KEY_TEXT.replace(/ Ask.*$/, ""));
      e.code = "noMemberKey";
      e.fpr = fpr;
      throw e;
    }
    try {
      return await host.git.forceCheckout();
    } finally {
      await vaultStatus().catch(() => {});
    }
  }

  /**
   * Locks the open vault: a renormalize commits what's pending and refuses
   * while a tracked file holds an edit (the sidecar's lock refuses anything
   * else uncommitted), then the key and filters go and the files are
   * checked out again as ciphertext.
   */
  async function lockVault() {
    const vault = vaultPath();
    await host.git.renormalize("Commit before locking the vault");
    await host.sidecar.call("lockVault", { vault });
    forgetAll();
    try {
      return await host.git.forceCheckout();
    } finally {
      await vaultStatus().catch(() => {});
    }
  }

  /** Adds `member` (`{login, fpr}`) to the vault and commits the member file. */
  async function addVaultMember(member) {
    const { paths } = await host.sidecar.call("addVaultMember", { vault: vaultPath(), fpr: member.fpr });
    if (paths.length > 0) await commit(paths, `Add @${member.login} to the vault's keys`);
    await vaultStatus();
    return paths;
  }

  /** Removes `fpr` from the vault and commits the deletion. The key isn't rotated. */
  async function removeVaultMember(fpr, login) {
    const { paths } = await host.sidecar.call("removeVaultMember", { vault: vaultPath(), fpr });
    if (paths.length > 0) await commit(paths, `Remove ${login ? `@${login}` : shortFpr(fpr)} from the vault's keys`);
    await vaultStatus();
    return paths;
  }

  return {
    codec,
    isPlain,
    isUnlocked,
    context,
    yourGroups,
    plainNote,
    encryptNote,
    encryptedNote,
    decryptNote,
    canReencrypt,
    groupNotes,
    lookUpMember,
    addMemberAndReencrypt,
    stopSharing,
    newGroup,
    networkedPlugins,
    forgetAll,
    vaultStatus,
    isVaultLocked,
    vaultFeatures,
    vaultMembers,
    encryptVault,
    unlockVault,
    lockVault,
    addVaultMember,
    removeVaultMember,
    onChange(fn) {
      listeners.add(fn);
      return { dispose: () => void listeners.delete(fn) };
    },
  };
}

// ---- DOM ------------------------------------------------------------------------------
//
// Dialogs are the app's (`host.ui.openDialog`, `host.ui.confirm`) and the
// settings page is a Settings tab (`host.registerSettingsTab`); what goes
// inside them uses the app's own classes (`.dialog-row`, `.btn`,
// `.section-title`, `.text-caption`; ui-components.md).

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "className") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "checked" || k === "disabled" || k === "value" || k === "selected") node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

/** The app's dialog titled `title`; `build(container, close)` draws the rest. Escape and a click outside close it. */
function openDialog(host, title, build) {
  let handle = null;
  let closed = false;
  const close = () => {
    closed = true;
    handle?.close();
  };
  handle = host.ui.openDialog({
    title,
    render(container) {
      build(container, close);
      container.querySelector("input, select, .dialog-submit")?.focus();
    },
  });
  if (closed) handle.close();
  return close;
}

function errorLine() {
  const node = h("div", { className: "dialog-error", role: "alert" });
  node.hidden = true;
  return {
    node,
    show(err) {
      node.textContent = err ? messageOf(err) : "";
      node.hidden = !err;
    },
  };
}

function keyLabel(key) {
  const name = uidName(key.uids?.[0]);
  return name ? `${name} · ${shortFpr(key.fpr)}` : shortFpr(key.fpr);
}

const actions = (close, submit) =>
  h("div", { className: "dialog-actions" }, h("button", { type: "button", className: "dialog-cancel", onClick: close }, "Cancel"), submit);

/** The Encrypt dialog for `note`. */
async function openEncryptDialog(c, host, note) {
  const info = await c.plainNote(note);
  const { md, keys, own } = await c.context();
  const groups = c.yourGroups(md, own, keys.login);
  const title = `Encrypt “${info.title}”`;
  openDialog(host, title, (card, close) => {
    const select = h(
      "select",
      { className: "dialog-select", id: "enc-group" },
      h("option", { value: "" }, "Only me"),
      groups.map((g) => h("option", { value: g }, g))
    );
    const login = h("input", { className: "dialog-input", id: "enc-login", autocomplete: "off", spellcheck: "false" });
    const loginRow = h("div", { className: "dialog-row" }, h("label", { className: "dialog-label", for: "enc-login" }, "Your GitHub login"), login);
    const sync = () => (loginRow.hidden = !(select.value === "" && !keys.login));
    select.addEventListener("change", sync);
    const error = errorLine();
    const submit = h("button", { type: "submit", className: "dialog-submit", disabled: !keys.signing }, "Encrypt");
    card.append(
      h(
        "form",
        {
          onSubmit: async (e) => {
            e.preventDefault();
            submit.disabled = true;
            error.show(null);
            try {
              const choice =
                select.value === "" ? { onlyMe: true, login: keys.login ?? login.value.trim().replace(/^@/, "") } : { group: select.value };
              await c.encryptNote(note, choice);
              close();
            } catch (err) {
              error.show(err);
              submit.disabled = false;
            }
          },
        },
        h("div", { className: "dialog-row" }, h("label", { className: "dialog-label", for: "enc-group" }, "Group"), select),
        loginRow,
        h("p", { className: "dialog-hint" }, ENCRYPT_TEXT),
        keys.signing ? null : h("p", { className: "dialog-error" }, NO_SIGNING_KEY),
        keys.backup ? null : h("p", { className: "dialog-error" }, NO_BACKUP_TEXT),
        error.node,
        actions(close, submit)
      )
    );
    sync();
  });
}

/** Decrypt: the app's question first, then the app decrypts the file and the plaintext is written. */
async function runDecrypt(c, host, note) {
  const info = await c.encryptedNote(note);
  const ok = await host.ui.confirm({ title: `Decrypt “${info.title}”?`, body: DECRYPT_TEXT, confirmLabel: "Decrypt", danger: true });
  if (ok) await c.decryptNote(note);
}

/** The Add member dialog for `group`; `done` runs after someone was added. */
async function openAddMemberDialog(c, host, group, done) {
  const n = (await c.groupNotes(group)).length;
  openKeyLookupDialog(c, host, {
    title: `Add member to “${group}”`,
    submitLabel: `Add and re-encrypt ${n} ${n === 1 ? "note" : "notes"}`,
    add: (member) => c.addMemberAndReencrypt(group, member),
    done,
  });
}

/** Add member for the vault: the same GitHub lookup and fingerprint check, then `addVaultMember`. */
function openAddVaultMemberDialog(c, host, name, done) {
  openKeyLookupDialog(c, host, {
    title: `Add member to “${name}”`,
    submitLabel: "Add member",
    add: (member) => c.addVaultMember(member),
    done,
  });
}

/**
 * Looks a GitHub login's keys up, has the user pick one and confirm its
 * fingerprint outside Mahfouz, then runs `add({login, fpr})`.
 */
function openKeyLookupDialog(c, host, { title, submitLabel, add, done }) {
  openDialog(host, title, (card, close) => {
    const login = h("input", { className: "dialog-input", autocomplete: "off", spellcheck: "false", placeholder: "GitHub login", "aria-label": "GitHub login" });
    const find = h("button", { type: "button", className: "btn" }, "Find keys");
    const keysBox = h("div");
    const error = errorLine();
    const submit = h("button", { type: "submit", className: "dialog-submit", disabled: true }, submitLabel);
    let found = null;
    let chosen = null;
    let confirmed = false;
    const refresh = () => (submit.disabled = !(found && chosen && confirmed));
    const lookUp = async () => {
      error.show(null);
      keysBox.replaceChildren();
      found = chosen = null;
      confirmed = false;
      refresh();
      const who = login.value.trim().replace(/^@/, "");
      find.disabled = true;
      try {
        found = { login: who, keys: await c.lookUpMember(who) };
      } catch (err) {
        error.show(err);
        return;
      } finally {
        find.disabled = false;
      }
      const name = uidName(found.keys[0].uids?.[0]) || `@${who}`;
      if (found.keys.length === 1) chosen = found.keys[0].fpr;
      keysBox.append(
        ...found.keys.map((k) =>
          h(
            "label",
            { className: "dialog-radio-row" },
            h("input", { type: "radio", name: "enc-key", value: k.fpr, checked: k.fpr === chosen, onChange: () => ((chosen = k.fpr), refresh()) }),
            h("span", {}, h("code", {}, formatFpr(k.fpr)), uidName(k.uids?.[0]) ? ` ${uidName(k.uids[0])}` : "")
          )
        ),
        h(
          "p",
          { className: "dialog-hint" },
          `Confirm this fingerprint with ${name} outside Mahfouz before adding them. Anyone who can change their GitHub account could swap it.`
        ),
        h(
          "label",
          { className: "dialog-checkbox-row" },
          h("input", { type: "checkbox", onChange: (e) => ((confirmed = e.target.checked), refresh()) }),
          "I've confirmed the fingerprint"
        )
      );
      refresh();
    };
    find.addEventListener("click", () => void lookUp());
    login.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void lookUp();
      }
    });
    card.append(
      h(
        "form",
        {
          onSubmit: async (e) => {
            e.preventDefault();
            if (submit.disabled) return;
            submit.disabled = true;
            error.show(null);
            try {
              await add({ login: found.login, fpr: chosen });
              close();
              done?.();
            } catch (err) {
              error.show(err);
              refresh();
            }
          },
        },
        h("div", { className: "dialog-row" }, login, find),
        keysBox,
        error.node,
        actions(close, submit)
      )
    );
  });
}

function openNewGroupDialog(c, host, keys, done) {
  openDialog(host, "New group", (card, close) => {
    const name = h("input", { className: "dialog-input", id: "enc-group-name", autocomplete: "off", spellcheck: "false" });
    const login = h("input", { className: "dialog-input", id: "enc-self-login", autocomplete: "off", spellcheck: "false" });
    const error = errorLine();
    card.append(
      h(
        "form",
        {
          onSubmit: async (e) => {
            e.preventDefault();
            error.show(null);
            try {
              await c.newGroup(name.value.trim(), keys.login ?? login.value.trim().replace(/^@/, ""));
              close();
              done?.();
            } catch (err) {
              error.show(err);
            }
          },
        },
        h("div", { className: "dialog-row" }, h("label", { className: "dialog-label", for: "enc-group-name" }, "Name"), name),
        keys.login
          ? null
          : h("div", { className: "dialog-row" }, h("label", { className: "dialog-label", for: "enc-self-login" }, "Your GitHub login"), login),
        error.node,
        actions(close, h("button", { type: "submit", className: "dialog-submit" }, "Create"))
      )
    );
  });
}

/** The Encrypt “<vault>” dialog; `done` runs after the vault was encrypted. */
async function openEncryptVaultDialog(c, host, done) {
  const st = await c.vaultStatus();
  const features = c.vaultFeatures();
  const renameCount = features.renameExisting ? await host.notes.countRenamableById() : null;
  const title = `Encrypt “${vaultName(host.vault?.current()?.path)}”`;
  openDialog(host, title, (card, close) => {
    const error = errorLine();
    const submit = h("button", { type: "submit", className: "dialog-submit", disabled: !!st.usesLfs }, "Encrypt vault");
    // Only the options this app can do; the recommended one first.
    const options = HISTORY_OPTIONS.filter((o) => features[o.id]);
    let history = st.hasRemote ? options[0].id : "now";
    let rename = false;
    const question = st.hasRemote
      ? h(
          "fieldset",
          { className: "dialog-fieldset" },
          h("legend", { className: "dialog-label" }, HISTORY_QUESTION),
          options.map((o) =>
            h(
              "label",
              { className: "dialog-radio-row" },
              h("input", {
                type: "radio",
                name: "enc-history",
                value: o.id,
                checked: o.id === history,
                onChange: () => (history = o.id),
              }),
              h(
                "span",
                {},
                h("span", {}, o.label, o.recommended ? h("span", { className: "text-caption" }, " (recommended)") : null),
                h("span", { className: "text-caption", style: "display:block" }, o.text)
              )
            )
          )
        )
      : null;
    const renameLink = features.renameExisting
      ? h(
          "button",
          {
            type: "button",
            className: "btn-link",
            role: "switch",
            "aria-checked": "false",
            onClick: (e) => {
              rename = !rename;
              e.currentTarget.setAttribute("aria-checked", String(rename));
            },
          },
          `Rename ${renameCount} existing notes too`
        )
      : null;
    card.append(
      h(
        "form",
        {
          onSubmit: async (e) => {
            e.preventDefault();
            if (submit.disabled) return;
            submit.disabled = true;
            error.show(null);
            host.progress("Encrypting the vault");
            try {
              await c.encryptVault({ history, renameExisting: rename });
              close();
              done?.();
            } catch (err) {
              error.show(err);
              submit.disabled = false;
            } finally {
              host.progress("");
            }
          },
        },
        h("p", { className: "dialog-hint" }, VAULT_DIALOG_TEXT),
        question,
        // The second sentence only where the app can keep it true.
        h(
          "p",
          { className: "dialog-error", role: "note" },
          features.nameById ? `${NAMES_TEXT} ${NAMES_BY_ID_TEXT}` : NAMES_TEXT,
          renameLink ? " " : null,
          renameLink
        ),
        st.usesLfs ? h("p", { className: "dialog-error", role: "alert" }, LFS_TEXT) : null,
        error.node,
        actions(close, submit)
      )
    );
  });
}

/** Settings → Encryption's vault section: what `draw` appends. `unlockError` is the last Unlock's error, kept across redraws. */
async function vaultSection(c, host, ctx, state, redraw) {
  const parts = [h("div", { className: "section-title section-title-secondary" }, VAULT_SECTION)];
  const fail = (err) => host.toast(messageOf(err), "error");
  let st;
  try {
    st = await c.vaultStatus();
  } catch (err) {
    parts.push(h("p", { className: "form-error" }, messageOf(err)));
    return parts;
  }
  const features = c.vaultFeatures();
  if (!st.encrypted) {
    parts.push(
      h("p", { className: "text-caption" }, VAULT_TEXT),
      features.encrypt
        ? h(
            "div",
            { className: "btn-row" },
            h(
              "button",
              { type: "button", className: "btn", disabled: !ctx.keys.signing, onClick: () => void openEncryptVaultDialog(c, host, redraw).catch(fail) },
              "Encrypt vault…"
            )
          )
        : null
    );
    return parts;
  }
  const busy = (btn, run) => async () => {
    btn.disabled = true;
    state.unlockError = null;
    try {
      await run();
    } catch (err) {
      if (err?.code === "noMemberKey") state.unlockError = err;
      else fail(err);
    }
    redraw();
  };
  const canToggle = st.unlocked ? features.lock : features.unlock;
  const toggle = canToggle ? h("button", { type: "button", className: "btn" }, st.unlocked ? "Lock" : "Unlock") : null;
  toggle?.addEventListener("click", busy(toggle, () => (st.unlocked ? c.lockVault() : c.unlockVault())));
  parts.push(h("div", { className: "dialog-row" }, h("span", {}, st.unlocked ? "Encrypted · unlocked on this Mac" : "Encrypted · locked on this Mac"), toggle));
  const noKey = state.unlockError;
  if (noKey && !st.unlocked) {
    parts.push(
      h(
        "p",
        { className: "form-error", role: "alert" },
        noKey.fpr ? `${NO_VAULT_KEY_TEXT} ` : messageOf(noKey),
        noKey.fpr ? h("code", {}, formatFpr(noKey.fpr)) : null,
        noKey.fpr ? " " : null,
        noKey.fpr
          ? h("button", { type: "button", className: "btn-link", onClick: () => void globalThis.navigator?.clipboard?.writeText(noKey.fpr) }, "Copy")
          : null
      )
    );
  }
  for (const m of c.vaultMembers(ctx.md, st.members, ctx.own)) {
    const remove = async () => {
      await c.removeVaultMember(m.fpr, m.login).catch(fail);
      redraw();
    };
    parts.push(
      h(
        "div",
        { className: "dialog-row" },
        h("span", {}, m.login ? `@${m.login} ` : "", h("code", {}, shortFpr(m.fpr)), m.you ? " (you)" : ""),
        m.you || !st.unlocked ? null : h("button", { type: "button", className: "btn-link", onClick: () => void remove() }, "Remove")
      )
    );
  }
  parts.push(
    h(
      "div",
      { className: "btn-row" },
      h(
        "button",
        {
          type: "button",
          className: "btn",
          disabled: !st.unlocked,
          onClick: () => openAddVaultMemberDialog(c, host, vaultName(host.vault?.current()?.path), redraw),
        },
        "Add member"
      )
    ),
    h("p", { className: "text-caption" }, REMOVE_MEMBER_TEXT)
  );
  return parts;
}

/** A row of "Your keys": the key in use and a Change picker over `candidates`. */
function keyPicker(label, current, candidates, onPick) {
  const text = h("span", {}, current ? keyLabel(candidates.find((k) => k.fpr === current) ?? { fpr: current }) : "Not set");
  const select = h(
    "select",
    { className: "dialog-select", "aria-label": label },
    h("option", { value: "" }, "—"),
    candidates.map((k) => h("option", { value: k.fpr, selected: k.fpr === current }, keyLabel(k)))
  );
  select.hidden = true;
  const change = h("button", { type: "button", className: "btn-link", disabled: candidates.length === 0 }, "Change");
  change.addEventListener("click", () => {
    select.hidden = false;
    change.hidden = true;
    select.focus();
  });
  select.addEventListener("change", () => onPick(select.value || null));
  return h("div", { className: "dialog-row" }, h("span", { className: "dialog-label" }, label), text, select, change);
}

/** Settings → Encryption, drawn into `container`; returns the cleanup. */
function renderSettings(c, host, storage, container) {
  let alive = true;
  let drawing = 0;
  const vaultUi = { unlockError: null };
  const root = h("div", { className: "encryption-settings" });
  container.replaceChildren(root);
  const fail = (err) => host.toast(messageOf(err), "error");

  async function draw() {
    const run = ++drawing;
    const show = (parts) => {
      if (alive && run === drawing) root.replaceChildren(...parts);
    };
    const parts = [h("div", { className: "section-title" }, "GPG")];
    let status;
    try {
      status = await host.sidecar.call("status", {});
    } catch {
      status = { gpgNotFound: true };
    }
    if (status.gpgNotFound) {
      parts.push(
        h("p", { className: "text-caption" }, NOT_FOUND_TEXT),
        h("div", { className: "btn-row" }, h("button", { type: "button", className: "btn", onClick: () => void draw() }, "Check again"))
      );
      return show(parts);
    }
    parts.push(h("p", { className: "text-caption" }, `GPG ${status.version} at ${status.gpgPath}`));

    let ctx;
    try {
      ctx = await c.context();
    } catch (err) {
      parts.push(h("p", { className: "form-error" }, messageOf(err)));
      return show(parts);
    }
    const { md, secret, keys, own } = ctx;
    const save = (patch) => {
      saveKeys(storage, { ...loadKeys(storage), ...patch });
      void draw();
    };
    parts.push(
      h("div", { className: "section-title section-title-secondary" }, "Your keys"),
      keyPicker("Signing key", keys.signing, secret.filter(usableForSigning), (fpr) => save({ signing: fpr })),
      keyPicker("Backup key", keys.backup, secret.filter(usableForEncryption), (fpr) => save({ backup: fpr })),
      h("p", { className: "text-caption" }, BACKUP_TEXT)
    );

    const mine = new Set(own);
    parts.push(h("div", { className: "section-title section-title-secondary" }, "Groups"));
    for (const g of parseConfig(md).groups.filter((x) => GROUP_RE.test(x.name))) {
      const stop = async (login) => {
        const ok = await host.ui.confirm({
          title: `Stop sharing “${g.name}” with @${login}?`,
          body: STOP_SHARING_TEXT,
          confirmLabel: "Stop sharing",
          danger: true,
        });
        if (!ok) return;
        await c.stopSharing(g.name, login).catch(fail);
        void draw();
      };
      parts.push(
        h(
          "div",
          { className: "encryption-group" },
          h("div", { className: "section-title-row" }, h("strong", {}, g.name)),
          g.members.map((m) => {
            const isYou = g.members.some((x) => x.login === m.login && mine.has(x.fpr));
            const firstOfLogin = g.members.find((x) => x.login === m.login) === m;
            return h(
              "div",
              { className: "dialog-row" },
              h("span", {}, `@${m.login || "?"} `, h("code", {}, shortFpr(m.fpr)), mine.has(m.fpr) ? " (you)" : ""),
              firstOfLogin && !isYou && m.login ? h("button", { type: "button", className: "btn-link", onClick: () => void stop(m.login) }, "Stop sharing") : null
            );
          }),
          c.canReencrypt()
            ? h(
                "div",
                { className: "btn-row" },
                h("button", { type: "button", className: "btn", onClick: () => void openAddMemberDialog(c, host, g.name, draw).catch(fail) }, "Add member")
              )
            : null
        )
      );
    }
    parts.push(
      h(
        "div",
        { className: "btn-row" },
        h("button", { type: "button", className: "btn", disabled: !keys.signing, onClick: () => openNewGroupDialog(c, host, keys, draw) }, "New group")
      )
    );

    if (host.vault?.current()) parts.push(...(await vaultSection(c, host, ctx, vaultUi, () => void draw())));

    const others = await c.networkedPlugins().catch(() => null);
    if (others && others.length > 0) {
      parts.push(
        h(
          "p",
          { className: "form-error", role: "note" },
          `Other enabled plugins can reach the network: ${others.join(", ")}. Installed plugins share one trust domain, so any of them could ask for a decrypt. Set gpg-agent to ask for your passphrase or a YubiKey touch every time. `,
          h("button", { type: "button", className: "btn-link", onClick: () => void host.ui.openExternal(GUIDE_URL) }, "How")
        )
      );
    }
    show(parts);
  }

  void draw();
  return () => {
    alive = false;
  };
}

// ---- activate --------------------------------------------------------------------------

let controller = null;

export function activate(host) {
  // The web, or an app older than encrypted notes: nothing this plugin can do there.
  if (!host.registerBodyCodec) return;
  const storage = globalThis.localStorage;
  const c = createController(host, storage);
  controller = c;

  host.registerBodyCodec(c.codec);
  host.vault?.onClose(() => c.forgetAll());

  // Without the app's dialogs and Settings tabs (an app older than 0.12.1), the codec alone: encrypted notes still unlock and save.
  if (typeof host.ui.openDialog !== "function" || typeof host.ui.confirm !== "function" || typeof host.registerSettingsTab !== "function") return;

  const fail = (err) => host.toast(messageOf(err), "error");
  const encrypt = (note) => openEncryptDialog(c, host, note).catch(fail);
  const decrypt = (note) => runDecrypt(c, host, note).catch(fail);
  host.registerSettingsTab({ id: "encryption", label: "Encryption", render: (container) => renderSettings(c, host, storage, container) });
  const openSettings = () => host.openSettingsTab?.("encryption");

  // The note menu, for the notes each applies to (`CommandNote.encryptedGroup`, `unlocked`).
  host.registerCommand({ id: "encrypt", label: "Encrypt…", noteMenu: true, palette: false, when: c.isPlain, run: encrypt });
  host.registerCommand({ id: "decrypt", label: "Decrypt…", noteMenu: true, palette: false, when: c.isUnlocked, run: decrypt });
  // The palette, for the active note. No default shortcuts.
  host.registerCommand({ id: "encrypt-note", label: "Encrypt note", when: c.isPlain, run: encrypt });
  host.registerCommand({ id: "decrypt-note", label: "Decrypt note", when: c.isUnlocked, run: decrypt });
  if (typeof host.openSettingsTab === "function") host.registerCommand({ id: "settings", label: "Encryption settings", run: openSettings });

  // Whole-vault encryption: the palette's Unlock vault in a vault locked on this Mac, and the locked-vault notice's Unlock.
  if (c.vaultFeatures().unlock) {
    const unlockVault = () =>
      c.unlockVault().catch((err) => {
        fail(err);
        if (err?.code === "noMemberKey") openSettings();
      });
    host.registerCommand({ id: "unlock-vault", label: "Unlock vault", when: c.isVaultLocked, run: unlockVault });
    host.registerVaultUnlocker?.({ label: "Unlock", unlock: () => c.unlockVault() });
  }
  const refreshVault = () => void c.vaultStatus().catch(() => {});
  host.vault?.onOpen(refreshVault);
  if (host.vault?.current()) refreshVault();

  // The toolbar: an open lock on a plain note, a filled one on an unlocked encrypted note.
  host.registerToolbarItem({
    kind: "toggle",
    id: "lock",
    label: "Encrypt…",
    icon: LOCK_OPEN,
    when: c.isPlain,
    isActive: () => false,
    onChange: (fn) => c.onChange(fn),
    toggle: encrypt,
  });
  host.registerToolbarItem({
    kind: "toggle",
    id: "unlock",
    label: "Decrypt…",
    icon: LOCK_CLOSED,
    when: c.isUnlocked,
    isActive: () => true,
    onChange: (fn) => c.onChange(fn),
    toggle: decrypt,
  });
}

export function deactivate() {
  controller?.forgetAll();
  controller = null;
}
