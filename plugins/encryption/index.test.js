// Run with `npm test` (node --test) from the repo root. No DOM, no gpg and
// no network: the host and its sidecar are fakes, and the config fixtures
// are the app's own (src/core/src/crypto/decrypt.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  activate,
  addGroup,
  addMember,
  computeRecipients,
  CONFIG_PATH,
  createController,
  deactivate,
  errorCode,
  formatFpr,
  groupSigners,
  loadKeys,
  normalizeFpr,
  onlyMeGroup,
  parseConfig,
  removeMember,
  saveKeys,
  selfLogin,
  shortFpr,
  skippedOf,
  STORAGE_KEY,
  LFS_TEXT,
  loadTerms,
  parseTerms,
  uidName,
} from "./index.js";

const ME = "0123456789ABCDEF0123456789ABCDEF01234567";
const BACKUP = "89ABCDEF0123456789ABCDEF0123456789ABCDEF";
const BOSS = "FEDCBA9876543210FEDCBA9876543210FEDCBA98";
const ADA = "AAAA000011112222333344445555666677778888";
const LONG = "B".repeat(64);
// The app's fixture, verbatim.
const APP_CONFIG = `# Encryption\n\n## family\n\n| Member | Fingerprint |\n|---|---|\n| o | \`${ME.toLowerCase()}\` |\n| o (backup) | ${BACKUP.replace(/(.{4})/g, "$1 ")} |\n\n## work\n\n| boss | FEDCBA9876543210FEDCBA9876543210FEDCBA98 |\n`;

/** The app's groupSigners, verbatim from src/core/src/crypto/decrypt.ts, as the reference. */
function appGroupSigners(md, group) {
  const out = [];
  let inGroup = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && !line.startsWith("###")) {
      inGroup = heading[1].replace(/`/g, "") === group;
      continue;
    }
    if (!inGroup || !line.startsWith("|")) continue;
    for (const cell of line.replace(/^\||\|$/g, "").split("|")) {
      const fpr = cell.replace(/[`\s]/g, "").toUpperCase();
      if (/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(fpr) && !out.includes(fpr)) out.push(fpr);
    }
  }
  return out;
}

const groupsOf = (md) => Object.fromEntries(parseConfig(md).groups.map((g) => [g.name, g.members.map((m) => `${m.login}:${m.fpr}`)]));

// ---- config ---------------------------------------------------------------------------

test("groupSigners reads the app's fixture exactly as the app does", () => {
  assert.deepEqual(groupSigners(APP_CONFIG, "family"), [ME, BACKUP]);
  assert.deepEqual(groupSigners(APP_CONFIG, "work"), [BOSS]);
  assert.deepEqual(groupSigners(APP_CONFIG, "fam"), []);
  assert.deepEqual(groupSigners("| o | " + ME + " |\n", "family"), []);
});

test("parseConfig finds the members groupSigners trusts, with their logins", () => {
  assert.deepEqual(groupsOf(APP_CONFIG), { family: [`o:${ME}`, `o:${BACKUP}`], work: [`boss:${BOSS}`] });
  for (const g of parseConfig(APP_CONFIG).groups) {
    assert.deepEqual([...new Set(g.members.map((m) => m.fpr))], appGroupSigners(APP_CONFIG, g.name));
  }
});

test("extra content leaves the groups alone: prose, ### headings, CRLF, backticked headings, other tables", () => {
  const md = [
    "# Encryption",
    "Some prose with a | pipe that isn't a row start.",
    "## `family` ##",
    "Notes about the family.",
    "### Older keys",
    `| @o | ${ME} |`,
    "## Settings",
    "| key | value |",
    "|---|---|",
    "| theme | dark |",
  ].join("\r\n");
  assert.deepEqual(groupSigners(md, "family"), [ME]);
  assert.deepEqual(appGroupSigners(md, "family"), [ME]);
  assert.deepEqual(groupsOf(md), { family: [`o:${ME}`], Settings: [] });
});

