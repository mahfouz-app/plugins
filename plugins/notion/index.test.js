// Run with `npm test` (node --test) from the repo root. No dependencies and
// no network: `fixtures/workspace.json` holds Notion API responses (version
// 2025-09-03 shapes) keyed by request, served by a fake `ctx.http`, and a
// fake clock stands in for the rate limiter's waits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  idFromLink,
  activate,
  API_BASE,
  createClient,
  createNotionImporter,
  escapeText,
  localDate,
  MIN_INTERVAL_MS,
  NOTION_VERSION,
  notionId,
  notionIdFromUrl,
  safeUrl,
  stableHash,
} from "./index.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/workspace.json", import.meta.url), "utf8"));
const ids = Object.fromEntries(Object.entries(FIXTURE.ids).map(([k, v]) => [k, notionId(v)]));
/** An attachment's ref: a hash of where it is, `block:<id>` or `property:<page>:<prop>:<index>`. */
const fileRef = (where) => `f-${stableHash(where)}`;
const B = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = { "content-type": "application/json" };
const ok = (body) => ({ status: 200, headers: json, body });
const emptyList = { object: "list", results: [], next_cursor: null, has_more: false };

/** The fixture key a request is served by: method, path without /v1, and its cursor/block_id query. */
function keyOf(spec) {
  const u = new URL(spec.url);
  const q = [...u.searchParams].filter(([k]) => k !== "page_size");
  if (spec.method === "POST" && spec.body) {
    const b = JSON.parse(spec.body);
    if (b.start_cursor) q.push(["start_cursor", b.start_cursor]);
  }
  q.sort();
  const path = `${spec.method} ${u.pathname.replace(/^\/v1/, "")}`;
  return q.length ? `${path}?${q.map(([k, v]) => `${k}=${v}`).join("&")}` : path;
}

/**
 * A fake `ctx.http`: `overrides` (key → response, list of responses served
 * in turn, or function) first, then the fixture. Comments nobody recorded
 * are an empty list; anything else unrecorded fails the test.
 */
function fakeHttp(overrides = {}, { clock } = {}) {
  const calls = [];
  const served = new Map();
  return {
    calls,
    keys: () => calls.map(keyOf),
    async request(spec) {
      calls.push({ ...spec, at: clock?.t });
      const key = keyOf(spec);
      let r = overrides[key];
      if (Array.isArray(r)) {
        const n = served.get(key) ?? 0;
        served.set(key, n + 1);
        r = r[Math.min(n, r.length - 1)];
      }
      if (r === undefined && overrides["*"]) r = overrides["*"];
      if (typeof r === "function") r = r(spec, key);
      if (r) return r;
      if (FIXTURE.routes[key]) return FIXTURE.routes[key];
      if (key.startsWith("GET /comments")) return ok(emptyList);
      throw new Error(`unrecorded request: ${key}`);
    },
  };
}

function fakeClock() {
  const clock = { t: Date.parse("2025-10-10T00:00:00Z"), slept: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms, signal) => {
    if (signal?.aborted) {
      const err = new Error("cancelled");
      err.name = "AbortError";
      throw err;
    }
    clock.slept.push(ms);
    clock.t += ms;
  };
  return clock;
}

/**
 * The app's side of a streaming import, simplified: `scan`, then `run` with
 * every root picked (or `roots`), each batch collected and checked as the
 * app's `checkBatch` checks it (a refused batch rejects `emit` with an
 * `ImportPlanError`, which doesn't stop the run). `resume`: a cursor (or
 * `{ cursor: null }`) and the source ids already in the vault. `stopAfter`:
 * the app stops the run after that many emits with pages, as Stop does
 * (the signal aborts, then `emit` and `flush` reject with an AbortError).
 * `refuse(batch)`: true refuses that batch.
 */
async function streamImport(importer, ctx, { roots, resume = null, written = [], stopAfter = Infinity, refuse = () => false } = {}) {
  const scan = await importer.scan(ctx);
  const batches = [];
  const isWritten = new Set(written);
  const emittedIds = new Set();
  const stopper = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, stopper.signal]) : stopper.signal;
  const stoppedError = () => Object.assign(new Error("The import was stopped."), { name: "AbortError" });
  const planError = (msg) => Object.assign(new Error(msg), { name: "ImportPlanError" });
  await importer.run({
    ...ctx,
    signal,
    roots: roots ?? scan.roots.map((r) => r.sourceId),
    resume,
    isWritten: (id) => isWritten.has(id),
    emit: async (batch) => {
      if (stopper.signal.aborted) throw stoppedError();
      // The app's checkBatch, in what concerns the plugin.
      if (batch.cursor === undefined) throw planError("A batch's cursor is undefined.");
      if (new TextEncoder().encode(JSON.stringify(batch.cursor)).length > 1024 * 1024) throw planError("The cursor is over 1 MB.");
      const inBatch = new Set();
      for (const page of batch.pages) {
        if (typeof page.hasChildren !== "boolean") throw planError(`${page.title}: hasChildren isn't a boolean.`);
        if (inBatch.has(page.sourceId)) throw planError(`${page.title} is in the batch twice.`);
        const parentKnown = page.parent === null || inBatch.has(page.parent) || emittedIds.has(page.parent) || isWritten.has(page.parent);
        if (!parentKnown) throw planError(`${page.title}'s parent comes later, or never.`);
        inBatch.add(page.sourceId);
      }
      if (refuse(batch)) throw planError("Refused.");
      for (const id of inBatch) emittedIds.add(id);
      batches.push(batch);
      if (batches.filter((b) => b.pages.length > 0).length >= stopAfter) stopper.abort();
    },
    flush: async () => {
      if (stopper.signal.aborted) throw stoppedError();
    },
  });
  return { scan, batches };
}

/** The batches as a nested plan (pages under their parent, a database's rows its children), as the app writes them. */
function planOf(scan, batches) {
  const byId = new Map();
  const pages = [];
  const order = [];
  for (const b of batches) {
    for (const node of b.pages) {
      const { parent, hasChildren, ...rest } = node;
      const known = byId.get(node.sourceId);
      // Emitted again on a resume (a database): kept once.
      if (known) continue;
      const page = { ...rest, children: [] };
      byId.set(node.sourceId, page);
      order.push({ page, parent });
    }
  }
  for (const { page, parent } of order) {
    if (parent === null) pages.push(page);
    else if (byId.has(parent)) byId.get(parent).children.push(page);
    else pages.push(page);
  }
  const people = [...scan.people];
  for (const b of batches) for (const p of b.people ?? []) if (!people.some((x) => x.id === p.id)) people.push(p);
  return {
    version: 1,
    pages,
    attachments: batches.flatMap((b) => b.attachments),
    people,
    warnings: [...scan.warnings, ...batches.flatMap((b) => b.warnings ?? [])],
    links: Object.assign({}, ...batches.map((b) => b.links ?? {})),
    closed: batches.flatMap((b) => b.closed ?? []),
  };
}

async function runImport({ overrides = {}, options = { comments: true }, signal = new AbortController().signal, onProgress, roots, resume, written, stopAfter, refuse } = {}) {
  const clock = fakeClock();
  const http = fakeHttp(overrides, { clock });
  const progress = [];
  const importer = createNotionImporter({ sleep: clock.sleep, now: clock.now, timeZone: "UTC" });
  const ctx = {
    http,
    signal,
    options,
    progress: (detail, percent) => {
      progress.push(detail);
      onProgress?.(detail, percent);
    },
  };
  const { scan, batches } = await streamImport(importer, ctx, { roots, resume, written, stopAfter, refuse });
  return { plan: planOf(scan, batches), scan, batches, http, clock, progress, importer };
}

