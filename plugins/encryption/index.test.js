// Run with `npm test` (node --test) from the repo root. No DOM, no gpg and
// no network: the host and its sidecar are fakes, and the config fixtures
// are the app's own (src/core/src/crypto/decrypt.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
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
  STORAGE_KEY,
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
function fakeHost({ config = "", notes = {}, keyring = [ME, BACKUP], github = {}, listApis = true } = {}) {
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
      commitFiles: async (paths, message) => {
        log.push(["commit", paths, message]);
        return true;
      },
    },
    progress: () => {},
    toast: (m) => log.push(["toast", m]),
  };
  return host;
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
  await assert.rejects(c.codec.decode(ctx), /earlier version/);
  assert.equal(await c.codec.decode({ ...ctx, decryptNote: async () => "secret" }), "secret");
  assert.equal(c.isUnlocked(ref("n1")), true);

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
  assert.equal(c.statusOf(ref("n1")), undefined);
  await new Promise((r) => setTimeout(r));
  assert.equal(c.isPlain(ref("n1")), true);

  assert.equal(await c.encryptNote(ref("n1"), { onlyMe: true, login: "o" }), "only-o");
  assert.deepEqual(groupSigners(host.configText, "only-o"), [ME, BACKUP]);
  assert.deepEqual(host.encrypts.at(-1).recipients, [ME, BACKUP]);
  assert.equal(host.notesById.n1.attributes.encrypted, "only-o");
  assert.deepEqual(
    host.log.filter(([m]) => m === "config.write" || m === "setEncryption").map(([m]) => m),
    ["config.write", "setEncryption"]
  );
  assert.equal(c.isPlain(ref("n1")), false);
  assert.equal(c.isUnlocked(ref("n1")), false);
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

test("Decrypt writes the unlocked plaintext, only while the file still holds what it came from", async () => {
  const note = encNote("Diary", "family", "dear diary");
  const { host, c } = setup({ config: addGroup("", "family", [{ login: "o", fpr: ME }]), notes: { n: note } });
  await assert.rejects(c.decryptPlan(ref("n")), /Unlock “Diary” first/);
  await c.codec.decode({ vaultId: "v", noteId: "n", path: "Diary.md", group: "family", armored: note.body, decryptNote: async () => "dear diary" });
  const plan = await c.decryptPlan(ref("n"));
  await c.decryptNote(ref("n"), plan);
  assert.equal(host.notesById.n.body, "dear diary");
  assert.equal(host.notesById.n.attributes.encrypted, undefined);
  assert.equal(c.isPlain(ref("n")), true);

  // Re-encrypted elsewhere since the unlock: refused.
  const other = encNote("Other", "family", "b");
  host.notesById.o = other;
  await c.codec.decode({ vaultId: "v", noteId: "o", path: "Other.md", group: "family", armored: other.body, decryptNote: async () => "b" });
  other.body = armorOf("b2", [ME]);
  await assert.rejects(c.decryptPlan(ref("o")), /Unlock “Other” first/);
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

test("Add member needs the app to list and decrypt the group's notes", async () => {
  const { c } = setup({ listApis: false, config: addGroup("", "family", [{ login: "o", fpr: ME }]) });
  assert.equal(await c.groupNotes("family"), null);
  await assert.rejects(c.addMemberAndReencrypt("family", { login: "ada", fpr: ADA }), /can't re-encrypt notes/);
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

test("activate registers the codec, the commands and the toolbar toggles, with no default shortcuts", () => {
  const registered = { commands: [], toolbar: [], codecs: [] };
  const host = {
    ...fakeHost(),
    registerBodyCodec: (codec) => registered.codecs.push(codec),
    registerCommand: (cmd) => registered.commands.push(cmd),
    registerToolbarItem: (item) => registered.toolbar.push(item),
    ui: { openOverlay: () => () => {} },
  };
  host.vault.onClose = () => ({ dispose() {} });
  activate(host);
  assert.equal(registered.codecs.length, 1);
  assert.deepEqual(
    registered.commands.map((c) => [c.id, c.label, !!c.noteMenu]),
    [
      ["encrypt", "Encrypt…", true],
      ["decrypt", "Decrypt…", true],
      ["encrypt-note", "Encrypt note", false],
      ["decrypt-note", "Decrypt note", false],
      ["settings", "Encryption settings", false],
    ]
  );
  assert.ok(registered.commands.every((c) => !c.shortcut));
  assert.deepEqual(registered.toolbar.map((t) => [t.kind, t.id, !!t.shortcut]), [
    ["toggle", "lock", false],
    ["toggle", "unlock", false],
  ]);
  deactivate();
});

test("activate does nothing where the app can't decrypt (the web)", () => {
  let touched = false;
  const host = { ...fakeHost(), registerCommand: () => (touched = true), registerToolbarItem: () => (touched = true) };
  activate(host);
  assert.equal(touched, false);
  deactivate();
});