test("addGroup starts a file the app reads, and refuses a bad or taken name", () => {
  const md = addGroup("", "family", [
    { login: "o", fpr: ME.toLowerCase() },
    { login: "o", fpr: BACKUP },
    { login: "o", fpr: ME },
  ]);
  assert.match(md, /^# Encryption\n\n/);
  assert.match(md, /\n## family\n\n\| login \| fingerprint \|\n\|---\|---\|\n\| o \| 0123/);
  assert.deepEqual(appGroupSigners(md, "family"), [ME, BACKUP]);
  assert.deepEqual(groupsOf(md), { family: [`o:${ME}`, `o:${BACKUP}`] });
  assert.ok(md.endsWith("|\n"));
  assert.throws(() => addGroup(md, "family", []), /already a group/);
  assert.throws(() => addGroup(md, "Only me", []), /letters, digits/);
  assert.throws(() => addGroup(md, "x", [{ login: "not a login", fpr: ME }]), /isn't a GitHub login/);
  assert.throws(() => addGroup(md, "x", [{ login: "o", fpr: "ABCD" }]), /full fingerprint/);
});

test("addMember appends a row to the group's table and keeps everything else byte for byte", () => {
  const md = addMember(APP_CONFIG, "family", { login: "ada", fpr: ADA });
  assert.deepEqual(appGroupSigners(md, "family"), [ME, BACKUP, ADA]);
  assert.deepEqual(appGroupSigners(md, "work"), [BOSS]);
  assert.equal(md.replace(`| ada | ${ADA} |\n`, ""), APP_CONFIG);
  // Already listed: unchanged. A missing group is created; a section without a table gets one.
  assert.equal(addMember(md, "family", { login: "ada", fpr: ADA.toLowerCase() }), md);
  assert.deepEqual(appGroupSigners(addMember(APP_CONFIG, "new", { login: "ada", fpr: LONG }), "new"), [LONG]);
  const bare = addMember("## empty\n\nprose\n## next\n", "empty", { login: "ada", fpr: ADA });
  assert.deepEqual(appGroupSigners(bare, "empty"), [ADA]);
  assert.deepEqual(appGroupSigners(bare, "next"), []);
  // CRLF files stay CRLF.
  const crlf = addMember(APP_CONFIG.replace(/\n/g, "\r\n"), "work", { login: "ada", fpr: ADA });
  assert.ok(!/[^\r]\n/.test(crlf));
  assert.deepEqual(appGroupSigners(crlf, "work"), [BOSS, ADA]);
});

test("removeMember drops every row of that login in that group only", () => {
  const both = addMember(APP_CONFIG, "work", { login: "o", fpr: ME });
  const md = removeMember(both, "family", "O");
  assert.deepEqual(appGroupSigners(md, "family"), []);
  assert.deepEqual(appGroupSigners(md, "work"), [BOSS, ME]);
  assert.equal(removeMember(APP_CONFIG, "family", "nobody"), APP_CONFIG);
  assert.equal(removeMember(APP_CONFIG, "nope", "o"), APP_CONFIG);
  assert.equal(removeMember(addMember(APP_CONFIG, "work", { login: "ada", fpr: ADA }), "work", "ada"), APP_CONFIG);
});

test("a round trip through every editor still reads the same in the app", () => {
  let md = "";
  md = addGroup(md, "family", [{ login: "o", fpr: ME }]);
  md = addMember(md, "family", { login: "ada", fpr: ADA });
  md = addGroup(md, "work", [{ login: "boss", fpr: BOSS }]);
  md = addMember(md, "work", { login: "ada", fpr: LONG });
  md = removeMember(md, "family", "ada");
  assert.deepEqual(appGroupSigners(md, "family"), [ME]);
  assert.deepEqual(appGroupSigners(md, "work"), [BOSS, LONG]);
  for (const g of parseConfig(md).groups) assert.deepEqual(groupSigners(md, g.name), appGroupSigners(md, g.name));
});

// ---- helpers ------------------------------------------------------------------------------

test("recipients are the group's keys plus the backup key, normalized, once each", () => {
  assert.deepEqual(computeRecipients([ME, BOSS], BACKUP), [ME, BOSS, BACKUP]);
  assert.deepEqual(computeRecipients([ME, BACKUP], BACKUP.toLowerCase()), [ME, BACKUP]);
  assert.deepEqual(computeRecipients([ME, ME], null), [ME]);
  assert.deepEqual(computeRecipients([], "junk"), []);
});

test("small helpers", () => {
  assert.equal(normalizeFpr(` \`${ME.toLowerCase()}\` `), ME);
  assert.equal(normalizeFpr("ABCD"), null);
  assert.equal(formatFpr("ABCDEFGH12345678"), "ABCD EFGH 1234 5678");
  assert.equal(shortFpr(ME), "89AB CDEF 0123 4567");
  assert.equal(uidName("Ada Lovelace (work) <ada@example.com>"), "Ada Lovelace");
  assert.equal(uidName("<ada@example.com>"), "");
  assert.equal(errorCode(new Error("unknownRecipient: no key")), "unknownRecipient");
  assert.equal(errorCode({ data: { code: "timeout" }, message: "x" }), "timeout");
  assert.equal(errorCode(new Error("plain words")), "");
  assert.equal(onlyMeGroup("o"), "only-o");
  assert.equal(selfLogin(APP_CONFIG, [BACKUP], null), "o");
  assert.equal(selfLogin(APP_CONFIG, [ADA], null), null);
  assert.equal(selfLogin(APP_CONFIG, [ME], "stored"), "stored");
});

test("keys are kept per machine in storage, and bad values are dropped", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadKeys(storage), { signing: null, backup: null, login: null });
  saveKeys(storage, { signing: ME.toLowerCase(), backup: BACKUP, login: "o" });
  assert.deepEqual(loadKeys(storage), { signing: ME, backup: BACKUP, login: "o" });
  storage.setItem(STORAGE_KEY, "{not json");
  assert.deepEqual(loadKeys(storage), { signing: null, backup: null, login: null });
  storage.setItem(STORAGE_KEY, JSON.stringify({ signing: "x", login: "bad login" }));
  assert.deepEqual(loadKeys(storage), { signing: null, backup: null, login: null });
});

// ---- the controller, over a fake host --------------------------------------------------------

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)) };
}

const armorOf = (plaintext, recipients) => `-----BEGIN PGP MESSAGE-----\n${recipients.join(",")}\n${plaintext}\n-----END PGP MESSAGE-----\n`;
const KEYBLOCK = "-----BEGIN PGP PUBLIC KEY BLOCK-----\n...\n-----END PGP PUBLIC KEY BLOCK-----\n";

/**
 * A fake host: notes by id (`{title, path, attributes, body}`), the config
 * file, a sidecar whose `encrypt` writes the recipients into the armor and
 * refuses recipients it hasn't "imported", GitHub's `.gpg` endpoint, and
 * the APIs the app is asked to add (`notes.listEncrypted`, `notes.decrypt`).
 */