const find = (pages, title) => {
  for (const p of pages) {
    if (p.title === title) return p;
    const inner = find(p.children, title);
    if (inner) return inner;
  }
  return null;
};

const all = (pages, out = []) => {
  for (const p of pages) {
    out.push(p);
    all(p.children, out);
  }
  return out;
};

// The reference pattern the app reads (refs.ts) and its id pattern.
const REF_RE = /(!?)\[((?:\\.|[^\\[\]\n])*)\]\(mahfouz-import:([^/()\s]*)\/([^()\s]*)\)/g;
const REF_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The app's rewrite, simplified: people by `logins` (else their escaped name), pages and files by fixed targets. */
function rewrite(text, plan, logins) {
  return text.replace(REF_RE, (whole, bang, label, kind, id) => {
    if (kind === "person") {
      const p = plan.people.find((x) => x.id === id);
      if (!p) return label;
      return logins[id] ? `@${logins[id]}` : p.name.replace(/[\\`*_[\]<>#|{}~@&$=!]/g, "\\$&");
    }
    if (kind === "page") return `[[/x/${id.slice(0, 6)}|T]]`;
    return `${bang}[${label}](/files/${id})`;
  });
}

// `parseTaskLine` from the app (src/core/src/tasks/parse.ts), mirrored.
const CHECKBOX_RE = /^\s*(?:[-*+]\s+)?\[([ xX]?)\]\s*/;
const TOKENS_RE = /^(.*?\S)((?:[ \t]+@([\w-]+))?[ \t]+\/\/[ \t]+(\d{4})-(\d{2})-(\d{2})(?:[ \t]+(\d{2}):(\d{2}))?)\s*$/;
function parseTaskLine(line) {
  const box = CHECKBOX_RE.exec(line);
  if (!box) return null;
  const m = TOKENS_RE.exec(line.slice(box[0].length));
  if (!m) return null;
  return { checked: box[1] !== " " && box[1] !== "", title: m[1].trim(), assignee: m[3] ?? null, date: `${m[4]}-${m[5]}-${m[6]}`, time: m[7] ? `${m[7]}:${m[8]}` : null };
}

/** The app's `checkPlan` (src/core/src/import/write.ts), mirrored, plus the reference invariants. */
/**
 * `outside`: a partial import (a page link), whose page references may name
 * pages it didn't import; the app writes those as plain text.
 */
function assertValidPlan(plan, { outside = false } = {}) {
  assert.equal(plan.version, 1);
  for (const list of [plan.pages, plan.attachments, plan.people, plan.warnings]) assert.ok(Array.isArray(list));
  assert.ok(plan.pages.length > 0);
  const pages = all(plan.pages);
  const sourceIds = new Set();
  for (const p of pages) {
    assert.equal(typeof p.title, "string");
    assert.equal(typeof p.body, "string");
    assert.equal(typeof p.sourceId, "string");
    assert.ok(p.attributes && typeof p.attributes === "object");
    assert.ok(Array.isArray(p.children));
    assert.ok(!sourceIds.has(p.sourceId), `page ${p.sourceId} imported twice`);
    sourceIds.add(p.sourceId);
    assert.doesNotMatch(p.body, /[-]/, "no private markers survive");
    if (p.database) {
      for (const c of p.database.columns) {
        assert.equal(typeof c.key, "string");
        assert.ok(["text", "number", "checkbox", "url", "email", "phone", "date", "datetime", "select", "multiselect", "attachment", "relation"].includes(c.type), c.type);
        // Only a relation between the database's own rows; a pair names each other back.
        assert.equal(c.type === "relation", c.self !== undefined, `${c.key}: self goes with relation only`);
        if (c.self?.oneWay) assert.ok(c.self.reverse === undefined && c.self.reverseLabel === undefined);
        const other = c.self?.reverse !== undefined ? p.database.columns.find((o) => o.key === c.self.reverse) : undefined;
        if (other) assert.equal(other.self?.reverse, c.key, `${c.key}'s reverse names it back`);
      }
      const sub = p.database.subItems;
      if (sub) {
        const named = p.database.columns.find((c) => c.key === sub.key);
        assert.ok(named?.self && (named.self.oneWay || (named.self.reverse !== undefined && named.self.reverse !== named.key)), "sub-items name a one-way or paired self-relation");
      }
      const keys = new Set(p.database.columns.map((c) => c.key));
      for (const row of p.children) for (const k of Object.keys(row.attributes)) assert.ok(keys.has(k), `row attribute ${k} has a column`);
    }
    for (const [k, v] of Object.entries(p.attributes)) {
      if (Array.isArray(v)) for (const s of v) assert.equal(typeof s, "string", k);
      else assert.equal(typeof v, "string", k);
    }
    for (const c of p.comments ?? []) {
      assert.ok(c.anchor === "page" || Number.isInteger(c.anchor.blockIndex));
      for (const e of c.entries) {
        assert.ok(plan.people.some((x) => x.id === e.personId), "every comment author is a person");
        assert.ok(!Number.isNaN(Date.parse(e.date)));
        assert.equal(typeof e.text, "string");
      }
    }
  }
  // Every reference is one this plan made: an imported page, a listed file, a listed person.
  const files = new Set(plan.attachments.map((a) => a.ref));
  const people = new Set(plan.people.map((p) => p.id));
  const texts = pages.flatMap((p) => [
    p.body,
    ...Object.values(p.attributes).flat(),
    ...(p.comments ?? []).flatMap((c) => c.entries.map((e) => e.text)),
  ]);
  for (const t of texts) {
    for (const m of t.matchAll(REF_RE)) {
      const [, , , kind, id] = m;
      assert.match(id, REF_ID_RE);
      // A page the import doesn't write comes with its Notion URL to fall back on.
      if (kind === "page") assert.ok(outside || sourceIds.has(id) || /^https:\/\/www\.notion\.so\//.test(plan.links?.[id]?.url ?? ""), `page ref ${id} is imported or has a fallback`);
      else if (kind === "file") assert.ok(files.has(id), `file ref ${id} is listed`);
      else if (kind === "person") assert.ok(people.has(id), `person ref ${id} is listed`);
      else assert.fail(`unknown reference kind ${kind}`);
    }
  }
}

// ---- activation

test("activate registers the Notion importer, or explains why it can't", () => {
  const registered = [];
  activate({ registerImporter: (i) => registered.push(i), http: { request() {} }, toast() {} });
  assert.equal(registered.length, 1);
  const [imp] = registered;
  assert.equal(imp.id, "notion");
  assert.equal(imp.label, "Notion");
  assert.deepEqual(imp.credential, { label: "Notion integration token", helpUrl: "https://mahfouz.app/guide/import-notion/", secretName: "token" });
  assert.deepEqual(imp.options.map((o) => [o.id, o.type ?? "switch", o.default]), [
    ["page", "text", undefined],
    ["comments", "switch", true],
  ]);
  assert.equal(imp.apiVersion, 2);
  assert.equal(typeof imp.scan, "function");
  assert.equal(typeof imp.run, "function");

  const toasts = [];
  activate({ toast: (m, kind) => toasts.push([m, kind]) });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], "error");
});

test("the manifest lists Notion's hosts and binds the token to the API only", () => {
  const m = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(m.network.hosts, ["api.notion.com", "prod-files-secure.s3.us-west-2.amazonaws.com", "file.notion.so"]);
  assert.deepEqual(m.secrets, { token: { hosts: ["api.notion.com"] } });
  // Self-relation columns and sub-items in a plan: an older app refuses them.
  assert.equal(m.mahfouz, ">=0.27.0");
});

// ---- requests

test("every request goes to api.notion.com with the API version and the token by name", async () => {
  const { http, plan } = await runImport();
  assertValidPlan(plan);
  for (const c of http.calls) {
    assert.ok(c.url.startsWith(`${API_BASE}/`), c.url);
    assert.equal(c.headers["Notion-Version"], NOTION_VERSION);
    assert.equal(c.secret, "token");
    assert.ok(!("Authorization" in c.headers));
    const u = new URL(c.url);
    if (c.method === "GET" && /\/children$|\/users$|\/comments$/.test(u.pathname)) assert.equal(u.searchParams.get("page_size"), "100");
    if (c.method === "POST") assert.equal(JSON.parse(c.body).page_size, 100);
  }
  assert.equal(http.keys()[0], "GET /users/me", "the token is checked first");
});

test("requests are spaced to about three a second", async () => {
  const { http } = await runImport();
  for (let i = 1; i < http.calls.length; i++) assert.ok(http.calls[i].at - http.calls[i - 1].at >= MIN_INTERVAL_MS);
});

test("a 401 on the token check is a clear error", async () => {
  await assert.rejects(
    runImport({ overrides: { "GET /users/me": { status: 401, headers: json, body: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." } } } }),
    (err) => err.name === "NotionError" && err.status === 401 && /didn't accept the token/.test(err.message)
  );
});

test("nothing shared with the integration says how to share", async () => {
  await assert.rejects(runImport({ overrides: { "POST /search": ok(emptyList) } }), /Connections/);
});

test("idFromLink reads a page or database id from Notion's links, or a bare id", () => {
  const id = "1f3a9c0d-2b7e-4a51-9f3a-9c0d2b7e4a51";
  const hex = id.replace(/-/g, "");
  for (const link of [
    `https://www.notion.so/acme/Q4-planning-offsite-${hex}`,
    `https://www.notion.so/Q4-${hex}?pvs=4`,
    `https://www.notion.so/acme/${hex}?v=0000000000000000000000000000000a`,
    `https://www.notion.so/acme/Board-${"0".repeat(32)}?p=${hex}&pm=s`,
    `https://acme.notion.site/Q4-${hex}`,
    `notion.so/${hex}`,
    `  ${hex.toUpperCase()}  `,
    `https://www.notion.so/acme/Q4-${hex}/`,
    `<https://www.notion.so/acme/Q4-${hex}>`,
    `https://www.notion.com/acme/Q4-${hex}`,
    id,
  ]) {
    assert.equal(idFromLink(link), id, link);
  }
  for (const link of ["", "hello", `https://example.com/${hex}`, "https://www.notion.so/acme/No-id-here", "https://notion.so.evil.test/" + hex]) {
    assert.equal(idFromLink(link), null, link);
  }
});

/** Without a search, a link's import reads each data source and page directly: served from the recorded search results. */
const searched = () =>
  ["POST /search", "POST /search?start_cursor=cursor-2"].flatMap((k) => FIXTURE.routes[k].body.results);
const directReads = () =>
  Object.fromEntries(searched().map((o) => [`GET /${o.object === "data_source" ? "data_sources" : `${o.object}s`}/${o.id}`, ok(o)]));

test("a page link imports that page and what's under it, without searching the workspace", async () => {
  const root = searched().find((o) => notionId(o.id) === ids.root);
  const { plan, http, progress } = await runImport({
    options: { comments: true, page: `https://www.notion.so/acme/Team-Wiki-${ids.root}` },
    overrides: { ...directReads(), [`GET /pages/${FIXTURE.ids.root}`]: ok(root) },
  });
  assertValidPlan(plan);
  assert.deepEqual(plan.pages.map((p) => p.title), ["Team Wiki"]);
  assert.deepEqual(plan.pages[0].children.map((p) => p.title), ["In a column", "Guide", "Open", "Archive"]);
  assert.ok(!http.keys().some((k) => k.startsWith("POST /search")));
  assert.ok(progress.includes("Reading the linked page…"));
});

test("a link to a database row imports it as a page, and warns that its properties aren't", async () => {
  const root = searched().find((o) => notionId(o.id) === ids.root);
  const row = { ...root, parent: { type: "data_source_id", data_source_id: FIXTURE.ids.ds1 } };
  const { plan } = await runImport({
    options: { page: FIXTURE.ids.root },
    overrides: { ...directReads(), [`GET /pages/${FIXTURE.ids.root}`]: ok(row) },
  });
  assert.deepEqual(plan.pages.map((p) => p.title), ["Team Wiki"]);
  assert.ok(plan.warnings.some((w) => /row of a database: its properties aren't imported/.test(w)));
});

test("a database link imports that database: one per data source, as a full import does", async () => {
  const notFound = { status: 404, headers: json, body: { object: "error", code: "object_not_found" } };
  const { plan } = await runImport({
    options: { page: FIXTURE.ids.db },
    overrides: { ...directReads(), [`GET /pages/${FIXTURE.ids.db}`]: notFound },
  });
  assertValidPlan(plan, { outside: true });
  assert.deepEqual(plan.pages.map((p) => p.title), ["Open", "Archive"]);
  assert.ok(plan.pages.every((p) => p.database));
});

test("a link to a page the integration can't see says how to share it; a link that isn't Notion's says so", async () => {
  const notFound = { status: 404, headers: json, body: { object: "error", code: "object_not_found" } };
  const other = "2f3a9c0d-2b7e-4a51-9f3a-9c0d2b7e4a51";
  await assert.rejects(
    runImport({
      options: { page: `https://www.notion.so/x-${other.replace(/-/g, "")}` },
      overrides: { [`GET /pages/${other}`]: notFound, [`GET /databases/${other}`]: notFound },
    }),
    /hasn't shared this page with the integration.*Connections/
  );
  await assert.rejects(runImport({ options: { page: "https://example.com/page" } }), /isn't a Notion page link/);
  await assert.rejects(
    runImport({
      options: { page: other },
      overrides: { [`GET /pages/${other}`]: notFound, [`GET /databases/${other}`]: ok({ object: "database", id: other, in_trash: true }) },
    }),
    /in Notion's trash/
  );
});

test("429 waits for Retry-After, and 502/503/504 back off, then the request is retried", async () => {
  const clock = fakeClock();
  const http = fakeHttp(
    {
      "GET /users/me": [
        { status: 429, headers: { "retry-after": "7" }, body: { object: "error", code: "rate_limited" } },
        { status: 503, headers: {}, body: "Service Unavailable" },
        { status: 502, headers: {}, body: "" },
        ok({ object: "user", id: ids.bot }),
      ],
    },
    { clock }
  );
  const client = createClient(http, { sleep: clock.sleep, now: clock.now });
  const me = await client.call("GET", "/users/me");
  assert.equal(me.object, "user");
  assert.equal(http.calls.length, 4);
  assert.ok(http.calls[1].at - http.calls[0].at >= 7000, "waited Retry-After");
  assert.ok(http.calls[2].at - http.calls[1].at >= 1000, "backed off");
  assert.ok(http.calls[3].at - http.calls[2].at > http.calls[2].at - http.calls[1].at, "the backoff grows");
});

test("a 429 that never ends gives up with a message", async () => {
  const clock = fakeClock();
  const http = fakeHttp({ "GET /users/me": { status: 429, headers: { "retry-after": "1" }, body: {} } }, { clock });
  const client = createClient(http, { sleep: clock.sleep, now: clock.now });
  await assert.rejects(client.call("GET", "/users/me"), /slow down/);
  assert.equal(http.calls.length, 7);
});

test("a transport failure or timeout is retried; a refusal from the app is not", async () => {
  const clock = fakeClock();
  const fail = (code) => () => {
    const err = new Error(code);
    err.code = code;
    throw err;
  };
  // Served in turn; the functions throw, as the app's native side rejects.
  const http = fakeHttp({ "GET /users/me": [fail("transport"), fail("timeout"), ok({ object: "user" })] }, { clock });
  const client = createClient(http, { sleep: clock.sleep, now: clock.now });
  assert.equal((await client.call("GET", "/users/me")).object, "user");
  assert.equal(http.calls.length, 3);

  const refused = fakeHttp({ "GET /users/me": fail("host_not_allowed") }, { clock });
  await assert.rejects(createClient(refused, { sleep: clock.sleep, now: clock.now }).call("GET", "/users/me"), (err) => err.code === "host_not_allowed");
  assert.equal(refused.calls.length, 1);
});

test("cancelling stops the import between requests", async () => {
  const controller = new AbortController();
  const clock = fakeClock();
  const http = fakeHttp({}, { clock });
  let atAbort = null;
  const importer = createNotionImporter({ sleep: clock.sleep, now: clock.now, timeZone: "UTC" });
  // The app aborts the signal to stop a run: the importer returns quietly.
  await assert.doesNotReject(
    streamImport(importer, {
      http,
      signal: controller.signal,
      options: { comments: true },
      progress: (detail) => {
        if (detail.startsWith("Page 2 ") && atAbort === null) {
          controller.abort();
          atAbort = http.calls.length;
        }
      },
    })
  );
  assert.ok(atAbort > 0);
  assert.equal(http.calls.length, atAbort, "no request after the abort");
});

test("progress names each page against an estimate", async () => {
  const { progress } = await runImport();
  const pages = progress.filter((p) => p.startsWith("Page "));
  assert.equal(pages[0], "Page 1 of about 7: Team Wiki");
  assert.ok(pages.every((p) => /^Page \d+ of about \d+: .+/.test(p)));
  assert.equal(pages.length, 7);
});

// ---- the tree

test("the tree: roots are the pages whose parent isn't shared; everything else nests", async () => {
  const { plan, http } = await runImport();
  assertValidPlan(plan);
  assert.deepEqual(plan.pages.map((p) => p.title), ["Team Wiki", "Loose page"]);
  const root = plan.pages[0];
  assert.equal(root.sourceId, ids.root);
  // A page under a block (a column) is the root's child, found by walking its blocks.
  assert.deepEqual(root.children.map((p) => p.title), ["In a column", "Guide", "Open", "Archive"]);
  // Root detection climbed from the column page's block parent to the root page.
  assert.ok(http.keys().includes(`GET /blocks/${B(41)}`));
  assert.ok(http.keys().includes(`GET /blocks/${B(40)}`));
  // Pages under a data source are its rows; nothing is imported twice, and the trashed page is skipped.
  assert.deepEqual(find(plan.pages, "Open").children.map((p) => p.title), ["Write docs", "Plan launch"]);
  assert.deepEqual(find(plan.pages, "Archive").children.map((p) => p.title), ["Old idea"]);
  assert.equal(all(plan.pages).length, 9);
  assert.equal(find(plan.pages, "Trashed"), null);
});

test("a page whose parent block can't be read is still imported, as a root", async () => {
  const { plan } = await runImport({
    overrides: {
      [`GET /blocks/${B(41)}`]: { status: 404, headers: json, body: { object: "error", code: "object_not_found" } },
      [`GET /blocks/${B(40)}/children`]: ok(emptyList),
    },
  });
  assertValidPlan(plan);
  assert.deepEqual(plan.pages.map((p) => p.title), ["Team Wiki", "In a column", "Loose page"]);
});

// ---- blocks

test("every block type becomes Markdown, or a warning", async () => {
  const { plan } = await runImport();
  const person = `mahfouz-import:person/${ids.jane}`;
  const guide = `mahfouz-import:page/${ids.child}`;
  assert.equal(
    plan.pages[0].body,
    [
      "# Welcome",
      "Hello **bold** and *italic* ``code`s`` ~~gone~~ [link](https://example.com/a%20b), " +
        `[Jane Doe](${person}) see [Guide](${guide}) on 2025-10-12 where $e=mc^2$. ` +
        "Literal \\*stars\\* \\[x\\](mahfouz-import\\:page/abc) \\@bob \\/\\/ \\#tag \\{++no++\\} \\<b\\>\\\n" +
        `Second line [internal](${guide})`,
      "- Bullet one\n  - Nested\n  - [ ] Nested task // 2025-10-20\n- \\- not a nested list",
      "1. First\n1. Second",
      `- [ ] Ship it by [Jane Doe](${person}) // 2025-10-12 14:30\n` +
        "- [x] 2025-10-14 // 2025-10-14\n" +
        "- [ ] Conference // 2025-11-03\n" +
        "- [ ] Plain item \\/\\/ 2025-01-01\n" +
        "- Details\n\n  Hidden text",
      "> Quoted\n>\n> Quote child",
      "> 💡 Tip",
      "````javascript\nconst a = 1;\n```\nlet b;\n````",
      "$$\\int_0^1 x\\,dx = \\frac12$$",
      "---",
      `| Name | Value |\n| --- | --- |\n| a\\|b | [Guide](${guide}) |`,
      "Left",
      "Right",
      `[Guide](${guide})`,
      `![A diagram](mahfouz-import:file/${fileRef(`block:${notionId(B(20))}`)})`,
      "[report.pdf](https://example.com/report.pdf)",
      "[https://example.com/bookmark](https://example.com/bookmark)",
      "[Video](https://example.com/embed)",
      "Synced text",
      "## Toggle heading",
      "Under the heading",
      "Last words",
    ].join("\n\n")
  );
  for (const w of [
    "Tables of contents aren't imported.",
    "Blocks Notion's API doesn't support aren't imported.",
    "A synced block's original isn't shared with the integration, so its copy was left out.",
    "Page icons and covers aren't imported.",
  ]) {
    assert.ok(plan.warnings.includes(w), w);
  }
  // A synced copy reads its original's children.
  assert.ok(find(plan.pages, "Team Wiki").body.includes("Synced text"));
});

test("a table without a header row gets an empty one; a heading and code stay on their lines", async () => {
  const { plan } = await runImport({
    overrides: {
      [`GET /blocks/${FIXTURE.ids.other}/children`]: ok({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [
          { object: "block", id: B(80), type: "table", has_children: true, table: { table_width: 2, has_column_header: false, has_row_header: false } },
          { object: "block", id: B(81), type: "heading_3", has_children: false, heading_3: { rich_text: [{ type: "text", text: { content: "1. Not\na list" }, plain_text: "1. Not\na list" }] } },
          { object: "block", id: B(82), type: "code", has_children: false, code: { language: "plain text", rich_text: [{ type: "text", text: { content: "x" }, plain_text: "x" }] } },
          { object: "block", id: B(83), type: "paragraph", has_children: false, paragraph: { rich_text: [{ type: "text", text: { content: "+ plus\n2) two\n=== eq" }, plain_text: "" }] } },
        ],
      }),
      [`GET /blocks/${B(80)}/children`]: ok({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [{ object: "block", id: B(84), type: "table_row", has_children: false, table_row: { cells: [[{ type: "text", text: { content: "only" }, plain_text: "only" }]] } }],
      }),
    },
  });
  assert.equal(find(plan.pages, "Loose page").body, "| | |\n| --- | --- |\n| only |   |\n\n### 1\\. Not a list\n\n```\nx\n```\n\n\\+ plus\\\n2\\) two\\\n\\=\\== eq");
});

// ---- mentions

test("mentions: people and pages become references, dates local text, links links", async () => {
  const rich = [
    { type: "mention", mention: { type: "user", user: { object: "user", id: FIXTURE.ids.bob } }, plain_text: "@Bob Stone" },
    { type: "text", text: { content: " " }, plain_text: " " },
    { type: "mention", mention: { type: "user", user: { object: "user", id: "e0000000-0000-4000-8000-000000000001" } }, plain_text: "@Guest Person" },
    { type: "text", text: { content: " " }, plain_text: " " },
    { type: "mention", mention: { type: "database", database: { id: FIXTURE.ids.db } }, plain_text: "Tasks" },
    { type: "text", text: { content: " " }, plain_text: " " },
    { type: "mention", mention: { type: "page", page: { id: "f0000000-0000-4000-8000-000000000001" } }, plain_text: "Elsewhere" },
    { type: "text", text: { content: " " }, plain_text: " " },
    { type: "mention", mention: { type: "date", date: { start: "2025-10-12T21:15:00.000-07:00", end: null } }, plain_text: "October 12, 2025 9:15 PM" },
    { type: "text", text: { content: " " }, plain_text: " " },
    { type: "mention", mention: { type: "date", date: { start: "2025-10-12", end: "2025-10-15" } }, plain_text: "October 12, 2025 → October 15, 2025" },
    { type: "text", text: { content: " " }, plain_text: " " },
    { type: "mention", mention: { type: "link_mention", link_mention: { href: "https://github.com/x", title: "x [repo]" } }, plain_text: "x", href: "https://github.com/x" },
    { type: "text", text: { content: " " }, plain_text: " " },
    { type: "mention", mention: { type: "template_mention", template_mention: { type: "template_mention_date" } }, plain_text: "@Today" },
  ];
  const { plan } = await runImport({
    overrides: {
      [`GET /blocks/${FIXTURE.ids.other}/children`]: ok({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [{ object: "block", id: B(90), type: "paragraph", has_children: false, paragraph: { rich_text: rich } }],
      }),
    },
  });
  assertValidPlan(plan);
  assert.equal(
    find(plan.pages, "Loose page").body,
    `[Bob Stone](mahfouz-import:person/${ids.bob}) ` +
      "[Guest Person](mahfouz-import:person/e0000000000040008000000000000001) " +
      // A database mention lands on its first data source's database.
      `[Tasks](mahfouz-import:page/${ids.ds1}) ` +
      // A page outside the import: a reference the app falls back to Notion's URL for.
      "[Elsewhere](mahfouz-import:page/f0000000000040008000000000000001) " +
      "2025-10-13 04:15 2025-10-12 [x \\[repo\\]](https://github.com/x) \\@Today"
  );
  // Someone the users list didn't have is a person by the mention's name.
  assert.deepEqual(plan.people.find((p) => p.id === "e0000000000040008000000000000001"), { id: "e0000000000040008000000000000001", name: "Guest Person" });
  assert.ok(plan.warnings.includes("Date ranges were imported as their start date."));
});

test("dates: an offset moves into the local zone, a date or a floating time stays", () => {
  assert.deepEqual(localDate("2025-10-12", "UTC"), { date: "2025-10-12", time: null });
  assert.deepEqual(localDate("2025-10-12T14:30:00.000+00:00", "America/Los_Angeles"), { date: "2025-10-12", time: "07:30" });
  assert.deepEqual(localDate("2025-10-12T23:30:00.000-07:00", "Europe/Berlin"), { date: "2025-10-13", time: "08:30" });
  assert.deepEqual(localDate("2025-10-12T09:05:00.000", "Asia/Tokyo"), { date: "2025-10-12", time: "09:05" });
  assert.equal(localDate("next week"), null);
});

// ---- tasks

test("tasks: a to-do with a date mention is a task line, mapped or not", async () => {
  const { plan } = await runImport();
  const body = plan.pages[0].body;
  const parse = (logins) =>
    rewrite(body, plan, logins)
      .split("\n")
      .map(parseTaskLine)
      .filter(Boolean);

  // Jane mapped to a login: she's the assignee.
  assert.deepEqual(parse({ [ids.jane]: "jane" }), [
    { checked: false, title: "Nested task", assignee: null, date: "2025-10-20", time: null },
    { checked: false, title: "Ship it by", assignee: "jane", date: "2025-10-12", time: "14:30" },
    // A to-do holding only a date takes the date as its title.
    { checked: true, title: "2025-10-14", assignee: null, date: "2025-10-14", time: null },
    // A range is its start date.
    { checked: false, title: "Conference", assignee: null, date: "2025-11-03", time: null },
  ]);
  // Unmapped, her name stays in the title and the line still parses.
  const unmapped = parse({});
  assert.equal(unmapped[1].title, "Ship it by Jane Doe");
  assert.equal(unmapped[1].assignee, null);
  // "Plain item // 2025-01-01" was typed text, not a date mention: not a task.
  assert.ok(body.includes("- [ ] Plain item \\/\\/ 2025-01-01"));
  assert.equal(parse({}).length, 4);
  // A nested task keeps its indentation.
  assert.ok(body.includes("\n  - [ ] Nested task // 2025-10-20"));
});

// ---- databases

test("databases: one per data source, typed columns, row attributes; a linked database is skipped", async () => {
  const { plan } = await runImport();
  assertValidPlan(plan);
  const open = find(plan.pages, "Open");
  const archive = find(plan.pages, "Archive");
  assert.equal(open.sourceId, ids.ds1);
  assert.equal(archive.sourceId, ids.ds2);
  assert.equal(open.body, "Everything we're doing");
  assert.deepEqual(
    open.database.columns.map((c) => [c.label, c.type, c.options]),
    [
      ["Status", "select", ["Not started", "Done"]],
      ["Tags", "multiselect", ["red", "blue, green"]],
      ["Due", "datetime", undefined],
      ["Due end", "datetime", undefined],
      ["Estimate", "number", undefined],
      ["Done", "checkbox", undefined],
      ["Owner", "text", undefined],
      ["Related", "relation", undefined],
      ["Files", "attachment", undefined],
      ["Score", "number", undefined],
      ["Link", "url", undefined],
      ["Mail", "email", undefined],
      ["Phone", "phone", undefined],
      ["Notes", "text", undefined],
      ["Created", "datetime", undefined],
      ["Author", "text", undefined],
      ["Ticket", "text", undefined],
    ]
  );
  assert.deepEqual(archive.database.columns, [{ key: "nn", label: "Note", type: "text" }]);

  const byLabel = (row) => Object.fromEntries(open.database.columns.filter((c) => c.key in row.attributes).map((c) => [c.label, row.attributes[c.key]]));
  const docs = byLabel(find(plan.pages, "Write docs"));
  assert.equal(docs.Status, "Done");
  assert.deepEqual(docs.Tags, ["red", "blue, green"]);
  assert.equal(docs.Due, "2025-10-12T14:30:00.000+00:00");
  assert.equal(docs["Due end"], "2025-10-13T10:00:00.000+00:00");
  assert.equal(docs.Estimate, "3");
  assert.equal(docs.Done, "true");
  assert.equal(docs.Owner, `[Jane Doe](mahfouz-import:person/${ids.jane})`);
  assert.equal(docs.Files, `[spec.pdf](mahfouz-import:file/${fileRef(`property:${ids.row1}:fl:0`)})`);
  assert.equal(docs.Score, "6");
  assert.equal(docs.Link, "https://example.com");
  assert.equal(docs.Created, "2025-10-01T09:00:00.000Z");
  assert.equal(docs.Author, `[Bob Stone](mahfouz-import:person/${ids.bob})`);
  assert.equal(docs.Ticket, "TASK-7");
  // Text from Notion never forges a reference in an attribute.
  assert.equal(docs.Notes, `See [Guide](mahfouz-import:page/${ids.child}) [x](mahfouz-import​:person/abc)`);
  // The files past the first (and external ones) go in the body.
  assert.equal(find(plan.pages, "Write docs").body, "Row body\n\nFiles: [Site](https://example.com/site)");

  const launch = byLabel(find(plan.pages, "Plan launch"));
  // A date-only value in a datetime column is local midnight; empty values are left out.
  assert.deepEqual(launch, { Status: "Not started", Due: "2025-11-01T00:00", Done: "false", Related: [`[Write docs](mahfouz-import:page/${ids.row1})`] });

  for (const w of [
    'The "Click" column (button) of "Open" isn\'t imported.',
    "Formula and rollup columns of \"Open\" were imported as their current values; they won't recalculate.",
    '"Tasks" has 2 data sources in Notion; each became a database of its own.',
    "The database \"Linked view\" was skipped: it's a linked database (Notion's API can't read those) or it isn't shared with the integration.",
  ]) {
    assert.ok(plan.warnings.includes(w), w);
  }
});

test("property lists past 25 items are paged through the property endpoint", async () => {
  const { plan, http } = await runImport();
  const keys = http.keys();
  assert.ok(keys.includes(`GET /pages/${FIXTURE.ids.row1}/properties/rl`));
  assert.ok(keys.includes(`GET /pages/${FIXTURE.ids.row1}/properties/rl?start_cursor=rel-2`));
  const related = find(plan.pages, "Write docs").attributes.rl;
  assert.equal(related.length, 26);
  // Every one a reference: a page outside the import is labelled with its Notion URL, and falls back to it.
  assert.equal(related[0], "[https://www.notion.so/20000000000040008000000000000001](mahfouz-import:page/20000000000040008000000000000001)");
  assert.deepEqual(plan.links["20000000000040008000000000000001"], { url: "https://www.notion.so/20000000000040008000000000000001" });
  assert.equal(related[25], `[Plan launch](mahfouz-import:page/${ids.row2})`);
});

/**
 * The fixture's second data source ("Archive") with Notion's sub-items: a
 * "Parent item" / "Sub-item" relation pair (names given, or `names`), its
 * one row ("Old idea") the parent of two new rows.
 */
async function subItemsImport({ names = ["Parent item", "Sub-item"] } = {}) {
  const ds = FIXTURE.ids.ds2;
  const search = structuredClone(FIXTURE.routes["POST /search?start_cursor=cursor-2"].body);
  const source = search.results.find((r) => r.id === ds);
  const dual = (name, id) => ({ type: "dual_property", dual_property: { synced_property_name: name, synced_property_id: id } });
  source.properties[names[0]] = { id: "pi", name: names[0], type: "relation", relation: { data_source_id: ds, ...dual(names[1], "si") } };
  source.properties[names[1]] = { id: "si", name: names[1], type: "relation", relation: { data_source_id: ds, ...dual(names[0], "pi") } };
  const query = structuredClone(FIXTURE.routes[`POST /data_sources/${ds}/query`].body);
  const parent = query.results[0];
  const kid = (n, title) => {
    const row = structuredClone(parent);
    row.id = `30000000-0000-4000-8000-00000000000${n}`;
    row.properties.Title.title = [{ type: "text", text: { content: title, link: null }, plain_text: title, href: null }];
    row.properties[names[0]] = { id: "pi", type: "relation", relation: [{ id: parent.id }], has_more: false };
    row.properties[names[1]] = { id: "si", type: "relation", relation: [], has_more: false };
    return row;
  };
  const kids = [kid(1, "First step"), kid(2, "Second step")];
  parent.properties[names[0]] = { id: "pi", type: "relation", relation: [], has_more: false };
  parent.properties[names[1]] = { id: "si", type: "relation", relation: kids.map((k) => ({ id: k.id })), has_more: false };
  query.results.push(...kids);
  const { plan } = await runImport({
    overrides: {
      "POST /search?start_cursor=cursor-2": ok(search),
      [`POST /data_sources/${ds}/query`]: ok(query),
      ...Object.fromEntries(kids.map((k) => [`GET /blocks/${k.id}/children`, ok(emptyList)])),
    },
  });
  return { plan, parent, kids };
}

test("sub-items: the Parent item / Sub-item pair is a paired self-relation, rows stay flat, and the parent side is the database's sub-items", async () => {
  const { plan, parent, kids } = await subItemsImport();
  assertValidPlan(plan);
  const archive = find(plan.pages, "Archive");
  assert.deepEqual(
    archive.database.columns.filter((c) => c.type === "relation"),
    [
      { key: "pi", label: "Parent item", type: "relation", self: { reverse: "si" } },
      { key: "si", label: "Sub-item", type: "relation", self: { reverse: "pi" } },
    ]
  );
  assert.deepEqual(archive.database.subItems, { key: "pi" });
  // Every row is still a row of the database, none nested in another.
  assert.deepEqual(archive.children.map((r) => r.title), ["Old idea", "First step", "Second step"]);
  for (const r of archive.children) assert.deepEqual(r.children, []);
  const ref = (row, title) => `[${title}](mahfouz-import:page/${notionId(row.id)})`;
  assert.deepEqual(find(plan.pages, "First step").attributes.pi, [ref(parent, "Old idea")]);
  assert.deepEqual(find(plan.pages, "Old idea").attributes.si, [ref(kids[0], "First step"), ref(kids[1], "Second step")]);
});

test("sub-items: a pair whose names don't say parent gets no sub-items, as Blocked by / Blocking", async () => {
  for (const names of [["Up", "Down"], ["Blocked by", "Blocking"]]) {
    const { plan } = await subItemsImport({ names });
    assertValidPlan(plan);
    const archive = find(plan.pages, "Archive");
    assert.equal(archive.database.subItems, undefined, names.join(" / "));
    assert.equal(archive.database.columns.find((c) => c.key === "pi").self.reverse, "si");
  }
});

test("sub-items: a parent side that links more than one row isn't taken, and says so", async () => {
  // "Parent of" holds the children: the row "Old idea" links two.
  const { plan } = await subItemsImport({ names: ["Child of", "Parent of"] });
  assertValidPlan(plan);
  assert.equal(find(plan.pages, "Archive").database.subItems, undefined);
  assert.ok(plan.warnings.some((w) => /"Parent of" of "Archive" isn't imported as sub-items: a row links more than one parent/.test(w)), plan.warnings.join("\n"));
});

test("a one-way relation to the database's own rows is a one-way self-relation, with no sub-items", async () => {
  const { plan } = await runImport();
  const open = find(plan.pages, "Open");
  assert.deepEqual(open.database.columns.find((c) => c.key === "rl").self, { oneWay: true });
  assert.equal(open.database.subItems, undefined);
});

test("a long title or rich text is paged too, and its whole text kept", async () => {
  const chunk = (i) => ({ type: "text", text: { content: `w${i} ` }, plain_text: `w${i} ` });
  const row = structuredClone(FIXTURE.routes[`POST /data_sources/${FIXTURE.ids.ds2}/query`].body);
  row.results[0].properties.Note.rich_text = Array.from({ length: 25 }, (_, i) => chunk(i));
  const { plan } = await runImport({
    overrides: {
      [`POST /data_sources/${FIXTURE.ids.ds2}/query`]: ok(row),
      [`GET /pages/${FIXTURE.ids.row3}/properties/nn`]: ok({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: Array.from({ length: 30 }, (_, i) => ({ object: "property_item", type: "rich_text", rich_text: chunk(i) })),
      }),
    },
  });
  const words = find(plan.pages, "Old idea").attributes.nn.split(" ");
  assert.equal(words.length, 30);
});

// ---- comments

test("comments: threads anchored to the block they landed in, or the page", async () => {
  const { plan, http } = await runImport();
  const root = plan.pages[0];
  assert.deepEqual(root.comments, [
    {
      anchor: "page",
      entries: [{ personId: ids.jane, date: "2025-10-03T10:00:00.000Z", text: `Page-level note for [Bob Stone](mahfouz-import:person/${ids.bob})` }],
    },
    // On a nested list item: the whole list, the body's third block.
    { anchor: { blockIndex: 2 }, entries: [{ personId: ids.jane, date: "2025-10-05T10:00:00.000Z", text: "On a nested item" }] },
    // On the table, its 11th block; a reply follows, oldest first.
    {
      anchor: { blockIndex: 10 },
      entries: [
        { personId: ids.jane, date: "2025-10-04T10:00:00.000Z", text: "Check these numbers" },
        { personId: ids.bob, date: "2025-10-04T11:00:00.000Z", text: "Agreed" },
      ],
    },
  ]);
  // One request per page and per block.
  assert.ok(http.keys().includes(`GET /comments?block_id=${FIXTURE.ids.root}`));
  assert.ok(http.keys().includes(`GET /comments?block_id=${B(31)}`));
  assert.ok(plan.warnings.some((w) => w.startsWith("Notion's API only gives unresolved comments")));
});

test("comments off: no comment requests at all", async () => {
  const { plan, http } = await runImport({ options: { comments: false } });
  assert.ok(!http.keys().some((k) => k.startsWith("GET /comments")));
  assert.ok(all(plan.pages).every((p) => p.comments === undefined));
  assert.ok(!plan.warnings.some((w) => w.includes("comments")));
});

test("without the comments capability: a warning, and no more tries", async () => {
  const { plan, http } = await runImport({
    overrides: {
      "*": (spec, key) => (key.startsWith("GET /comments") ? { status: 403, headers: json, body: { object: "error", code: "restricted_resource" } } : undefined),
    },
  });
  assert.equal(http.keys().filter((k) => k.startsWith("GET /comments")).length, 1);
  assert.ok(plan.warnings.some((w) => w.includes('"Read comments" capability')));
});

test("with the user-info capability, the review gets no people note", async () => {
  const { scan } = await runImport();
  assert.equal(scan.peopleNote, undefined);
});

test("without the user-info capability, people come from mentions and comments", async () => {
  const { plan, scan } = await runImport({ overrides: { "GET /users": { status: 403, headers: json, body: { object: "error", code: "restricted_resource" } } } });
  assertValidPlan(plan);
  // The review's People section says what's missing and links to the settings.
  assert.match(scan.peopleNote.text, /"Read user information including email addresses"/);
  assert.equal(scan.peopleNote.url, "https://www.notion.so/profile/integrations");
  assert.ok(!plan.warnings.some((w) => w.includes("Read user information")));
  // Bob only appears in a comment's display name and a mention.
  assert.equal(plan.people.find((p) => p.id === ids.bob).name, "Bob Stone");
  assert.equal(plan.people.find((p) => p.id === ids.bob).email, undefined);
});

// ---- streaming and resuming

/** The source ids of every page the batches hold, in emit order. */
const emitted = (batches) => batches.flatMap((b) => b.pages.map((p) => p.sourceId));

test("streaming: pages go parent first, one emit each, with a JSON cursor; a database closes after its rows", async () => {
  const { batches, scan } = await runImport();
  assert.deepEqual(
    scan.roots.map((r) => r.kind),
    scan.roots.map((r) => (r.sourceId === ids.ds1 || r.sourceId === ids.ds2 ? "database" : "page"))
  );
  const seen = new Set();
  for (const b of batches) {
    assert.ok(b.pages.length <= 1);
    assert.ok(JSON.stringify(b.cursor).length < 1024 * 1024);
    for (const p of b.pages) {
      assert.ok(p.parent === null || seen.has(p.parent), `${p.title}'s parent comes first`);
      assert.equal(typeof p.hasChildren, "boolean");
      seen.add(p.sourceId);
    }
  }
  // Nothing is emitted twice in one run.
  assert.equal(new Set(emitted(batches)).size, emitted(batches).length);
  // Each data source closes once, after its last row.
  for (const ds of [ids.ds1, ids.ds2]) {
    const at = batches.findIndex((b) => b.closed?.includes(ds));
    assert.ok(at >= 0, "closed");
    const rows = batches.flatMap((b, i) => b.pages.filter((p) => p.parent === ds).map(() => i));
    assert.ok(rows.every((i) => i < at));
  }
  // A page with sub-pages says so.
  const plan = planOf(scan, batches);
  for (const b of batches) for (const p of b.pages) if (find(plan.pages, p.title)?.children.length) assert.equal(p.hasChildren, true, p.title);
});

test("only the picked roots are imported, and no shared page outside them", async () => {
  const full = await runImport();
  const pick = full.scan.roots.find((r) => r.kind === "page");
  const { plan, batches } = await runImport({ roots: [pick.sourceId] });
  assert.deepEqual(plan.pages.map((p) => p.sourceId), [pick.sourceId]);
  assert.ok(emitted(batches).length < emitted(full.batches).length);
});

/** An import stopped after `n` emits with pages, as the app keeps it: what's written, and the last cursor. */
async function stoppedAt(n) {
  const first = await runImport({ stopAfter: n });
  const written = emitted(first.batches);
  const cursor = [...first.batches].reverse().find((b) => b.pages.length > 0).cursor;
  return { first, written, cursor };
}

test("resuming from a cursor carries on where it stopped: every page once, and no page read again", async () => {
  const full = await runImport();
  for (const n of [1, 3, 6, 9]) {
    const { first, written, cursor } = await stoppedAt(n);
    const second = await runImport({ resume: { cursor }, written });
    const again = emitted(second.batches).filter((id) => written.includes(id));
    // Only a database being read when it stopped is emitted again (the app matches its columns).
    for (const id of again) assert.ok([ids.ds1, ids.ds2].includes(id), `${id} emitted again`);
    assert.deepEqual(new Set([...written, ...emitted(second.batches)]), new Set(emitted(full.batches)), `stopped after ${n}`);
    // A page already written isn't read again.
    const readBlocks = (http) => http.keys().filter((k) => /^GET \/blocks\/.*\/children/.test(k));
    for (const id of written.filter((id) => ![ids.ds1, ids.ds2].includes(id))) {
      const page = all(planOf(first.scan, first.batches).pages).find((p) => p.sourceId === id);
      if (page && !page.database) assert.ok(!readBlocks(second.http).some((k) => k.includes(`/blocks/${id.slice(0, 8)}`) && k.includes(id.slice(20))), `${page.title} read again`);
    }
  }
});

test("resuming without a cursor walks again, skipping what's written", async () => {
  const full = await runImport();
  const { written } = await stoppedAt(5);
  const second = await runImport({ resume: { cursor: null }, written });
  const again = emitted(second.batches).filter((id) => written.includes(id));
  for (const id of again) assert.ok([ids.ds1, ids.ds2].includes(id), `${id} emitted again`);
  assert.deepEqual(new Set([...written, ...emitted(second.batches)]), new Set(emitted(full.batches)));
});

test("a cursor from another workspace, roots or version is read as none", async () => {
  const full = await runImport();
  const { written, cursor } = await stoppedAt(4);
  for (const bad of [{ ...cursor, account: "elsewhere" }, { ...cursor, roots: "x" }, { ...cursor, v: 99 }, "junk"]) {
    const second = await runImport({ resume: { cursor: bad }, written });
    assert.deepEqual(new Set([...written, ...emitted(second.batches)]), new Set(emitted(full.batches)));
  }
});

test("attachment refs are the same in every run", async () => {
  const a = await runImport();
  const b = await runImport();
  assert.deepEqual(a.plan.attachments.map((x) => x.ref), b.plan.attachments.map((x) => x.ref));
  assert.equal(new Set(a.plan.attachments.map((x) => x.ref)).size, a.plan.attachments.length);
  for (const x of a.plan.attachments) assert.match(x.ref, /^f-[0-9a-f]{32}$/);
});

test("a stopped run returns quietly once the app refuses an emit", async () => {
  const { batches } = await runImport({ stopAfter: 2 });
  assert.equal(batches.filter((b) => b.pages.length > 0).length, 2);
});

test("a refused batch fails the run instead of ending it quietly", async () => {
  let n = 0;
  await assert.rejects(runImport({ refuse: (b) => b.pages.length > 0 && ++n === 3 }), { name: "ImportPlanError" });
});

test("resuming from a cursor still walks the sub-pages of a page an earlier import wrote", async () => {
  // "Guide" gets a sub-page, "Steps"; the run is stopped while Guide waits on the stack.
  const guide = FIXTURE.ids.child;
  const stepsId = "10000000-0000-4000-8000-0000000000aa";
  const blocks = structuredClone(FIXTURE.routes[`GET /blocks/${guide}/children`].body);
  const sub = structuredClone(FIXTURE.routes[`GET /blocks/${FIXTURE.ids.root}/children`].body.results.find((b) => b.type === "child_page"));
  Object.assign(sub, { id: stepsId, parent: { type: "page_id", page_id: guide }, child_page: { title: "Steps" } });
  blocks.results.push(sub);
  const overrides = { [`GET /blocks/${guide}/children`]: ok(blocks), [`GET /blocks/${stepsId}/children`]: ok(emptyList) };
  const first = await runImport({ overrides, stopAfter: 1 });
  const cursor = [...first.batches].reverse().find((b) => b.pages.length > 0).cursor;
  assert.ok(cursor.stack.some((f) => f.k === "page" && f.id === notionId(guide)), "Guide is still on the stack");
  // An earlier import (Guide's own link, say) wrote Guide, but not Steps.
  const written = [...emitted(first.batches), notionId(guide)];
  const second = await runImport({ overrides, resume: { cursor }, written });
  const steps = second.batches.flatMap((b) => b.pages).find((p) => p.sourceId === notionId(stepsId));
  assert.ok(steps, "Steps is imported");
  assert.equal(steps.parent, notionId(guide));
});

// ---- attachments

test("attachments re-resolve an expired URL from the block or property, after prepare", async () => {
  const { plan, http } = await runImport();
  const [image, spec] = plan.attachments;
  assert.deepEqual([image.ref, image.filenameHint], [fileRef(`block:${notionId(B(20))}`), "diagram.png"]);
  assert.deepEqual([spec.ref, spec.filenameHint], [fileRef(`property:${ids.row1}:fl:0`), "spec.pdf"]);
  const before = http.calls.length;
  assert.deepEqual(await image.resolve(), { url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/diagram.png?X-Amz-Signature=new", method: "GET" });
  assert.deepEqual(await spec.resolve(), { url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/spec.pdf?X-Amz-Signature=new", method: "GET" });
  assert.deepEqual(http.keys().slice(before), [`GET /blocks/${B(20)}`, `GET /pages/${FIXTURE.ids.row1}/properties/fl`]);
  // The request for the bytes carries no secret.
  for (const a of [image, spec]) assert.equal((await a.resolve()).secret, undefined);
});

test("an attachment whose URL is still fresh needs no request", async () => {
  const fresh = structuredClone(FIXTURE.routes[`GET /blocks/${FIXTURE.ids.root}/children?start_cursor=blocks-2`].body);
  const image = fresh.results.find((b) => b.type === "image");
  image.image.file.expiry_time = "2025-10-11T00:00:00.000Z";
  const { plan, http } = await runImport({ overrides: { [`GET /blocks/${FIXTURE.ids.root}/children?start_cursor=blocks-2`]: ok(fresh) } });
  const before = http.calls.length;
  assert.equal((await plan.attachments[0].resolve()).url, image.image.file.url);
  assert.equal(http.calls.length, before);
});

test("a file Notion no longer has fails its resolve", async () => {
  const { plan } = await runImport({ overrides: { [`GET /blocks/${B(20)}`]: ok({ object: "block", id: B(20), type: "image", image: { type: "external", external: { url: "https://x.example/y.png" } } }) } });
  await assert.rejects(plan.attachments[0].resolve(), /no longer has this file/);
});

// ---- escaping

test("Notion text never becomes Markdown, CriticMarkup, a tag, a task or a reference", () => {
  assert.equal(escapeText("a *b* _c_ `d` [e](f) <g> | {++h++} {>>i<<} ~~j~~ $k$ #tag @bob a@b.c x // y http://z ==k== &amp;"),
    "a \\*b\\* \\_c\\_ \\`d\\` \\[e\\](f) \\<g\\> \\| \\{++h++\\} \\{\\>\\>i\\<\\<\\} \\~\\~j\\~\\~ \\$k\\$ \\#tag \\@bob a@b.c x \\/\\/ y http://z \\=\\=k\\=\\= \\&amp;");
  assert.equal(escapeText("[x](mahfouz-import:page/abc)"), "\\[x\\](mahfouz-import\\:page/abc)");
  assert.equal(escapeText("x"), "x");
});

test("ids, URLs and links", () => {
  assert.equal(notionId("1A2B3C4D-0000-4000-8000-00000000000F"), "1a2b3c4d00004000800000000000000f");
  assert.match(notionId("weird id!"), REF_ID_RE);
  assert.equal(notionIdFromUrl("/1a2b3c4d00004000800000000000000f"), "1a2b3c4d00004000800000000000000f");
  assert.equal(notionIdFromUrl("https://www.notion.so/acme/My-Page-1a2b3c4d00004000800000000000000f?pvs=4"), "1a2b3c4d00004000800000000000000f");
  assert.equal(notionIdFromUrl("https://acme.notion.site/1a2b3c4d-0000-4000-8000-00000000000f"), "1a2b3c4d00004000800000000000000f");
  assert.equal(notionIdFromUrl("https://example.com/1a2b3c4d00004000800000000000000f"), null);
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("mahfouz-import:page/abc"), null);
  assert.equal(safeUrl("https://example.com/a b"), "https://example.com/a b");
  assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
});

test("a link in Notion text can't smuggle a reference or a script", async () => {
  const rich = [
    { type: "text", text: { content: "evil", link: { url: "mahfouz-import:person/abc" } }, plain_text: "evil" },
    { type: "text", text: { content: " js", link: { url: "javascript:alert(1)" } }, plain_text: " js" },
  ];
  const { plan } = await runImport({
    overrides: {
      [`GET /blocks/${FIXTURE.ids.other}/children`]: ok({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [{ object: "block", id: B(91), type: "paragraph", has_children: false, paragraph: { rich_text: rich } }],
      }),
    },
  });
  assertValidPlan(plan);
  assert.equal(find(plan.pages, "Loose page").body, "evil js");
});