function fakeHost({ config = "", notes = {}, keyring = [ME, BACKUP], github = {}, listApis = true, diskOnly = [], vault = {} } = {}) {
  const log = [];
  const imported = new Set(keyring);
  const host = {
    plugin: { id: "mahfouz/encryption" },
    log,
    notesById: notes,
    configText: config,
    config: {
      read: async () => host.configText || null,
      write: async (t) => {
        log.push(["config.write"]);
        host.configText = t;
      },
    },
    http: {
      request: async ({ url }) => {
        log.push(["http", url]);
        const login = /github\.com\/([^/]+)\.gpg$/.exec(url)?.[1];
        return login in github ? { status: 200, headers: {}, body: KEYBLOCK } : { status: 404, headers: {}, body: "Not Found" };
      },
    },
    sidecar: {
      call: async (method, params) => {
        log.push([method]);
        if (method === "secretFingerprints") {
          return [
            { fpr: ME, uids: ["O <o@example.com>"], canEncrypt: true, canSign: true, expired: false, revoked: false },
            { fpr: BACKUP, uids: ["O backup"], canEncrypt: true, canSign: false, expired: false, revoked: false },
          ];
        }
        if (method === "importPublic") {
          // The keys of the login fetched last.
          const url = log.findLast(([m]) => m === "http")?.[1] ?? "";
          const keys = params.armored === KEYBLOCK ? (github[/([^/]+)\.gpg$/.exec(url)?.[1]] ?? []) : [];
          for (const k of keys) imported.add(k.fpr);
          return keys;
        }
        if (method in host.vaultRpc) return host.vaultRpc[method](params);
        if (method === "encrypt") {
          const missing = params.recipients.find((r) => !imported.has(r));
          if (missing) {
            const err = new Error(`unknownRecipient: no public key for ${missing}`);
            err.data = { code: "unknownRecipient" };
            throw err;
          }
          if (!params.recipients.includes(params.signer)) throw new Error("invalidParams: signer");
          host.encrypts = (host.encrypts ?? []).concat([params]);
          return { armored: armorOf(params.plaintext, params.recipients) };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    notes: {
      get: async ({ noteId }) => {
        const n = notes[noteId];
        if (!n) throw new Error("That note no longer exists.");
        return { vaultId: "v", noteId, ...structuredClone(n) };
      },
      setEncryption: async ({ noteId }, change) => {
        log.push(["setEncryption", noteId]);
        const n = notes[noteId];
        if (n.body !== change.expected) throw new Error("changed");
        if ("plaintext" in change) {
          delete n.attributes.encrypted;
          n.body = change.plaintext;
        } else {
          n.attributes.encrypted = change.group;
          n.body = change.armored;
        }
      },
      writeBody: async ({ noteId }, body, expected) => {
        log.push(["writeBody", noteId]);
        const n = notes[noteId];
        if (n.body !== expected) throw new Error("changed");
        n.body = body;
      },
      ...(listApis
        ? {
            listEncrypted: async (group) =>
              Object.entries(notes)
                .filter(([, n]) => n.attributes.encrypted === group)
                .map(([noteId]) => ({ vaultId: "v", noteId })),
            decrypt: async ({ noteId }) => {
              log.push(["decrypt", noteId]);
              const n = notes[noteId];
              return { plaintext: n.plain, armored: n.body };
            },
          }
        : {}),
    },
    vault: {
      current: () => ({ vaultId: "v", path: "/vaults/Diary" }),
      onOpen: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
      commitFiles: async (paths, message) => {
        log.push(["commit", paths, message]);
        const skipped = paths.filter((p) => diskOnly.includes(p));
        return { committed: skipped.length < paths.length, skipped };
      },
    },
    vaultRpc: fakeVaultRpc(log, vault),
    progress: () => {},
    toast: (m) => log.push(["toast", m]),
  };
  return host;
}

/** The sidecar's vault methods over a fake vault: `{encrypted, unlocked, members, usesLfs, hasRemote, dirty, memberKey}`. */
function fakeVaultRpc(log, v) {
  const state = { encrypted: false, unlocked: false, members: [], usesLfs: false, hasRemote: false, dirty: false, memberKey: true, ...v };
  const fail = (code, msg) => {
    const err = new Error(`${code}: ${msg}`);
    err.data = { code };
    throw err;
  };
  return {
    state,
    vaultStatus: () => ({ encrypted: state.encrypted, unlocked: state.unlocked, keyNames: [], members: [...state.members], usesLfs: state.usesLfs, hasRemote: state.hasRemote }),
    initVault: ({ members }) => {
      if (state.usesLfs) fail("usesLfs", "lfs");
      Object.assign(state, { encrypted: true, unlocked: true, members: [...members] });
      const paths = [".git-crypt/.gitattributes", ...members.map((f) => `.git-crypt/keys/default/0/${f}.gpg`), ".gitattributes"];
      return { paths, gitattributes: "* filter=git-crypt diff=git-crypt\n" };
    },
    unlockVault: () => {
      if (!state.memberKey) fail("noMemberKey", "none of your secret keys");
      state.unlocked = true;
      return { member: state.members[0], alreadyUnlocked: false };
    },
    lockVault: () => {
      if (state.dirty) fail("uncommitted", "1 file(s) aren't committed");
      state.unlocked = false;
      return { wasUnlocked: true };
    },
    addVaultMember: ({ fpr }) => {
      state.members.push(fpr);
      return { paths: [`.git-crypt/keys/default/0/${fpr}.gpg`] };
    },
    removeVaultMember: ({ fpr }) => {
      state.members = state.members.filter((f) => f !== fpr);
      return { paths: [`.git-crypt/keys/default/0/${fpr}.gpg`] };
    },
  };
}

const encNote = (title, group, plain, recipients = [ME, BACKUP]) => ({
  title,
  path: `${title}.md`,
  attributes: { encrypted: group },
  body: armorOf(plain, recipients),
  plain,
});
const ref = (noteId) => ({ vaultId: "v", noteId });

function setup(opts) {
  const host = fakeHost(opts);
  const storage = memoryStorage();
  saveKeys(storage, { signing: ME, backup: BACKUP, login: "o" });
  return { host, storage, c: createController(host, storage) };
}

test("the codec matches encrypted notes, decodes only through the app, and encodes to the group plus the backup key", async () => {
  const config = addGroup("", "work", [{ login: "o", fpr: ME }, { login: "boss", fpr: BOSS }]);
  const { host, c } = setup({ config, keyring: [ME, BACKUP, BOSS] });
  assert.equal(c.codec.id, "gpg");
  assert.equal(c.codec.matches({ encrypted: "work" }), true);
  assert.equal(c.codec.matches({ encrypted: "" }), true);
  assert.equal(c.codec.matches({ title: "x" }), false);

  const ctx = { vaultId: "v", noteId: "n1", path: "n1.md", group: "work", armored: "ARMOR" };
  // An Unlock decrypts the file; a merge's version decrypts that commit's blob.
  assert.equal(await c.codec.decode({ ...ctx, decryptNote: async () => "secret" }), "secret");
  const asked = [];
  const blob = async (sha) => (asked.push(sha), "from history");
  assert.equal(await c.codec.decode({ ...ctx, sha: "abc123", decryptBlob: blob }), "from history");
  assert.deepEqual(asked, ["abc123"]);
  assert.equal(await c.codec.decode({ ...ctx, sha: "abc123", decryptBlob: blob, decryptNote: async () => "file" }), "file");

  const armored = await c.codec.encode(ctx, "secret v2");
  assert.deepEqual(host.encrypts.at(-1), { plaintext: "secret v2", recipients: [ME, BOSS, BACKUP], signer: ME });
  assert.match(armored, /^-----BEGIN PGP MESSAGE-----/);
});

test("encode refuses without a signing key, for a group not listing it, and for an unknown group", async () => {
  const config = addGroup("", "work", [{ login: "boss", fpr: BOSS }]);
  const { c, storage } = setup({ config });
  const ctx = { vaultId: "v", noteId: "n1", path: "n1.md", group: "work", armored: "" };
  await assert.rejects(c.codec.encode(ctx, "x"), /Your signing key isn't in the “work” group/);
  await assert.rejects(c.codec.encode({ ...ctx, group: "nope" }, "x"), /has no keys/);
  saveKeys(storage, { signing: null, backup: BACKUP });
  await assert.rejects(c.codec.encode(ctx, "x"), /Choose your signing key/);
});

test("encode fetches a member's keys from GitHub once when the plugin keyring lacks them", async () => {
  const config = addGroup("", "work", [{ login: "o", fpr: ME }, { login: "boss", fpr: BOSS }]);
  const { host, c } = setup({ config, github: { boss: [{ fpr: BOSS, uids: [], canEncrypt: true }] } });
  await c.codec.encode({ vaultId: "v", noteId: "n", path: "n.md", group: "work", armored: "" }, "hi");
  assert.deepEqual(
    host.log.filter(([m]) => m !== "secretFingerprints").map(([m, u]) => (m === "http" ? u : m)),
    ["encrypt", "https://github.com/boss.gpg", "importPublic", "encrypt"]
  );
});

test("Encrypt: Only me creates your group with your keys, writes it, then switches the note", async () => {
  const { host, c } = setup({ notes: { n1: { title: "Diary", path: "Diary.md", attributes: {}, body: "dear diary" } } });
  assert.equal(await c.encryptNote(ref("n1"), { onlyMe: true, login: "o" }), "only-o");
  assert.deepEqual(groupSigners(host.configText, "only-o"), [ME, BACKUP]);
  assert.deepEqual(host.encrypts.at(-1).recipients, [ME, BACKUP]);
  assert.equal(host.notesById.n1.attributes.encrypted, "only-o");
  assert.deepEqual(
    host.log.filter(([m]) => m === "config.write" || m === "setEncryption").map(([m]) => m),
    ["config.write", "setEncryption"]
  );
  await assert.rejects(c.encryptNote(ref("n1"), { group: "only-o" }), /already encrypted/);
});

test("Encrypt works without a backup key, and leaves the config alone when nothing failed to write", async () => {
  const config = addGroup("", "family", [{ login: "o", fpr: ME }]);
  const { host, c, storage } = setup({ config, notes: { n: { title: "N", path: "N.md", attributes: {}, body: "x" } } });
  saveKeys(storage, { signing: ME, backup: null, login: "o" });
  await c.encryptNote(ref("n"), { group: "family" });
  assert.deepEqual(host.encrypts.at(-1).recipients, [ME]);
  assert.equal(host.configText, config);
});

test("commands and toolbar items apply by what the app says of the note", () => {
  const { host, c } = setup();
  const note = (extra) => ({ vaultId: "v", noteId: "n", path: "n.md", title: "N", ...extra });
  assert.equal(c.isPlain(note()), true);
  assert.equal(c.isUnlocked(note()), false);
  assert.equal(c.isPlain(note({ encryptedGroup: "family", unlocked: false })), false);
  assert.equal(c.isUnlocked(note({ encryptedGroup: "family", unlocked: false })), false);
  assert.equal(c.isUnlocked(note({ encryptedGroup: "family", unlocked: true })), true);
  // Without the app's decrypt, Decrypt isn't offered.
  delete host.notes.decrypt;
  assert.equal(c.isUnlocked(note({ encryptedGroup: "family", unlocked: true })), false);
});

test("Decrypt writes what the app decrypts from the file, only while the file still holds it", async () => {
  const note = encNote("Diary", "family", "dear diary");
  const { host, c } = setup({ config: addGroup("", "family", [{ login: "o", fpr: ME }]), notes: { n: note, p: { title: "P", path: "P.md", attributes: {}, body: "x" } } });
  await assert.rejects(c.encryptedNote(ref("p")), /“P” isn't encrypted/);
  assert.equal((await c.encryptedNote(ref("n"))).title, "Diary");
  await c.decryptNote(ref("n"));
  assert.deepEqual(host.log.filter(([m]) => m === "decrypt" || m === "setEncryption").map(([m]) => m), ["decrypt", "setEncryption"]);
  assert.equal(host.notesById.n.body, "dear diary");
  assert.equal(host.notesById.n.attributes.encrypted, undefined);

  // Re-encrypted elsewhere between the decrypt and the write: refused.
  const other = encNote("Other", "family", "b");
  host.notesById.o = other;
  const decrypt = host.notes.decrypt;
  host.notes.decrypt = async (n) => {
    const out = await decrypt(n);
    other.body = armorOf("b2", [ME]);
    return out;
  };
  await assert.rejects(c.decryptNote(ref("o")), /changed/);
  assert.equal(other.attributes.encrypted, "family");
});

test("Add member: looks the login up on GitHub, keeps only keys that can be encrypted to", async () => {
  const { c } = setup({
    github: {
      ada: [
        { fpr: ADA, uids: ["Ada <ada@example.com>"], canEncrypt: true, canSign: true, expired: false, revoked: false },
        { fpr: LONG, uids: [], canEncrypt: true, canSign: false, expired: true, revoked: false },
      ],
      nokeys: [],
    },
  });
  assert.deepEqual((await c.lookUpMember("ada")).map((k) => k.fpr), [ADA]);
  await assert.rejects(c.lookUpMember("ghost"), /GitHub has no user @ghost/);
  await assert.rejects(c.lookUpMember("nokeys"), /None of @nokeys's keys/);
  await assert.rejects(c.lookUpMember("bad login"), /isn't a GitHub login/);
});

test("Add member: re-encrypts each of the group's notes, then writes the config and commits them together", async () => {
  const config = addGroup("", "family", [{ login: "o", fpr: ME }]);
  const notes = {
    a: encNote("A", "family", "alpha"),
    b: encNote("B", "family", "beta"),
    w: encNote("W", "work", "other group"),
  };
  const { host, c } = setup({ config, notes, github: { ada: [{ fpr: ADA, uids: ["Ada"], canEncrypt: true }] } });
  await c.lookUpMember("ada");
  assert.equal((await c.groupNotes("family")).length, 2);

  assert.equal(await c.addMemberAndReencrypt("family", { login: "ada", fpr: ADA }), 2);
  for (const id of ["a", "b"]) assert.equal(host.notesById[id].body, armorOf(notes[id].plain, [ME, ADA, BACKUP]));
  assert.equal(host.notesById.w.body, armorOf("other group", [ME, BACKUP]));
  assert.deepEqual(groupSigners(host.configText, "family"), [ME, ADA]);
  const order = host.log.map(([m]) => m).filter((m) => ["decrypt", "writeBody", "config.write", "commit"].includes(m));
  assert.deepEqual(order, ["decrypt", "writeBody", "decrypt", "writeBody", "config.write", "commit"]);
  assert.deepEqual(host.log.find(([m]) => m === "commit"), ["commit", ["A.md", "B.md", CONFIG_PATH], "Add @ada to family"]);
});

test("Add member: a note that changed stops it before the config is written", async () => {
  const config = addGroup("", "family", [{ login: "o", fpr: ME }]);
  const notes = { a: encNote("A", "family", "alpha"), b: encNote("B", "family", "beta") };
  const { host, c } = setup({ config, notes, keyring: [ME, BACKUP, ADA] });
  const decrypt = host.notes.decrypt;
  host.notes.decrypt = async (n) => {
    const out = await decrypt(n);
    if (n.noteId === "b") host.notesById.b.body = "edited meanwhile";
    return out;
  };
  await assert.rejects(c.addMemberAndReencrypt("family", { login: "ada", fpr: ADA }), /changed/);
  assert.equal(host.configText, config);
  assert.equal(host.log.some(([m]) => m === "commit"), false);
});

test("Add member is offered only where the app can list, decrypt and rewrite the group's notes", () => {
  assert.equal(setup().c.canReencrypt(), true);
  assert.equal(setup({ listApis: false }).c.canReencrypt(), false);
});

test("Stop sharing removes their rows and commits the config; nothing is re-encrypted", async () => {
  let config = addGroup("", "family", [{ login: "o", fpr: ME }]);
  config = addMember(config, "family", { login: "ada", fpr: ADA });
  const { host, c } = setup({ config, notes: { a: encNote("A", "family", "alpha") } });
  assert.equal(await c.stopSharing("family", "ada"), true);
  assert.deepEqual(groupSigners(host.configText, "family"), [ME]);
  assert.deepEqual(host.log.at(-1), ["commit", [CONFIG_PATH], "Stop sharing family with @ada"]);
  assert.equal(host.log.some(([m]) => m === "encrypt" || m === "writeBody"), false);
  assert.equal(await c.stopSharing("family", "ada"), false);
});

test("New group lists your signing and backup keys under your login", async () => {
  const { host, c } = setup();
  await c.newGroup("team", "o");
  assert.deepEqual(groupsOf(host.configText), { team: [`o:${ME}`, `o:${BACKUP}`] });
  assert.deepEqual(host.log.at(-1), ["commit", [CONFIG_PATH], "Add encryption group team"]);
  await assert.rejects(c.newGroup("team", "o"), /already a group/);
});

test("the Encrypt dialog's groups are those listing one of your keys, Only me apart", async () => {
  let config = addGroup("", "only-o", [{ login: "o", fpr: ME }]);
  config = addGroup(config, "family", [{ login: "o", fpr: BACKUP }]);
  config = addGroup(config, "work", [{ login: "boss", fpr: BOSS }]);
  const { c } = setup({ config });
  const ctx = await c.context();
  assert.equal(ctx.keys.login, "o");
  assert.deepEqual(c.yourGroups(ctx.md, ctx.own, ctx.keys.login), ["family"]);
});

test("the network warning lists the other enabled plugins that may reach it", async () => {
  const { host, c } = setup();
  assert.equal(await c.networkedPlugins(), null);
  host.plugins = {
    list: async () => [
      { id: "mahfouz/encryption", label: "Encryption", enabled: true, networked: true },
      { id: "mahfouz/notion", label: "Notion", enabled: true, networked: true },
      { id: "mahfouz/mermaid", label: "Mermaid", enabled: true, networked: false },
      { id: "x/y", label: "Off", enabled: false, networked: true },
    ],
  };
  assert.deepEqual(await c.networkedPlugins(), ["Notion"]);
});

/** A 0.12.1 host recording what `activate` registers. */
function activatedHost(extra = {}) {
  const registered = { commands: [], toolbar: [], codecs: [], settingsTabs: [], unlockers: [], opened: [] };
  const host = {
    ...fakeHost(),
    registerBodyCodec: (codec) => registered.codecs.push(codec),
    registerCommand: (cmd) => registered.commands.push(cmd),
    registerToolbarItem: (item) => registered.toolbar.push(item),
    registerSettingsTab: (tab) => (registered.settingsTabs.push(tab), { dispose() {} }),
    openSettingsTab: (id) => registered.opened.push(id),
    registerVaultUnlocker: (u) => (registered.unlockers.push(u), { dispose() {} }),
    ui: { openDialog: () => ({ close() {} }), confirm: async () => false },
    ...extra,
  };
  activate(host);
  return { host, registered };
}

test("activate registers the codec, a Settings tab, the commands and the toolbar toggles, with no default shortcuts", () => {
  const { registered } = activatedHost({ git: { forceCheckout: async () => [] } });
  assert.equal(registered.codecs.length, 1);
  assert.deepEqual(registered.settingsTabs.map((t) => [t.id, t.label]), [["encryption", "Encryption"]]);
  assert.deepEqual(
    registered.commands.map((c) => [c.id, c.label, !!c.noteMenu, c.palette !== false, typeof c.when]),
    [
      ["encrypt", "Encrypt…", true, false, "function"],
      ["decrypt", "Decrypt…", true, false, "function"],
      ["encrypt-note", "Encrypt note", false, true, "function"],
      ["decrypt-note", "Decrypt note", false, true, "function"],
      ["settings", "Encryption settings", false, true, "undefined"],
      ["unlock-vault", "Unlock vault", false, true, "function"],
    ]
  );
  assert.ok(registered.commands.every((c) => !c.shortcut));
  assert.deepEqual(registered.toolbar.map((t) => [t.kind, t.id, !!t.shortcut]), [
    ["toggle", "lock", false],
    ["toggle", "unlock", false],
  ]);
  assert.deepEqual(registered.unlockers.map((u) => u.label), ["Unlock"]);
  registered.commands.find((c) => c.id === "settings").run();
  assert.deepEqual(registered.opened, ["encryption"]);
  deactivate();
});

test("activate leaves Unlock out where the app can't check a vault out again", () => {
  const { registered } = activatedHost();
  assert.equal(registered.commands.some((c) => c.id === "unlock-vault"), false);
  assert.equal(registered.unlockers.length, 0);
  deactivate();
});

test("an app without plugin dialogs and Settings tabs gets the codec alone", () => {
  const { registered } = activatedHost({ ui: {}, registerSettingsTab: undefined });
  assert.equal(registered.codecs.length, 1);
  assert.equal(registered.commands.length + registered.toolbar.length + registered.settingsTabs.length, 0);
  deactivate();
});

test("activate does nothing where the app can't decrypt (the web)", () => {
  let touched = false;
  const host = { ...fakeHost(), registerCommand: () => (touched = true), registerToolbarItem: () => (touched = true) };
  activate(host);
  assert.equal(touched, false);
  deactivate();
});

// ---- commitFiles' {committed, skipped} --------------------------------------------------

test("skippedOf reads commitFiles' result, and an older app's boolean as nothing skipped", () => {
  assert.deepEqual(skippedOf({ committed: true, skipped: ["a.md"] }), ["a.md"]);
  assert.deepEqual(skippedOf({ committed: false, skipped: [] }), []);
  assert.deepEqual(skippedOf(true), []);
  assert.deepEqual(skippedOf(undefined), []);
});

test("Add member tells the user about the disk-only notes commitFiles left out", async () => {
  const config = addGroup("", "family", [{ login: "o", fpr: ME }]);
  const notes = { a: encNote("A", "family", "alpha"), b: encNote("B", "family", "beta") };
  const { host, c } = setup({ config, notes, keyring: [ME, BACKUP, ADA], diskOnly: ["B.md"] });
  assert.equal(await c.addMemberAndReencrypt("family", { login: "ada", fpr: ADA }), 2);
  assert.deepEqual(host.log.find(([m]) => m === "commit"), ["commit", ["A.md", "B.md", CONFIG_PATH], "Add @ada to family"]);
  assert.deepEqual(host.log.filter(([m]) => m === "toast"), [["toast", "1 note wasn't committed: it's disk-only on this Mac."]]);
});

test("a config-only commit with nothing skipped says nothing", async () => {
  const { host, c } = setup();
  await c.newGroup("team", "o");
  assert.equal(host.log.some(([m]) => m === "toast"), false);
});

// ---- whole-vault encryption ---------------------------------------------------------------

/** A host with `git.renormalize` and `git.forceCheckout`, logged. */
function vaultSetup(opts = {}) {
  const s = setup(opts);
  s.host.git = {
    renormalize: async (message) => {
      s.host.log.push(["renormalize", message]);
      if (opts.renormalizeFails) throw new Error("Some files have changes that aren't committed");
      return true;
    },
    forceCheckout: async () => {
      s.host.log.push(["forceCheckout"]);
      return ["a.md"];
    },
  };
  return s;
}
const vaultCalls = (host) =>
  host.log.map(([m]) => m).filter((m) => ["vaultStatus", "renormalize", "initVault", "unlockVault", "lockVault", "forceCheckout", "commit", "addVaultMember", "removeVaultMember"].includes(m));

test("Encrypt vault: a renormalize first, then initVault for your keys, then the renormalize that commits it", async () => {
  const { host, c } = vaultSetup();
  const init = await c.encryptVault({ history: "now" });
  assert.deepEqual(vaultCalls(host), ["vaultStatus", "renormalize", "initVault", "renormalize", "vaultStatus"]);
  assert.deepEqual(host.vaultRpc.state.members, [ME, BACKUP]);
  assert.ok(init.paths.includes(".gitattributes"), "the sidecar wrote the root .gitattributes");
  assert.deepEqual(host.log.filter(([m]) => m === "renormalize").map(([, msg]) => msg), ["Commit before encrypting the vault", "Encrypt vault"]);
  // Nothing went through commitFiles: renormalize stages .gitattributes and .git-crypt/ itself.
  assert.equal(host.log.some(([m]) => m === "commit"), false);
  assert.equal(c.isVaultLocked(), false);
  await assert.rejects(c.encryptVault(), /already encrypted/);
});

test("Encrypt vault: a dirty tree stops it before initVault", async () => {
  const { host, c } = vaultSetup({ renormalizeFails: true });
  await assert.rejects(c.encryptVault(), /aren't committed/);
  assert.equal(host.log.some(([m]) => m === "initVault"), false);
});

test("Encrypt vault refuses a vault using Git LFS before anything changes", async () => {
  const { host, c } = vaultSetup({ vault: { usesLfs: true } });
  await assert.rejects(c.encryptVault(), (err) => err.message === LFS_TEXT);
  assert.deepEqual(vaultCalls(host), ["vaultStatus"]);
});

test("vaultFeatures offers only what the app has an API for; Encrypt from now on always", () => {
  const { host, c } = vaultSetup();
  assert.deepEqual(c.vaultFeatures(), {
    encrypt: true,
    lock: true,
    unlock: true,
    move: false,
    rewrite: false,
    now: true,
    nameById: false,
    renameExisting: false,
  });
  host.repo = { moveToNewPrivate: async () => {} };
  host.git.rewriteHistory = async () => true;
  host.settings = { setNewNoteNaming: async () => {}, setCommitMessageNaming: async () => {} };
  assert.deepEqual(c.vaultFeatures(), { ...c.vaultFeatures(), move: true, rewrite: true, nameById: true });
  const bare = setup().c.vaultFeatures();
  assert.deepEqual([bare.encrypt, bare.lock, bare.unlock], [false, false, false]);
});

test("Encrypt vault: naming by id, then the history option through the app, which asks and pushes", async () => {
  for (const [history, expected] of [
    ["move", ["setNewNoteNaming id", "setCommitMessageNaming none", "moveToNewPrivate Diary-encrypted"]],
    ["rewrite", ["setNewNoteNaming id", "setCommitMessageNaming none", "rewriteHistory Encrypt vault"]],
    ["now", ["setNewNoteNaming id", "setCommitMessageNaming none"]],
  ]) {
    const { host, c } = vaultSetup({ vault: { hasRemote: true } });
    const calls = [];
    host.repo = { moveToNewPrivate: async (name) => void calls.push(`moveToNewPrivate ${name}`) };
    host.git.rewriteHistory = async (message) => (calls.push(`rewriteHistory ${message}`), true);
    host.settings = {
      setNewNoteNaming: async (v) => void calls.push(`setNewNoteNaming ${v}`),
      setCommitMessageNaming: async (v) => void calls.push(`setCommitMessageNaming ${v}`),
    };
    await c.encryptVault({ history });
    assert.deepEqual(calls, expected, history);
    assert.equal(host.vaultRpc.state.encrypted, true);
  }
});

test("Unlock calls unlockVault, then forceCheckout", async () => {
  const { host, c } = vaultSetup({ vault: { encrypted: true, members: [ME] } });
  await c.vaultStatus();
  assert.equal(c.isVaultLocked(), true);
  assert.deepEqual(await c.unlockVault(), ["a.md"]);
  assert.deepEqual(vaultCalls(host), ["vaultStatus", "unlockVault", "forceCheckout", "vaultStatus"]);
  assert.equal(c.isVaultLocked(), false);
});

test("Unlock with no member key names your fingerprint, and checks nothing out", async () => {
  const { host, c } = vaultSetup({ vault: { encrypted: true, members: [BOSS], memberKey: false } });
  await assert.rejects(c.unlockVault(), (err) => err.code === "noMemberKey" && err.fpr === ME && err.message.includes(formatFpr(ME)));
  assert.equal(host.log.some(([m]) => m === "forceCheckout"), false);
});

test("Lock commits what's pending, then locks and checks out; a dirty tree refuses before the key goes", async () => {
  const dirty = vaultSetup({ vault: { encrypted: true, unlocked: true, members: [ME] }, renormalizeFails: true });
  await assert.rejects(dirty.c.lockVault(), /aren't committed/);
  assert.equal(dirty.host.vaultRpc.state.unlocked, true);
  assert.equal(dirty.host.log.some(([m]) => m === "lockVault" || m === "forceCheckout"), false);

  const untracked = vaultSetup({ vault: { encrypted: true, unlocked: true, members: [ME], dirty: true } });
  await assert.rejects(untracked.c.lockVault(), /uncommitted/);
  assert.equal(untracked.host.log.some(([m]) => m === "forceCheckout"), false);

  const { host, c } = vaultSetup({ vault: { encrypted: true, unlocked: true, members: [ME] } });
  await c.lockVault();
  assert.deepEqual(vaultCalls(host), ["renormalize", "lockVault", "forceCheckout", "vaultStatus"]);
  assert.equal(c.isVaultLocked(), true);
});

test("vault members add and remove commit the paths the sidecar returns", async () => {
  const { host, c } = vaultSetup({ vault: { encrypted: true, unlocked: true, members: [ME, BACKUP] } });
  await c.addVaultMember({ login: "ada", fpr: ADA });
  assert.deepEqual(host.log.find(([m]) => m === "commit"), ["commit", [`.git-crypt/keys/default/0/${ADA}.gpg`], "Add @ada to the vault's keys"]);
  await c.removeVaultMember(ADA, "ada");
  assert.deepEqual(host.log.filter(([m]) => m === "commit").at(-1), ["commit", [`.git-crypt/keys/default/0/${ADA}.gpg`], "Remove @ada from the vault's keys"]);
  assert.deepEqual(host.vaultRpc.state.members, [ME, BACKUP]);
});

test("vault members get their logins from the config's rows, else show the fingerprint only", () => {
  const config = addGroup("", "family", [{ login: "o", fpr: ME }, { login: "ada", fpr: ADA }]);
  const { c } = setup();
  assert.deepEqual(c.vaultMembers(config, [ME, ADA, BOSS], [ME, BACKUP]), [
    { fpr: ME, login: "o", you: true },
    { fpr: ADA, login: "ada", you: false },
    { fpr: BOSS, login: "", you: false },
  ]);
});

// ---- terms ------------------------------------------------------------------------------

test("parseTerms: the first heading is the title, bullets join their indented lines, the rest are paragraphs", () => {
  const md = "## Limits\n\nIntro line\nstill intro.\n\n- one\n  more of one\n* two\n\nAfter.\n### Next\n- three\r\n";
  assert.deepEqual(parseTerms(md), {
    title: "Limits",
    blocks: [
      { type: "p", text: "Intro line still intro." },
      { type: "ul", items: ["one more of one", "two"] },
      { type: "p", text: "After." },
      { type: "h", text: "Next" },
      { type: "ul", items: ["three"] },
    ],
  });
  assert.deepEqual(parseTerms(""), { title: null, blocks: [] });
  // Bidi overrides and zero-width characters are dropped, as the app drops them.
  assert.deepEqual(parseTerms("\uFEFF## Ti\u200Btle\n- a\u202Eb\u2066c\u2060\n"), { title: "Title", blocks: [{ type: "ul", items: ["abc"] }] });
});

test("the shipped terms are the manifest's, a title and git-crypt's five limits", () => {
  const manifest = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.terms, "terms.md");
  const terms = parseTerms(readFileSync(new URL(`./${manifest.terms}`, import.meta.url), "utf8"));
  assert.equal(terms.title, "What git-crypt doesn't protect");
  assert.equal(terms.blocks.length, 1);
  assert.equal(terms.blocks[0].items.length, 5);
});

test("loadTerms reads the file plugin.json declares, next to the module, uncached", async () => {
  const base = "http://127.0.0.1:9/mahfouz/encryption/index.js?v=3";
  const seen = [];
  const files = { "plugin.json": JSON.stringify({ terms: "limits.md" }), "limits.md": "## T\n- a\n" };
  const fetchFn = async (url, opts) => {
    seen.push([String(url), opts.cache]);
    const name = new URL(url).pathname.split("/").pop();
    const body = files[name];
    return { ok: body != null, status: body != null ? 200 : 404, json: async () => JSON.parse(body), text: async () => body };
  };
  assert.deepEqual(await loadTerms(base, fetchFn), { title: "T", blocks: [{ type: "ul", items: ["a"] }] });
  assert.deepEqual(seen, [
    ["http://127.0.0.1:9/mahfouz/encryption/plugin.json", "no-store"],
    ["http://127.0.0.1:9/mahfouz/encryption/limits.md", "no-store"],
  ]);
  files["plugin.json"] = "{}";
  await assert.rejects(loadTerms(base, fetchFn), /declares no terms/);
  files["plugin.json"] = JSON.stringify({ terms: "gone.md" });
  await assert.rejects(loadTerms(base, fetchFn), /gone\.md: HTTP 404/);
});
