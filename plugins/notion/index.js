// Notion import for Mahfouz (mahfouz/notion): a streaming source in the
// Import dialog (the app's importer API version 2). `scan` lists the
// top-level pages and databases shared with the integration; `run` walks the
// ones picked and hands the app each page as it's read (`ctx.emit`), which
// the app commits in batches. The plugin only reads Notion's API: it never
// writes to the vault and never sees the integration token (the app keeps it
// in its native side and attaches it, as `secret: "token"`, only to
// api.notion.com).
//
// Resuming: every emit carries a cursor, the walk's stack of pages and
// databases still to read (small: ids and titles). Resumed from one, the walk
// carries on where the last committed batch left it; without one it walks
// again from the roots, skipping what `ctx.isWritten` reports. A database
// still being read is read again on a resume and emitted again before its
// remaining rows, so the app matches its columns.
//
// Bodies hold ordinary Markdown with three kinds of reference links the app
// rewrites (refs.ts in the app):
//   [text](mahfouz-import:page/<id>)    a page or database of the import
//   [text](mahfouz-import:file/<ref>)   an attachment (`![…]` embeds it)
//   [text](mahfouz-import:person/<id>)  someone, mapped to @login or a name
// Ids are Notion's UUIDs without dashes (32 hex digits); attachment refs are
// `f-` and a hash of where the file is (a block, or a page's property), the
// same in every run. Every page reference comes with a fallback (`links`):
// its Notion URL and title, for a page the import never writes. Notion's own
// text never produces a reference: every Markdown character in it is
// escaped, and in plain-text places (attributes, comments) the
// `mahfouz-import:` scheme is broken with a zero-width space.
//
// Ship as one file: the app doesn't refresh a plugin's relative imports on
// update until it restarts.

export const NOTION_VERSION = "2025-09-03";
export const API_BASE = "https://api.notion.com/v1";
/** The session secret the app attaches as the bearer token (`credential.secretName`). */
export const SECRET = "token";
const PAGE_SIZE = 100;
/** Notion allows an average of three requests a second per integration. */
export const MIN_INTERVAL_MS = 340;
const MAX_RETRIES = 6;
/** A page object lists at most this many items of a list property; more need the property endpoint. */
const PROPERTY_ITEMS_LIMIT = 25;
/** How deep nested blocks are followed. */
const MAX_DEPTH = 40;
/** A cached file URL this close to its expiry is fetched again. */
const URL_FRESH_MS = 10 * 60 * 1000;
/** The shape of the cursor this build writes; another (an older build's) is read as none. */
const CURSOR_VERSION = 1;
/** A cursor past this many UTF-8 bytes, as JSON, isn't kept (the app takes up to 1 MB): a resume then walks again. */
const MAX_CURSOR_BYTES = 900 * 1024;

/** 32 hex digits from `s` (four 32-bit FNV-1a hashes, seeded apart): an attachment ref the same in every run. */
export function stableHash(s) {
  let out = "";
  for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

// Private-use markers that never survive into the plan (stripped from
// Notion's text on the way in): a page reference labelled as its page is
// emitted (P_REF), and a page title filled in then (T_OPEN id T_CLOSE).
const T_OPEN = "\uE000";
const T_CLOSE = "\uE001";
const P_REF = "\uE002";
const PRIVATE_RE = /[\uE000-\uE002]/g;

// ---- activation ---------------------------------------------------------------

export function activate(host) {
  if (typeof host.registerImporter !== "function" || !host.http) {
    host.toast("Importing from Notion needs Mahfouz 0.27.0 or later, on the desktop app.", "error");
    return;
  }
  host.registerImporter(createNotionImporter());
}

/** The importer the Import dialog lists. `deps` (tests): `sleep`, `now`, `timeZone`, `minInterval`. */
export function createNotionImporter(deps = {}) {
  // One pace for the scan, the run and the attachments' re-resolves.
  const shared = { ...deps, limiter: deps.limiter ?? { nextAt: 0, chain: Promise.resolve() } };
  return {
    id: "notion",
    label: "Notion",
    description: "Pages, databases, tasks, comments and files from a Notion workspace",
    credential: {
      label: "Notion integration token",
      helpUrl: "https://mahfouz.app/guide/import-notion/",
      secretName: SECRET,
    },
    options: [
      {
        id: "page",
        type: "text",
        label: "Page link",
        hint: "Paste a page's link to import just that page and its sub-pages. Leave it empty to choose from everything shared with the integration.",
        placeholder: "https://www.notion.so/…",
      },
      { id: "comments", label: "Include comments", hint: "Slower: one more request for every block", default: true },
    ],
    apiVersion: 2,
    scan: (ctx) => new NotionImport(ctx, shared).scan(),
    run: (ctx) => new NotionImport(ctx, shared).run(),
  };
}

// ---- ids, escaping and small helpers ----------------------------------------------

/** A Notion id (UUID, with or without dashes) as the plan's ids: 32 lowercase hex digits. */
export function notionId(id) {
  const s = String(id ?? "").replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(s)) return s;
  // Not a UUID (never seen): still something the app's id pattern accepts.
  return s.replace(/[^a-z0-9-]/g, "").slice(0, 64) || "unknown";
}

/**
 * The page or database id a Notion link names (`notionIdFromUrl`, a
 * `notion.com` one, a peek view's `?p=`, a link pasted without `https://`
 * or in angle brackets, a bare id), with dashes
 * as Notion's API takes it; null when `link` isn't one.
 */
export function idFromLink(link) {
  // As some apps paste a link: in angle brackets, or with a trailing slash.
  const s = String(link ?? "")
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .replace(/\/+(?=$|[?#])/, "");
  let id = null;
  if (/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(s)) id = notionId(s);
  else {
    const url = (/^https?:\/\//i.test(s) ? s : `https://${s}`).replace(/^(https?:\/\/(?:[\w-]+\.)?notion)\.com(?=[/?#]|$)/i, "$1.so");
    id = notionIdFromUrl(url);
    // A page opened as a peek over its database: the link names both, and `p` is the page.
    const peek = /[?&]p=([0-9a-f]{32})(?:[&#]|$)/i.exec(url);
    if (id && peek) id = notionId(peek[1]);
  }
  return id ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : null;
}

/** A plan id (32 hex digits) as the UUID Notion's API names it by; anything else as it is. */
function uuid(id) {
  const s = String(id ?? "");
  return /^[0-9a-f]{32}$/.test(s) ? `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}` : s;
}

function abortError() {
  const err = new Error("The import was cancelled.");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Notion text as literal Markdown: every character inline Markdown, HTML,
 * CriticMarkup, a tag or a task's tokens could read is backslash-escaped
 * (an `@` that would start a login, a `//` between spaces that would start
 * a task's date), and the `mahfouz-import:` scheme is broken. Line starts
 * are handled by `finishLines`.
 */
export function escapeText(s) {
  return String(s ?? "")
    .replace(PRIVATE_RE, "")
    .replace(/[\\`*_[\]<>|{}~$#]/g, "\\$&")
    .replace(/(^|\s)@(?=[\w-])/g, "$1\\@")
    .replace(/(^|\s)\/\/(?=\s|$)/g, "$1\\/\\/")
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
    .replace(/==/g, "\\=\\=")
    .replace(/mahfouz-import:/gi, (m) => `${m.slice(0, -1)}\\:`);
}

/** Text in a plain-text place (an attribute, a comment): only the reference scheme is broken. */
export function plainText(s) {
  return String(s ?? "")
    .replace(PRIVATE_RE, "")
    .replace(/mahfouz-import:/gi, (m) => `${m.slice(0, -1)}\u200B:`);
}

/** A reference's text in a plain-text place: the app reads it with its backslash escapes removed. */
const plainLabel = (s) => plainText(oneLine(s)).replace(/[\\[\]]/g, "\\$&");

/** A line of Markdown that must not open a block: a list, a setext underline. */
function escapeLineStart(line) {
  return line.replace(/^([-+=])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
}

/** http(s), mailto and tel links only. */
export function safeUrl(url) {
  const s = String(url ?? "").trim();
  if (!/^(https?:\/\/[^\s/]|mailto:\S|tel:\S)/i.test(s)) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** A URL as a Markdown link destination. */
const linkDest = (url) => url.replace(/[\s()<>\\]/g, (c) => encodeURIComponent(c));

/** The page id a Notion link points at (`/<id>`, `https://www.notion.so/Title-<id>`), or null. */
export function notionIdFromUrl(url) {
  const s = String(url ?? "").trim();
  const uuid = "([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const m =
    new RegExp(`^/${uuid}(?:[?#].*)?$`, "i").exec(s) ??
    new RegExp(`^https?://(?:[\\w-]+\\.)?notion\\.(?:so|site)/(?:[^?#]*?[/-])?${uuid}(?:[?#].*)?$`, "i").exec(s);
  return m ? notionId(m[1]) : null;
}

/** A file name from a URL's last path segment. */
function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

/**
 * A Notion date (`2025-10-12`, `2025-10-12T14:00:00.000-07:00`) as local
 * `{ date: "YYYY-MM-DD", time: "HH:MM" | null }`: a time with an offset is
 * moved into `timeZone` (default: this machine's), one without is taken as
 * written (floating). Null when it isn't a date.
 */
export function localDate(start, timeZone) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(String(start ?? "").trim());
  if (!m) return null;
  if (m[2] === undefined) return { date: m[1], time: null };
  if (m[4] === undefined) return { date: m[1], time: `${m[2]}:${m[3]}` };
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const dateText = (d) => (d.time ? `${d.date} ${d.time}` : d.date);

function header(headers, name) {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** A failed Notion request, with a message for the Import dialog. */
export class NotionError extends Error {
  constructor(status, path, body) {
    const detail = body && typeof body === "object" && typeof body.message === "string" ? body.message : "";
    let message;
    if (status === 401) {
      message =
        "Notion didn't accept the token. Paste the integration's Internal Integration Secret (notion.so/profile/integrations), and check the integration still exists.";
    } else if (status === 429) {
      message = "Notion kept asking to slow down. Try the import again in a few minutes.";
    } else {
      message = `Notion answered ${status} for ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`;
    }
    super(message);
    this.name = "NotionError";
    this.status = status;
    this.code = body && typeof body === "object" ? body.code : undefined;
  }
}

// ---- the API client -----------------------------------------------------------------

/**
 * Notion's API through `http` (the app's `ctx.http`). Requests are spaced
 * `minInterval` apart through `limiter` (shared by every client of one
 * import, so attachment re-resolves keep to the walk's pace),
 * 429 is retried after its `Retry-After`, and 502/503/504 with exponential
 * backoff. `signal` stops it between requests.
 */
export function createClient(http, { signal = null, sleep = defaultSleep, now = Date.now, minInterval = MIN_INTERVAL_MS, limiter = { nextAt: 0, chain: Promise.resolve() } } = {}) {
  const slot = () => {
    const turn = limiter.chain.then(async () => {
      const wait = limiter.nextAt - now();
      if (wait > 0) await sleep(wait, signal);
      limiter.nextAt = now() + minInterval;
    });
    limiter.chain = turn.catch(() => {});
    return turn;
  };

  /** One request; `allow` lists statuses that resolve to null instead of throwing. */
  async function call(method, path, { query, body, allow = [] } = {}) {
    const qs = query
      ? `?${Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")}`
      : "";
    const headers = { "Notion-Version": NOTION_VERSION };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      await slot();
      throwIfAborted(signal);
      let res;
      try {
        res = await http.request({
          url: `${API_BASE}${path}${qs}`,
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          secret: SECRET,
        });
      } catch (err) {
        // The app's native side failing to reach Notion (not refusing the request): try again.
        if ((err?.code === "timeout" || err?.code === "transport") && attempt < MAX_RETRIES) {
          limiter.nextAt = Math.max(limiter.nextAt, now() + Math.min(30_000, 1000 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      throwIfAborted(signal);
      let data = res.body;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          // Not JSON: kept as text.
        }
      }
      if (res.status >= 200 && res.status < 300) return data;
      if (allow.includes(res.status)) return null;
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < MAX_RETRIES) {
        const after = Number(header(res.headers, "retry-after"));
        const wait = res.status === 429 && Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
        // Every request waits it out, not just this one.
        limiter.nextAt = Math.max(limiter.nextAt, now() + wait);
        continue;
      }
      throw new NotionError(res.status, path, data);
    }
  }

  /** Every result of a paginated endpoint (GET with query cursors, POST with body cursors); null when allowed to fail. */
  async function listAll(method, path, { query = {}, body = {}, allow = [] } = {}) {
    const out = [];
    let cursor;
    do {
      const page =
        method === "GET"
          ? await call("GET", path, { query: { ...query, page_size: PAGE_SIZE, start_cursor: cursor }, allow })
          : await call(method, path, { body: { ...body, page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) }, allow });
      if (page === null) return out.length > 0 ? out : null;
      out.push(...(Array.isArray(page.results) ? page.results : []));
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  return { call, listAll };
}

// ---- rich text ----------------------------------------------------------------------

const STYLE_KEYS = ["bold", "italic", "strikethrough", "code"];

/** Adjacent text runs with the same styles and link, merged (so `**a****b**` never happens). */
function mergeRuns(items) {
  const out = [];
  for (const it of items ?? []) {
    const last = out[out.length - 1];
    if (
      it?.type === "text" &&
      last?.type === "text" &&
      (last.text?.link?.url ?? null) === (it.text?.link?.url ?? null) &&
      STYLE_KEYS.every((k) => !!last.annotations?.[k] === !!it.annotations?.[k])
    ) {
      out[out.length - 1] = { ...last, text: { ...last.text, content: `${last.text?.content ?? ""}${it.text?.content ?? ""}` } };
    } else out.push(it);
  }
  return out;
}

/** `s` wrapped in `mark`, with its leading and trailing whitespace kept outside. */
function wrap(s, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
}

function codeSpan(text, inCell) {
  let s = String(text).replace(PRIVATE_RE, "").replace(/\n/g, " ");
  if (inCell) s = s.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return s ? `${fence}${pad}${s}${pad}${fence}` : "";
}

// ---- the import ---------------------------------------------------------------------

class NotionImport {
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.deps = deps;
    this.timeZone = deps.timeZone;
    this.now = deps.now ?? Date.now;
    const limiter = deps.limiter ?? { nextAt: 0, chain: Promise.resolve() };
    const common = { sleep: deps.sleep, now: deps.now, minInterval: deps.minInterval, limiter };
    this.api = createClient(ctx.http, { ...common, signal: ctx.signal });
    // Attachments resolve when the app downloads them, after the batch that lists them is emitted.
    this.resolveApi = createClient(ctx.http, common);
    this.includeComments = ctx.options?.comments !== false;
    this.link = typeof ctx.options?.page === "string" ? ctx.options.page.trim() : "";
    this.warnings = new Set();
    this.people = new Map();
    this.attachments = [];
    this.titles = new Map();
    this.aliases = new Map();
    this.databases = new Map();
    this.attachmentRefs = new Set();
    this.sentAttachments = 0;
    this.sentPeople = new Set();
    this.sentWarnings = new Set();
    this.pendingLinks = new Map();
    this.stack = [];
    this.leftovers = false;
    this.stopped = false;
    this.visited = new Set();
    this.searchedPages = new Map();
    this.searchedSources = new Map();
    this.databaseIds = new Set();
    this.blockOwners = new Map();
    this.done = 0;
    this.estimate = 0;
    this.commentsReadable = true;
  }

  warn(text) {
    this.warnings.add(text);
  }

  progress(detail, percent) {
    try {
      this.ctx.progress?.(detail, percent);
    } catch {
      // A progress callback is never a reason to fail.
    }
  }

  tick(title) {
    this.done++;
    const total = Math.max(this.estimate, this.done);
    this.progress(`Page ${this.done} of about ${total}: ${oneLine(title) || "Untitled"}`, Math.min(99, Math.floor((this.done / total) * 100)));
  }

  // ---- scan and run

  /**
   * What `scan` and `run` both read first: the token, the people, and the
   * roots (the linked page, or the shared pages and databases whose parent
   * isn't shared), each `{ kind, sourceId, title, frame }`.
   */
  async discover() {
    this.progress("Checking the token…");
    const me = await this.api.call("GET", "/users/me");
    throwIfAborted(this.ctx.signal);
    // Which workspace this is: a cursor from another one isn't resumed.
    this.account = oneLine(me?.bot?.workspace_id ?? me?.bot?.workspace_name ?? "") || null;

    this.progress("Reading the workspace's people…");
    const users = await this.api.listAll("GET", "/users", { allow: [403] });
    if (users === null) {
      this.warn(
        "The integration can't read the workspace's members (it lacks the \"Read user information\" capability): people are imported by the names Notion shows, without emails, and can't be given GitHub logins in the review."
      );
    } else for (const u of users) this.person(u);
    if (this.includeComments) {
      this.warn(
        "Notion's API only gives unresolved comments, and anchors each one to a whole block: resolved threads aren't imported, and a comment on part of a block covers the whole block."
      );
    }

    if (this.link) {
      this.roots = [await this.linkedRoot(this.link)];
      return;
    }

    this.progress("Finding the pages shared with the integration…");
    const found = await this.api.listAll("POST", "/search", {});
    for (const o of found) {
      if (o?.in_trash || o?.archived) continue;
      if (o.object === "page") this.searchedPages.set(notionId(o.id), o);
      else if (o.object === "data_source") {
        this.searchedSources.set(notionId(o.id), o);
        const dbId = o.parent?.database_id;
        if (dbId) {
          this.databaseIds.add(notionId(dbId));
          // A reference to the database lands on its data source with the lowest
          // id, the same whatever order search returns them in.
          const known = this.aliases.get(notionId(dbId));
          if (!known || notionId(o.id) < known) this.aliases.set(notionId(dbId), notionId(o.id));
        }
      } else if (o.object === "database") this.databaseIds.add(notionId(o.id));
    }
    if (this.searchedPages.size === 0 && this.searchedSources.size === 0 && this.databaseIds.size === 0) {
      throw new Error(
        "Notion shared nothing with this integration. In Notion, open each top-level page to import, then ••• → Connections → add the integration (its sub-pages come with it)."
      );
    }
    this.estimate = this.searchedPages.size;
    this.roots = (await this.findRoots()).map((root) => this.rootOf(root));
  }

  /** A root of `findRoots` (or the linked page) as the scan lists it, with the frame that walks it. */
  rootOf(root) {
    if (root.kind === "page") {
      const id = notionId(root.object.id);
      const title = this.titleOf(root.object) || "Untitled";
      return { kind: "page", sourceId: id, title, frame: { k: "page", id, parent: null, hint: title } };
    }
    const dbKey = notionId(root.id);
    const title = this.plainTitle(root.source?.title) || root.title || "Untitled database";
    return { kind: "database", sourceId: this.aliases.get(dbKey) ?? dbKey, title, frame: { k: "db", id: dbKey, parent: null, hint: title } };
  }

  /** The page or database `link` names, as the import's one root. */
  async linkedRoot(link) {
    const id = idFromLink(link);
    if (!id) throw new Error("That isn't a Notion page link. Copy it from the page's ••• menu → Copy link.");
    this.progress("Reading the linked page…");
    this.estimate = 1;
    const page = await this.api.call("GET", `/pages/${id}`, { allow: [400, 403, 404] });
    let found = page;
    if (page?.object === "page" && !page.in_trash && !page.archived) {
      const parent = page.parent?.type;
      if (parent === "data_source_id" || parent === "database_id") {
        this.warn("The link is to a row of a database: its properties aren't imported. Link the database to import its rows with their properties.");
      }
      this.searchedPages.set(notionId(page.id), page);
      return this.rootOf({ kind: "page", object: page });
    }
    if (!page) {
      const db = await this.api.call("GET", `/databases/${id}`, { allow: [400, 403, 404] });
      if (db?.object === "database" && !db.in_trash && !db.archived) {
        const first = Array.isArray(db.data_sources) ? db.data_sources[0] : null;
        if (first?.id) this.aliases.set(notionId(id), notionId(first.id));
        return this.rootOf({ kind: "database", id, title: this.plainTitle(db.title) });
      }
      found = db;
    }
    throw new Error(
      found
        ? "The linked page is in Notion's trash."
        : "Notion hasn't shared this page with the integration. In Notion, open the page, then ••• → Connections → add the integration."
    );
  }

  /** The review's list: the roots, the people and what won't come over. */
  async scan() {
    await this.discover();
    return {
      roots: this.roots.map(({ kind, sourceId, title }) => ({ kind, sourceId, title })),
      people: [...this.people.values()],
      warnings: [...this.warnings],
      ...(this.account ? { fingerprint: this.account } : {}),
    };
  }

  /**
   * Walks the picked roots, depth first, emitting each page as it's read.
   * The walk is a stack of frames (`page`, `db`: a database, `src`: one of
   * its data sources, read with its rows); the stack is the cursor.
   */
  async run() {
    const ctx = this.ctx;
    await this.discover();
    // The scan showed these already.
    for (const id of this.people.keys()) this.sentPeople.add(id);
    for (const w of this.warnings) this.sentWarnings.add(w);

    const picked = Array.isArray(ctx.roots) ? new Set(ctx.roots) : null;
    const roots = this.roots.filter((r) => !picked || picked.has(r.sourceId));
    const rootKey = roots.map((r) => r.sourceId).sort().join(",");
    const cursor = ctx.resume?.cursor;
    const resumable =
      cursor && typeof cursor === "object" && cursor.v === CURSOR_VERSION && cursor.account === this.account && cursor.link === this.link && cursor.roots === rootKey && Array.isArray(cursor.stack);
    if (resumable) {
      this.stack = cursor.stack;
      this.leftovers = cursor.leftovers === true;
      this.estimate = Math.max(this.estimate, Number(cursor.estimate) || 0);
      this.done = Number(cursor.done) || 0;
    } else {
      this.stack = roots.map((r) => r.frame).reverse();
      // Shared pages the walk doesn't reach come in as roots of their own, when every root was picked.
      this.leftovers = !this.link && roots.length === this.roots.length;
    }
    this.rootKey = rootKey;

    try {
      while (this.stack.length > 0 || this.leftovers) {
        throwIfAborted(ctx.signal);
        if (this.stack.length === 0) {
          this.leftovers = false;
          this.stack = this.leftoverFrames().reverse();
          continue;
        }
        const frame = this.stack[this.stack.length - 1];
        if (frame.k === "page") await this.pageFrame(frame);
        else if (frame.k === "db") await this.databaseFrame(frame);
        else await this.sourceFrame(frame);
      }
      // What's left to say (a warning raised by the last page's children, say).
      await this.emit([], {});
      try {
        await ctx.flush();
      } catch (err) {
        if (ctx.signal?.aborted) this.stopped = true;
        throw err;
      }
    } catch (err) {
      // The app stopped the run (Stop, a failed commit): nothing more to hand it.
      if (this.stopped || ctx.signal?.aborted) return;
      throw err;
    }
  }

  /** The shared pages and data sources no walk reached, as root frames. */
  leftoverFrames() {
    const frames = [];
    for (const [id, page] of this.searchedPages) {
      if (!this.visited.has(id) && !this.ctx.isWritten?.(id)) frames.push({ k: "page", id, parent: null, hint: this.titleOf(page) || "Untitled" });
    }
    for (const [id, source] of this.searchedSources) {
      if (this.visited.has(id) || this.ctx.isWritten?.(id)) continue;
      const dbKey = notionId(source.parent?.database_id ?? source.id);
      if (!frames.some((f) => f.k === "db" && f.id === dbKey)) frames.push({ k: "db", id: dbKey, parent: null, hint: this.plainTitle(source.title) });
    }
    return frames;
  }

  /**
   * Hands the app `pages` with everything they need that it hasn't had:
   * attachments, people, warnings, link fallbacks, and the cursor (`stack`:
   * the walk's stack as of after these pages; default `this.stack`).
   */
  async emit(pages, { closed, stack } = {}) {
    const attachments = this.attachments.slice(this.sentAttachments);
    this.sentAttachments = this.attachments.length;
    const people = [...this.people.values()].filter((p) => !this.sentPeople.has(p.id));
    for (const p of people) this.sentPeople.add(p.id);
    const warnings = [...this.warnings].filter((w) => !this.sentWarnings.has(w));
    for (const w of warnings) this.sentWarnings.add(w);
    const links = Object.fromEntries(this.pendingLinks);
    this.pendingLinks.clear();
    if (pages.length === 0 && !closed && attachments.length === 0 && people.length === 0 && warnings.length === 0) return;
    const state = {
      v: CURSOR_VERSION,
      account: this.account,
      link: this.link,
      roots: this.rootKey,
      stack: stack ?? this.stack,
      leftovers: this.leftovers,
      estimate: this.estimate,
      done: this.done,
    };
    const json = JSON.stringify(state);
    const cursor = new TextEncoder().encode(json).length > MAX_CURSOR_BYTES ? null : JSON.parse(json);
    const batch = { pages, attachments, cursor, estimate: Math.max(this.estimate, this.done) };
    if (people.length > 0) batch.people = people;
    if (warnings.length > 0) batch.warnings = warnings;
    if (closed) batch.closed = closed;
    if (Object.keys(links).length > 0) batch.links = links;
    try {
      await this.ctx.emit(batch);
    } catch (err) {
      // Only the app stopping the run is a quiet end; a refused batch is an error to report.
      if (this.ctx.signal?.aborted) this.stopped = true;
      throw err;
    }
  }

  // ---- the walk

  /** The frames for a page's sub-pages and databases, in order. */
  childFrames(id, render) {
    return render.children.map((child) =>
      child.type === "child_page"
        ? { k: "page", id: notionId(child.id), parent: id, hint: oneLine(child.child_page?.title) || "Untitled" }
        : { k: "db", id: notionId(child.id), parent: id, hint: oneLine(child.child_database?.title) }
    );
  }

  /** A page (not a database row): emitted, then its sub-pages and databases pushed. */
  async pageFrame(frame) {
    this.stack.pop();
    if (this.visited.has(frame.id)) return;
    this.visited.add(frame.id);
    const page = this.searchedPages.get(frame.id) ?? { id: uuid(frame.id) };
    // A page frame is popped before its page is emitted, so a written one was
    // written by an earlier import: its children are read from its blocks.
    const read = await this.readPage(page, frame.hint, frame.parent);
    this.stack.push(...read.frames.reverse());
    if (read.node) await this.emit([read.node]);
  }

  /**
   * A page or row read: its node (null when the app already has it: then
   * only its children are read) and its children's frames. `childrenQueued`:
   * a row this run emitted before it was stopped, whose children's frames are
   * on the resumed stack already.
   */
  async readPage(page, titleHint, parent, row = null, childrenQueued = false) {
    const id = notionId(page.id);
    const title = this.titleOf(page) || oneLine(titleHint) || "Untitled";
    this.titles.set(id, title);
    if (this.ctx.isWritten?.(id)) {
      if (childrenQueued) return { node: null, frames: [] };
      const render = this.renderBody(await this.fetchTree(page.id, 0));
      return { node: null, frames: this.childFrames(id, render) };
    }
    if (page.icon || page.cover) this.warn("Page icons and covers aren't imported.");
    this.tick(title);
    const render = this.renderBody(await this.fetchTree(page.id, 0));
    let body = render.body;
    if (row?.extra.length) body = [body, ...row.extra].filter(Boolean).join("\n\n");
    const node = { sourceId: id, parent, hasChildren: render.children.length > 0, title, body, attributes: row?.attributes ?? {} };
    if (this.includeComments) {
      const comments = await this.commentsFor(page.id, render);
      if (comments.length > 0) node.comments = comments;
    }
    return { node: this.finish(node), frames: this.childFrames(id, render) };
  }

  /** A database: replaced on the stack by its data sources, each one Mahfouz database. */
  async databaseFrame(frame) {
    this.stack.pop();
    const dbKey = frame.id;
    if (this.visited.has(dbKey)) return;
    this.visited.add(dbKey);
    const db = await this.readDatabase(dbKey);
    if (db === null) {
      this.warn(
        `The database "${oneLine(frame.hint) || "Untitled"}" was skipped: it's a linked database (Notion's API can't read those) or it isn't shared with the integration.`
      );
      return;
    }
    if (db.in_trash || db.archived) return;
    const dbTitle = this.plainTitle(db.title) || oneLine(frame.hint) || "Untitled database";
    this.titles.set(dbKey, dbTitle);
    const sources = Array.isArray(db.data_sources) ? db.data_sources : [];
    if (sources.length > 1) this.warn(`"${dbTitle}" has ${sources.length} data sources in Notion; each became a database of its own.`);
    const frames = [];
    for (const [i, ref] of sources.entries()) {
      const dsKey = notionId(ref.id);
      if (!this.aliases.has(dbKey) || dsKey < this.aliases.get(dbKey)) this.aliases.set(dbKey, dsKey);
      frames.push({ k: "src", id: dsKey, db: dbKey, parent: frame.parent, multi: sources.length > 1, index: i, hint: oneLine(ref.name), dbTitle });
    }
    this.stack.push(...frames.reverse());
  }

  /** A database's object, read once per run; a data source found by search stands in for one Notion won't give. */
  async readDatabase(dbKey) {
    if (this.databases.has(dbKey)) return this.databases.get(dbKey);
    let db = await this.api.call("GET", `/databases/${uuid(dbKey)}`, { allow: [403, 404] });
    if (db === null) {
      const source = this.searchedSources.get(dbKey);
      if (source) db = { id: uuid(dbKey), title: source.title, data_sources: [{ id: source.id, name: this.plainTitle(source.title) }] };
    }
    this.databases.set(dbKey, db);
    return db;
  }

  /**
   * A data source: its rows read and its columns worked out, the database
   * emitted, then each row not in the vault yet; the database is closed
   * once its rows are all emitted. It stays on the stack until then, so a
   * resume reads it again (and emits it again: the app matches its columns).
   */
  async sourceFrame(frame) {
    const dsKey = frame.id;
    const leave = (pending = []) => {
      this.stack.pop();
      this.stack.push(...pending.reverse());
    };
    if (this.visited.has(dsKey)) return leave();
    this.visited.add(dsKey);
    const source = this.searchedSources.get(dsKey) ?? (await this.api.call("GET", `/data_sources/${uuid(dsKey)}`, { allow: [403, 404] }));
    if (!source) {
      this.warn(`A data source of "${frame.dbTitle}" isn't shared with the integration, so it was skipped.`);
      return leave();
    }
    const name = frame.multi ? this.plainTitle(source.title) || frame.hint || `${frame.dbTitle} ${frame.index + 1}` : frame.dbTitle;
    this.titles.set(dsKey, name);
    this.progress(`Reading the rows of ${name}…`);
    const rows = ((await this.api.listAll("POST", `/data_sources/${uuid(dsKey)}/query`, { allow: [403, 404] })) ?? []).filter(
      (r) => r && !r.in_trash && !r.archived && r.object !== "data_source"
    );
    for (const r of rows) {
      if (!this.searchedPages.has(notionId(r.id)) && !this.ctx.isWritten?.(notionId(r.id))) this.estimate++;
      // Known before any row is emitted: a row linking a later one is labelled with its title.
      const title = this.titleOf(r);
      if (title) this.titles.set(notionId(r.id), title);
    }

    // Every row's values, with long lists paged in full: the columns are final once the database is emitted.
    const schema = Object.values(source.properties ?? {}).filter((p) => p && typeof p === "object");
    const raw = [];
    for (const row of rows) {
      throwIfAborted(this.ctx.signal);
      const values = new Map();
      for (const pv of Object.values(row.properties ?? {})) {
        if (pv?.id !== undefined) values.set(pv.id, await this.fullProperty(row.id, pv));
      }
      raw.push({ row, values });
    }
    const columns = this.columnsOf(schema, raw, name, dsKey);
    const subItems = this.subItemsOf(columns, raw, name);
    const db = await this.readDatabase(frame.db);
    const node = {
      sourceId: dsKey,
      parent: frame.parent,
      hasChildren: rows.length > 0,
      title: name,
      body: this.richMd(db?.description),
      attributes: {},
      database: { columns: columns.flatMap((c) => c.out), ...(subItems ? { subItems: { key: subItems } } : {}) },
    };
    const below = this.stack.slice(0, -1);
    await this.emit([this.finish(node)]);

    // The rows' sub-pages wait until the rows are all emitted. `emitted`: the
    // rows this run emitted, kept in the cursor's copy of this frame, so a
    // resume knows their sub-pages' frames are below it already.
    const emitted = new Set(Array.isArray(frame.emitted) ? frame.emitted : []);
    const pending = [];
    for (const { row, values } of raw) {
      throwIfAborted(this.ctx.signal);
      const rowId = notionId(row.id);
      if (this.visited.has(rowId)) continue;
      this.visited.add(rowId);
      const attributes = {};
      const extra = [];
      for (const col of columns) {
        const pv = values.get(col.prop.id);
        if (pv !== undefined) this.cellValue(col, pv, row, attributes, extra);
      }
      const read = await this.readPage(row, null, dsKey, { attributes, extra }, emitted.has(rowId));
      pending.push(...read.frames);
      if (read.node) {
        emitted.add(rowId);
        // Resumed from here: this source again (its rows written by then are skipped), then the sub-pages found so far.
        await this.emit([read.node], { stack: [...below, ...[...pending].reverse(), { ...frame, emitted: [...emitted] }] });
      }
    }
    leave(pending);
    await this.emit([], { closed: [dsKey] });
  }

  // ---- the tree

  /** Whether a Notion `parent` is something the import holds (a block's owner page, for a block). */
  async parentInSet(parent) {
    switch (parent?.type) {
      case "page_id":
        return this.searchedPages.has(notionId(parent.page_id));
      case "data_source_id":
        return (
          this.searchedSources.has(notionId(parent.data_source_id)) ||
          (parent.database_id !== undefined && this.databaseIds.has(notionId(parent.database_id)))
        );
      case "database_id":
        return this.databaseIds.has(notionId(parent.database_id));
      case "block_id": {
        const owner = await this.blockOwner(parent.block_id);
        return owner !== null && owner.type !== "block_id" && this.parentInSet(owner);
      }
      default:
        return false;
    }
  }

  /** The nearest non-block parent above a block: what holds it. Null when a block can't be read. */
  async blockOwner(blockId) {
    const key = notionId(blockId);
    if (this.blockOwners.has(key)) return this.blockOwners.get(key);
    let id = blockId;
    let owner = null;
    for (let hops = 0; hops < MAX_DEPTH; hops++) {
      const block = await this.api.call("GET", `/blocks/${id}`, { allow: [403, 404] });
      if (!block?.parent) break;
      if (block.parent.type !== "block_id") {
        owner = block.parent;
        break;
      }
      id = block.parent.block_id;
    }
    this.blockOwners.set(key, owner);
    return owner;
  }

  /** The searched pages and databases whose parent isn't part of the import, in search order. */
  async findRoots() {
    const roots = [];
    for (const page of this.searchedPages.values()) {
      if (!(await this.parentInSet(page.parent))) roots.push({ kind: "page", object: page });
    }
    const seenDatabases = new Set();
    for (const source of this.searchedSources.values()) {
      const dbId = source.parent?.database_id;
      if (!dbId) {
        roots.push({ kind: "database", id: source.id, source });
        continue;
      }
      if (seenDatabases.has(notionId(dbId))) continue;
      seenDatabases.add(notionId(dbId));
      let dbParent = source.database_parent;
      if (!dbParent) dbParent = (await this.api.call("GET", `/databases/${dbId}`, { allow: [403, 404] }))?.parent;
      if (!(await this.parentInSet(dbParent))) roots.push({ kind: "database", id: dbId, source });
    }
    return roots;
  }

  /** A page's title: its `title`-typed property, whatever it's named. */
  titleOf(page) {
    for (const prop of Object.values(page?.properties ?? {})) {
      if (prop?.type === "title") return oneLine((prop.title ?? []).map((t) => t?.plain_text ?? "").join(""));
    }
    return null;
  }

  /** A block's children, recursively, each with `children` set (a synced copy's from its original). */
  async fetchTree(blockId, depth) {
    const blocks = await this.api.listAll("GET", `/blocks/${blockId}/children`, { allow: [403, 404] });
    if (!blocks) return [];
    const out = [];
    for (const b of blocks) {
      throwIfAborted(this.ctx.signal);
      if (!b || b.in_trash || b.archived) continue;
      if (b.type === "child_page" || b.type === "child_database") {
        out.push(b);
        continue;
      }
      const from = b.type === "synced_block" ? b.synced_block?.synced_from?.block_id : null;
      let children = [];
      if ((from || b.has_children) && depth >= MAX_DEPTH) {
        this.warn(`Blocks nested more than ${MAX_DEPTH} levels deep were left out.`);
      } else if (from) {
        const original = await this.api.listAll("GET", `/blocks/${from}/children`, { allow: [403, 404] });
        if (original === null) this.warn("A synced block's original isn't shared with the integration, so its copy was left out.");
        else children = await this.withChildren(original, depth + 1);
      } else if (b.has_children) {
        children = await this.fetchTree(b.id, depth + 1);
      }
      out.push({ ...b, children });
    }
    return out;
  }

  /** `fetchTree` for blocks already listed (a synced block's original's children). */
  async withChildren(blocks, depth) {
    const out = [];
    for (const b of blocks) {
      if (!b || b.in_trash || b.archived) continue;
      if (b.type === "child_page" || b.type === "child_database" || !b.has_children) {
        out.push({ ...b, children: [] });
        continue;
      }
      out.push({ ...b, children: depth >= MAX_DEPTH ? [] : await this.fetchTree(b.id, depth + 1) });
    }
    return out;
  }

  // ---- databases

  plainTitle(rich) {
    return oneLine((rich ?? []).map((t) => t?.plain_text ?? "").join(""));
  }

  /** A property value with every item, fetched from the property endpoint when the page object truncated it. */
  async fullProperty(pageId, pv) {
    const type = pv.type;
    const listTypes = ["title", "rich_text", "people", "relation"];
    let needs = false;
    if (listTypes.includes(type)) needs = pv.has_more === true || (Array.isArray(pv[type]) && pv[type].length >= PROPERTY_ITEMS_LIMIT);
    else if (type === "rollup") needs = pv.rollup?.type === "array" && (pv.rollup.array?.length ?? 0) >= PROPERTY_ITEMS_LIMIT;
    if (!needs) return pv;
    const propId = /^[A-Za-z0-9%._~-]+$/.test(pv.id) ? pv.id : encodeURIComponent(pv.id);
    const items = await this.api.listAll("GET", `/pages/${pageId}/properties/${propId}`, { allow: [403, 404] });
    if (!items) return pv;
    if (type === "rollup") return { ...pv, rollup: { ...pv.rollup, array: items } };
    return { ...pv, has_more: false, [type]: items.map((it) => it?.[type]).filter(Boolean) };
  }

  /**
   * The database's columns: one per property (the title is the note's
   * title), typed from the property and, where Notion doesn't say (a
   * formula's result, a date's time), from the rows' values.
   */
  columnsOf(schema, raw, dbName, sourceId) {
    const columns = [];
    /** A relation property linking rows of this same data source. */
    const isSelf = (p) => p?.type === "relation" && notionId(p.relation?.data_source_id) === sourceId;
    /** A dual self-relation's other side in the schema, by id, else by name. */
    const partnerOf = (p) => {
      const dual = p.relation?.dual_property;
      if (p.relation?.type !== "dual_property" || !dual) return null;
      return (
        schema.find((o) => o !== p && isSelf(o) && o.id === dual.synced_property_id) ??
        schema.find((o) => o !== p && isSelf(o) && oneLine(o.name) === oneLine(dual.synced_property_name)) ??
        null
      );
    };
    const valuesOf = (prop) => raw.map((r) => r.values.get(prop.id)).filter(Boolean);
    let snapshot = false;
    for (const prop of schema) {
      const label = oneLine(prop.name) || prop.id;
      const col = (type, options) => ({ key: prop.id, label, type, ...(options ? { options } : {}) });
      const optionNames = (list) => [...new Set((list ?? []).map((o) => oneLine(o?.name)).filter(Boolean))];
      let out = null;
      let kind = prop.type;
      switch (prop.type) {
        case "title":
          continue;
        case "relation": {
          if (!isSelf(prop)) {
            // A relation to another database: the linked pages, as text.
            out = [col("text")];
            break;
          }
          // A relation between this database's rows (Notion's sub-items
          // among them): one-way, or paired with its other side.
          const partner = partnerOf(prop);
          const dual = prop.relation?.dual_property;
          let self;
          if (partner) self = { reverse: partner.id };
          else if (prop.relation?.type === "dual_property" && dual) {
            self = { reverse: `${prop.id} reverse`, reverseLabel: oneLine(dual.synced_property_name) || `${label} (reverse)` };
          } else self = { oneWay: true };
          out = [{ ...col("relation"), self }];
          kind = "self";
          break;
        }
        case "rich_text":
        case "people":
        case "created_by":
        case "last_edited_by":
        case "unique_id":
          out = [col("text")];
          break;
        case "number":
          out = [col("number")];
          break;
        case "select":
          out = [col("select", optionNames(prop.select?.options))];
          break;
        case "status":
          out = [col("select", optionNames(prop.status?.options))];
          break;
        case "multi_select":
          out = [col("multiselect", optionNames(prop.multi_select?.options))];
          break;
        case "date": {
          const dates = valuesOf(prop).map((v) => v.date).filter(Boolean);
          const type = dates.some((d) => /T/.test(d.start ?? "") || /T/.test(d.end ?? "")) ? "datetime" : "date";
          out = [col(type)];
          if (dates.some((d) => d.end)) out.push({ key: `${prop.id} end`, label: `${label} end`, type });
          kind = type;
          break;
        }
        case "checkbox":
          out = [col("checkbox")];
          break;
        case "url":
          out = [col("url")];
          break;
        case "email":
          out = [col("email")];
          break;
        case "phone_number":
          out = [col("phone")];
          break;
        case "files":
          out = [col("attachment")];
          break;
        case "created_time":
        case "last_edited_time":
          out = [col("datetime")];
          break;
        case "formula": {
          snapshot = true;
          const first = valuesOf(prop).map((v) => v.formula).find((f) => f && f[f.type] !== null && f[f.type] !== undefined);
          kind = first?.type === "date" ? this.dateKind(valuesOf(prop).map((v) => v.formula?.date)) : first?.type ?? "string";
          out = [col({ number: "number", boolean: "checkbox", date: kind, datetime: "datetime" }[kind] ?? "text")];
          break;
        }
        case "rollup": {
          snapshot = true;
          const first = valuesOf(prop).map((v) => v.rollup).find((r) => r && r[r.type] !== null && r[r.type] !== undefined);
          kind = first?.type === "date" ? this.dateKind(valuesOf(prop).map((v) => v.rollup?.date)) : first?.type ?? "array";
          out = [col({ number: "number", date: "date", datetime: "datetime" }[kind] ?? "text")];
          break;
        }
        default:
          this.warn(`The "${label}" column (${oneLine(prop.type)}) of "${dbName}" isn't imported.`);
          continue;
      }
      columns.push({ prop, kind, out });
    }
    if (snapshot) this.warn(`Formula and rollup columns of "${dbName}" were imported as their current values; they won't recalculate.`);
    return columns;
  }

  /**
   * The key of the self-relation column holding each row's parent (Notion's
   * "Parent item"), or null. Notion's API doesn't say which relation is the
   * sub-items one, so it's the one pair of self-relation columns whose one
   * side's name says "parent" (and its partner's doesn't) and where no row
   * links more than one parent. Nothing is guessed from link counts alone:
   * a pair like "Blocked by" / "Blocking" fits them as well.
   */
  subItemsOf(columns, raw, dbName) {
    const pairs = [];
    for (const c of columns) {
      if (c.kind !== "self") continue;
      const partner = columns.find((o) => o.kind === "self" && o.prop.id === c.out[0].self.reverse);
      if (partner && partner !== c) pairs.push([c, partner]);
    }
    const isParent = (c) => /\bparent\b/i.test(oneLine(c.prop.name));
    const most = (c) => Math.max(0, ...raw.map((r) => r.values.get(c.prop.id)?.relation?.length ?? 0));
    const named = pairs.filter(([c, p]) => isParent(c) && !isParent(p));
    const fits = named.filter(([c]) => most(c) <= 1);
    if (fits.length === 1) return fits[0][0].out[0].key;
    if (named.length > 0) {
      const which = named.map(([c]) => `"${oneLine(c.prop.name)}"`).join(", ");
      this.warn(`${which} of "${dbName}" ${named.length === 1 ? "isn't" : "aren't"} imported as sub-items: ${fits.length > 1 ? "more than one relation could hold them" : "a row links more than one parent"}. ${named.length === 1 ? "It stays a relation" : "They stay relations"}, without the Tree view.`);
    }
    return null;
  }

  dateKind(dates) {
    return dates.some((d) => d && (/T/.test(d.start ?? "") || /T/.test(d.end ?? ""))) ? "datetime" : "date";
  }

  /** A date value for a `date` or `datetime` column. */
  dateValue(start, type) {
    const d = localDate(start, this.timeZone);
    if (!d) return undefined;
    if (type === "date") return d.date;
    // A datetime keeps Notion's instant; a date-only value is midnight, local.
    return d.time ? String(start).trim() : `${d.date}T00:00`;
  }

  /** Sets a row's attribute(s) for one column, and any body lines it needs. */
  cellValue(col, pv, row, attributes, extra) {
    const [main, end] = col.out;
    const set = (key, value) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value) ? value.length === 0 : value === "") return;
      attributes[key] = value;
    };
    const v = pv[pv.type];
    switch (pv.type) {
      case "rich_text":
        return set(main.key, this.richPlain(v).trim());
      case "number":
        return set(main.key, typeof v === "number" ? String(v) : undefined);
      case "select":
      case "status":
        return set(main.key, v?.name ? oneLine(v.name) : undefined);
      case "multi_select":
        return set(main.key, (v ?? []).map((o) => oneLine(o?.name)).filter(Boolean));
      case "date":
        if (!v) return;
        set(main.key, this.dateValue(v.start, main.type));
        if (end && v.end) set(end.key, this.dateValue(v.end, end.type));
        return;
      case "checkbox":
        return set(main.key, v ? "true" : "false");
      case "url":
      case "email":
      case "phone_number":
        return set(main.key, typeof v === "string" ? plainText(oneLine(v)) : undefined);
      case "people":
        return set(main.key, (v ?? []).map((u) => this.personRef(u, "plain")).join(", "));
      case "relation": {
        const refs = (v ?? []).filter((r) => r?.id).map((r) => this.pageRef(r.id, null, "plain"));
        // A self-relation's value is the list of rows it links.
        return set(main.key, col.kind === "self" ? refs : refs.join(", "));
      }
      case "created_by":
      case "last_edited_by":
        return set(main.key, v ? this.personRef(v, "plain") : undefined);
      case "created_time":
      case "last_edited_time":
        return set(main.key, typeof v === "string" ? v : undefined);
      case "unique_id":
        return set(main.key, v && typeof v.number === "number" ? `${v.prefix ? `${v.prefix}-` : ""}${v.number}` : undefined);
      case "files": {
        const files = Array.isArray(v) ? v : [];
        let first = true;
        const rest = [];
        files.forEach((f, index) => {
          if (first && (f?.type === "file" || f?.type === "file_upload")) {
            first = false;
            const ref = this.addAttachment({ kind: "property", pageId: row.id, propId: pv.id, index }, f, f?.name);
            set(main.key, `[${plainLabel(f?.name || "file")}](mahfouz-import:file/${ref})`);
          } else rest.push(this.fileLink(f, { kind: "property", pageId: row.id, propId: pv.id, index }));
        });
        const links = rest.filter(Boolean);
        if (links.length > 0) extra.push(`${escapeLineStart(escapeText(col.prop.name))}: ${links.join(", ")}`);
        return;
      }
      case "formula":
        return set(main.key, this.computedValue(v, main.type));
      case "rollup": {
        if (v?.type === "array") {
          const items = (v.array ?? []).map((it) => this.computedValue(it, "text")).filter(Boolean);
          return set(main.key, items.join(", "));
        }
        return set(main.key, this.computedValue(v, main.type));
      }
      default:
        return;
    }
  }

  /** A formula's, rollup's or rollup item's value, as plain text for a column of `type`. */
  computedValue(v, type) {
    if (!v || typeof v !== "object") return undefined;
    const x = v[v.type];
    switch (v.type) {
      case "string":
        return typeof x === "string" ? plainText(oneLine(x)) : undefined;
      case "number":
        return typeof x === "number" ? String(x) : undefined;
      case "boolean":
        return typeof x === "boolean" ? String(x) : undefined;
      case "date":
        return x?.start ? (type === "date" || type === "datetime" ? this.dateValue(x.start, type) : dateText(localDate(x.start, this.timeZone) ?? { date: x.start })) : undefined;
      case "title":
      case "rich_text":
        return this.richPlain(Array.isArray(x) ? x : [x]).trim() || undefined;
      case "people":
        return x ? this.personRef(x, "plain") : undefined;
      case "relation":
        return x?.id ? this.pageRef(x.id, null, "plain") : undefined;
      case "select":
      case "status":
        return x?.name ? oneLine(x.name) : undefined;
      case "multi_select":
        return Array.isArray(x) ? x.map((o) => oneLine(o?.name)).filter(Boolean).join(", ") : undefined;
      case "checkbox":
        return typeof x === "boolean" ? String(x) : undefined;
      case "url":
      case "email":
      case "phone_number":
        return typeof x === "string" ? plainText(oneLine(x)) : undefined;
      case "unique_id":
        return x && typeof x.number === "number" ? `${x.prefix ? `${x.prefix}-` : ""}${x.number}` : undefined;
      default:
        return undefined;
    }
  }

  // ---- people, pages, files

  /** Records a Notion user; returns its id. */
  person(user, nameHint) {
    const id = notionId(user?.id);
    const name = oneLine(user?.name) || oneLine(nameHint);
    const email = user?.person?.email ? oneLine(user.person.email) : undefined;
    const known = this.people.get(id);
    if (!known) this.people.set(id, { id, name: name || "Notion user", ...(email ? { email } : {}) });
    else {
      if (name && known.name === "Notion user") known.name = name;
      if (email && !known.email) known.email = email;
    }
    return id;
  }

  /** A person reference: `[name](mahfouz-import:person/<id>)`, its text escaped for `context`. */
  personRef(user, context, nameHint) {
    const id = this.person(user, nameHint);
    const name = this.people.get(id).name;
    const label = context === "body" ? escapeText(oneLine(name)) : plainLabel(name);
    return `[${label}](mahfouz-import:person/${id})`;
  }

  /** A page reference, labelled when its page is emitted; with no `text`, the page's title is filled in then. */
  pageRef(rawId, text, context) {
    const id = notionId(rawId);
    const label = text ? (context === "body" ? escapeText(oneLine(text)) : plainLabel(text)) : `${T_OPEN}${id}${T_CLOSE}`;
    return `${P_REF}[${label}](mahfouz-import:page/${id})`;
  }

  /** Records a Notion-hosted file; returns its ref. `locator` says how to fetch a fresh URL. */
  addAttachment(locator, file, name) {
    const where = locator.kind === "block" ? `block:${notionId(locator.blockId)}` : `property:${notionId(locator.pageId)}:${locator.propId}:${locator.index}`;
    const ref = `f-${stableHash(where)}`;
    // Listed once, however often a page names it.
    if (this.attachmentRefs.has(ref)) return ref;
    this.attachmentRefs.add(ref);
    const url = file?.file?.url ?? file?.file_upload?.url ?? null;
    const expiry = Date.parse(file?.file?.expiry_time ?? file?.file_upload?.expiry_time ?? "");
    const hint = oneLine(name) || (url ? nameFromUrl(url) : "") || "file";
    const api = this.resolveApi;
    const now = this.now;
    this.attachments.push({
      ref,
      filenameHint: hint,
      resolve: async () => {
        if (url && Number.isFinite(expiry) && expiry - now() > URL_FRESH_MS) return { url, method: "GET" };
        let fresh = null;
        if (locator.kind === "block") {
          const block = await api.call("GET", `/blocks/${locator.blockId}`);
          fresh = block?.[block?.type];
        } else {
          const propId = /^[A-Za-z0-9%._~-]+$/.test(locator.propId) ? locator.propId : encodeURIComponent(locator.propId);
          const item = await api.call("GET", `/pages/${locator.pageId}/properties/${propId}`);
          const files = item?.files ?? item?.results?.map((r) => r?.files).flat() ?? [];
          fresh = files[locator.index];
        }
        const freshUrl = fresh?.file?.url ?? fresh?.file_upload?.url;
        if (!freshUrl) throw new Error("Notion no longer has this file.");
        return { url: freshUrl, method: "GET" };
      },
    });
    return ref;
  }

  /** A link to a file object: a reference for a Notion-hosted file, a plain link for an external one. */
  fileLink(f, locator, label, embed = false) {
    if (f?.type === "external") {
      const url = safeUrl(f.external?.url);
      if (!url) return "";
      return `[${label || escapeText(oneLine(f.name) || url)}](${linkDest(url)})`;
    }
    if (f?.type === "file" || f?.type === "file_upload") {
      const ref = this.addAttachment(locator, f, f.name);
      const text = label || escapeText(oneLine(f.name) || this.attachments.find((a) => a.ref === ref)?.filenameHint || "file");
      return `${embed ? "!" : ""}[${text}](mahfouz-import:file/${ref})`;
    }
    return "";
  }

  // ---- rich text

  /** A mention's or plain run's text with its leading `@` (Notion's mention prefix) dropped. */
  mentionName(it) {
    return oneLine(it?.plain_text).replace(/^@/, "");
  }

  mentionDate(date) {
    if (!date?.start) return null;
    const d = localDate(date.start, this.timeZone);
    if (!d) return null;
    if (date.end) this.warn("Date ranges were imported as their start date.");
    return d;
  }

  /** Rich text as inline Markdown; `single` keeps it on one line (headings, table cells, task titles, labels). */
  richMd(items, { single = false, inCell = false } = {}) {
    let out = "";
    for (const it of mergeRuns(items)) out += this.runMd(it, inCell);
    return this.finishLines(out, single);
  }

  /** Splits on Notion's line breaks: hard breaks (`\` at the end) in a block, spaces on one line. */
  finishLines(s, single) {
    const lines = s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (single) return lines.length > 0 ? escapeLineStart(lines.join(" ")) : "";
    return lines.map(escapeLineStart).join("\\\n");
  }

  runMd(it, inCell) {
    if (!it || typeof it !== "object") return "";
    if (it.type === "equation") return it.equation?.expression ? `$${oneLine(it.equation.expression).replace(PRIVATE_RE, "")}$` : "";
    if (it.type === "mention") return this.mentionMd(it);
    const content = String(it.text?.content ?? it.plain_text ?? "");
    const a = it.annotations ?? {};
    let s = a.code ? codeSpan(content, inCell) : escapeText(content);
    if (!s) return "";
    if (a.strikethrough) s = wrap(s, "~~");
    if (a.italic) s = wrap(s, "*");
    if (a.bold) s = wrap(s, "**");
    const url = it.text?.link?.url ?? null;
    if (!url) return s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.replace(/\n/g, " "));
    if (!m[2]) return s;
    const target = notionIdFromUrl(url);
    if (target) return `${m[1]}${P_REF}[${m[2]}](mahfouz-import:page/${target})${m[3]}`;
    const safe = safeUrl(url);
    return safe ? `${m[1]}[${m[2]}](${linkDest(safe)})${m[3]}` : s;
  }

  mentionMd(it) {
    const m = it.mention ?? {};
    switch (m.type) {
      case "user":
        return this.personRef(m.user, "body", this.mentionName(it));
      case "page":
        return this.pageRef(m.page?.id, oneLine(it.plain_text) || null, "body");
      case "database":
        return this.pageRef(m.database?.id, oneLine(it.plain_text) || null, "body");
      case "data_source":
        return this.pageRef(m.data_source?.id, oneLine(it.plain_text) || null, "body");
      case "date": {
        const d = this.mentionDate(m.date);
        return d ? escapeText(dateText(d)) : escapeText(it.plain_text);
      }
      case "link_preview":
      case "link_mention": {
        const url = safeUrl(m.link_mention?.href ?? m.link_preview?.url ?? it.href);
        const text = oneLine(m.link_mention?.title) || oneLine(it.plain_text) || url;
        return url ? `[${escapeText(text)}](${linkDest(url)})` : escapeText(it.plain_text);
      }
      default:
        return escapeText(it.plain_text);
    }
  }

  /** Rich text as plain text (an attribute, a comment), with people and pages as references. */
  richPlain(items) {
    let out = "";
    const add = (ref) => {
      // A backslash right before a reference would escape it.
      if (out.endsWith("\\")) out += "\u200B";
      out += ref;
    };
    for (const it of items ?? []) {
      if (!it || typeof it !== "object") continue;
      if (it.type === "mention") {
        const m = it.mention ?? {};
        if (m.type === "user") add(this.personRef(m.user, "plain", this.mentionName(it)));
        else if (m.type === "page" || m.type === "database" || m.type === "data_source") add(this.pageRef(m[m.type]?.id, oneLine(it.plain_text) || null, "plain"));
        else if (m.type === "date") {
          const d = this.mentionDate(m.date);
          out += d ? dateText(d) : plainText(it.plain_text);
        } else out += plainText(it.plain_text);
      } else if (it.type === "equation") {
        out += plainText(it.equation?.expression ?? it.plain_text);
      } else {
        const text = plainText(it.text?.content ?? it.plain_text ?? "");
        out += text;
        const url = safeUrl(it.text?.link?.url);
        if (url && url !== text.trim()) out += ` (${url})`;
      }
    }
    return out;
  }

  // ---- blocks

  /**
   * A page's blocks as Markdown. Each top-level Notion block becomes one or
   * more top-level Markdown blocks, separated by blank lines, except that
   * consecutive list items of one kind make one list (as Markdown reads
   * them). `index` maps each block id to the 0-based top-level Markdown
   * block it landed in: a comment's `blockIndex`.
   */
  renderBody(blocks) {
    const ctx = { children: [], ids: [] };
    const groups = group(this.chunks(blocks, ctx));
    const index = new Map();
    groups.forEach((g, i) => {
      for (const id of g.ids) if (!index.has(id)) index.set(id, i);
    });
    return { body: groups.map((g) => g.text).join("\n\n"), index, ids: ctx.ids, children: ctx.children };
  }

  /** Chunks (`{ kind: "ul" | "ol" | "block", text, ids }`) for a list of sibling blocks. */
  chunks(blocks, ctx) {
    const out = [];
    for (const b of blocks ?? []) out.push(...this.blockChunks(b, ctx));
    return out;
  }

  blockChunks(b, ctx) {
    const id = notionId(b.id);
    const type = b.type;
    const data = b[type] ?? {};
    if (type !== "child_page" && type !== "child_database") ctx.ids.push(b.id);
    const one = (text) => (text ? [{ kind: "block", text, ids: [id] }] : []);
    const flat = () => this.chunks(b.children, ctx);
    switch (type) {
      case "paragraph":
        return [...one(this.richMd(data.rich_text)), ...flat()];
      case "heading_1":
      case "heading_2":
      case "heading_3": {
        const text = this.richMd(data.rich_text, { single: true });
        return [...one(text ? `${"#".repeat(Number(type.slice(-1)))} ${text}` : ""), ...flat()];
      }
      case "bulleted_list_item":
      case "toggle":
        return [this.item("ul", "- ", 2, this.richMd(data.rich_text), b, ctx)];
      case "numbered_list_item":
        return [this.item("ol", "1. ", 3, this.richMd(data.rich_text), b, ctx)];
      case "to_do":
        return [this.item("ul", data.checked ? "- [x] " : "- [ ] ", 2, this.todoText(data.rich_text), b, ctx)];
      case "quote":
        return this.quote(this.richMd(data.rich_text), b, ctx);
      case "callout": {
        const emoji = data.icon?.type === "emoji" ? oneLine(data.icon.emoji).replace(PRIVATE_RE, "") : "";
        const text = this.richMd(data.rich_text);
        return this.quote(emoji && text ? `${emoji} ${text}` : emoji || text, b, ctx);
      }
      case "code": {
        const code = (data.rich_text ?? []).map((t) => t?.text?.content ?? t?.plain_text ?? "").join("").replace(PRIVATE_RE, "");
        let lang = oneLine(data.language).toLowerCase();
        if (lang === "plain text") lang = "";
        lang = lang.replace(/[^a-z0-9#+.-]+/g, "-");
        const longest = Math.max(2, ...(code.match(/`{3,}/g) ?? []).map((r) => r.length));
        const fence = "`".repeat(longest + 1);
        return one(`${fence}${lang}\n${code.replace(/\n$/, "")}\n${fence}`);
      }
      case "equation": {
        const expr = oneLine(data.expression).replace(PRIVATE_RE, "");
        return one(expr ? `$$${expr}$$` : "");
      }
      case "divider":
        return one("---");
      case "table":
        return this.table(b, ctx);
      case "column_list":
      case "column":
      case "synced_block":
        return flat();
      case "child_page":
      case "child_database":
        ctx.children.push(b);
        return [];
      case "link_to_page": {
        const target = data.page_id ?? data.database_id ?? data.data_source_id;
        return target ? one(this.pageRef(target, null, "body")) : [];
      }
      case "image":
      case "video":
      case "audio":
      case "file":
      case "pdf": {
        const caption = escapeText(oneLine((data.caption ?? []).map((t) => t?.plain_text ?? "").join("")));
        return one(this.fileLink(data, { kind: "block", blockId: b.id }, caption, type === "image"));
      }
      case "bookmark":
      case "embed":
      case "link_preview": {
        const url = safeUrl(data.url);
        if (!url) return [];
        const caption = oneLine((data.caption ?? []).map((t) => t?.plain_text ?? "").join(""));
        return one(`[${escapeText(caption || url)}](${linkDest(url)})`);
      }
      default: {
        const names = {
          table_of_contents: "Tables of contents",
          breadcrumb: "Breadcrumbs",
          unsupported: "Blocks Notion's API doesn't support",
          template: "Template buttons",
          button: "Buttons",
          ai_block: "AI blocks",
          meeting_notes: "Meeting notes",
          transcription: "Meeting notes",
        };
        this.warn(`${names[type] ?? `Notion's "${oneLine(type)}" blocks`} aren't imported.`);
        return [];
      }
    }
  }

  /** A list item: its marker and text, its children nested under it. */
  item(kind, marker, indentWidth, text, b, ctx) {
    const indent = " ".repeat(indentWidth);
    const lines = (text || "").split("\n");
    let out = [`${marker}${lines[0]}`, ...lines.slice(1).map((l) => indent + l)].join("\n");
    const childChunks = this.chunks(b.children, ctx);
    const ids = [notionId(b.id), ...childChunks.flatMap((c) => c.ids)];
    if (childChunks.length > 0) {
      const nested = group(childChunks)
        .map((g) => g.text)
        .join("\n\n");
      out += (childChunks[0].kind === "block" ? "\n\n" : "\n") + indentLines(nested, indent);
    }
    return { kind, text: out, ids };
  }

  /** A quote or callout: `> ` before every line, its children inside it. */
  quote(text, b, ctx) {
    const childChunks = this.chunks(b.children, ctx);
    const parts = [text, ...group(childChunks).map((g) => g.text)].filter(Boolean);
    if (parts.length === 0) return [];
    const quoted = parts
      .join("\n\n")
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
    return [{ kind: "block", text: quoted, ids: [notionId(b.id), ...childChunks.flatMap((c) => c.ids)] }];
  }

  /** A GFM table; without a header row in Notion, the header row is empty. */
  table(b, ctx) {
    const rows = (b.children ?? []).filter((r) => r?.type === "table_row");
    if (rows.length === 0) return [];
    for (const r of rows) ctx.ids.push(r.id);
    const width = Math.max(Number(b.table?.table_width) || 0, ...rows.map((r) => r.table_row?.cells?.length ?? 0), 1);
    const cells = (r) => {
      const out = (r.table_row?.cells ?? []).map((c) => this.richMd(c, { single: true, inCell: true }) || " ");
      while (out.length < width) out.push(" ");
      return `| ${out.join(" | ")} |`;
    };
    const head = b.table?.has_column_header ? cells(rows[0]) : `|${" |".repeat(width)}`;
    const body = (b.table?.has_column_header ? rows.slice(1) : rows).map(cells);
    const sep = `|${" --- |".repeat(width)}`;
    return [{ kind: "block", text: [head, sep, ...body].join("\n"), ids: [notionId(b.id), ...rows.map((r) => notionId(r.id))] }];
  }

  /**
   * A to-do's text. With a date mention it's a task line: the other text,
   * then the first user mention (the assignee), then ` // ` and the date,
   * `title [person] // YYYY-MM-DD[ HH:MM]`; a to-do with only a date takes
   * the date's text as its title. Without a date, the text as it is.
   */
  todoText(rich) {
    const items = rich ?? [];
    const di = items.findIndex((t) => t?.type === "mention" && t.mention?.type === "date");
    const date = di >= 0 ? this.mentionDate(items[di].mention.date) : null;
    if (!date) return this.richMd(items);
    const ui = items.findIndex((t) => t?.type === "mention" && t.mention?.type === "user");
    const rest = items.filter((_, i) => i !== di && i !== ui);
    // Moving the mentions out leaves doubled spaces behind.
    const title = this.richMd(rest, { single: true }).replace(/ {2,}/g, " ").trim() || escapeLineStart(escapeText(this.mentionName(items[di]) || dateText(date)));
    const assignee = ui >= 0 ? ` ${this.personRef(items[ui].mention.user, "body", this.mentionName(items[ui]))}` : "";
    return `${title}${assignee} // ${dateText(date)}`;
  }

  // ---- comments

  /** The page's unresolved comment threads, anchored to the Markdown block each one's block landed in. */
  async commentsFor(pageId, render) {
    if (!this.commentsReadable) return [];
    const seen = new Set();
    const threads = new Map();
    for (const blockId of [pageId, ...render.ids]) {
      throwIfAborted(this.ctx.signal);
      let list;
      try {
        list = await this.api.listAll("GET", "/comments", { query: { block_id: blockId }, allow: [404] });
      } catch (err) {
        if (err?.status !== 403) throw err;
        // The integration can't read comments at all.
        this.commentsReadable = false;
        this.warn("The integration can't read comments (it lacks the \"Read comments\" capability), so none were imported.");
        return [];
      }
      for (const c of list ?? []) {
        if (!c?.id || seen.has(c.id)) continue;
        seen.add(c.id);
        const key = c.discussion_id ?? c.id;
        if (!threads.has(key)) threads.set(key, []);
        threads.get(key).push(c);
      }
    }
    const out = [];
    for (const list of threads.values()) {
      list.sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
      const parent = list[0].parent;
      const at = parent?.type === "block_id" ? render.index.get(notionId(parent.block_id)) : undefined;
      const entries = [];
      for (const c of list) {
        let text = oneLine(this.richPlain(c.rich_text));
        if (!text && Array.isArray(c.attachments) && c.attachments.length > 0) text = "(an attachment)";
        if (!text) continue;
        if (Array.isArray(c.attachments) && c.attachments.length > 0) this.warn("Files attached to comments aren't imported.");
        const personId = this.person(c.created_by, c.display_name?.resolved_name);
        entries.push({ personId, date: String(c.created_time ?? ""), text });
      }
      if (entries.length > 0) out.push({ anchor: at === undefined ? "page" : { blockIndex: at }, entries });
    }
    return out;
  }

  // ---- references, as a page is emitted

  /** `node` with its page references resolved and its titles filled in; returns it. */
  finish(node) {
    node.body = this.fixRefs(node.body, "body");
    for (const [k, v] of Object.entries(node.attributes)) {
      node.attributes[k] = Array.isArray(v) ? v.map((s) => this.fixRefs(s, "plain")) : this.fixRefs(v, "plain");
    }
    for (const c of node.comments ?? []) for (const e of c.entries) e.text = this.fixRefs(e.text, "plain");
    return node;
  }

  /** The best title known for a page or database now, or null. */
  knownTitle(id) {
    const target = this.aliases.get(id) ?? id;
    return this.titles.get(target) ?? this.titles.get(id) ?? this.searchTitle(target) ?? this.searchTitle(id) ?? null;
  }

  /**
   * `text` with each page reference pointed at what the import writes for
   * it (a database's first data source) and labelled with the best title
   * known now. The app links it once that page lands; each comes with a
   * fallback for a page the import never writes: its Notion URL and title.
   */
  fixRefs(text, context) {
    if (typeof text !== "string" || !/[-]/.test(text)) return text;
    const label = (id) => {
      const title = this.knownTitle(id);
      if (title) return context === "body" ? escapeText(title) : plainLabel(title);
      return /^[0-9a-f]{32}$/.test(id) ? (context === "body" ? escapeText(`https://www.notion.so/${id}`) : `https://www.notion.so/${id}`) : "Untitled";
    };
    return text
      .replace(/\[((?:\\.|[^\\[\]\n])*)\]\(mahfouz-import:page\/([0-9a-z-]{1,64})\)/g, (_, text, id) => {
        const target = this.aliases.get(id) ?? id;
        const title = this.knownTitle(id);
        const fallback = {};
        if (/^[0-9a-f]{32}$/.test(id)) fallback.url = `https://www.notion.so/${id}`;
        if (title) fallback.title = title;
        if (Object.keys(fallback).length > 0) this.pendingLinks.set(target, fallback);
        const bare = /^([0-9a-z-]{1,64})$/.exec(text);
        return `[${bare ? label(bare[1]) : text}](mahfouz-import:page/${target})`;
      })
      .replace(/([0-9a-z-]{1,64})/g, (_, id) => label(id))
      .replace(PRIVATE_RE, "");
  }

  searchTitle(id) {
    const page = this.searchedPages.get(id);
    if (page) return this.titleOf(page);
    const source = this.searchedSources.get(id);
    return source ? this.plainTitle(source.title) || null : null;
  }
}

/** Consecutive list items of one kind joined into one list (one top-level Markdown block). */
function group(chunks) {
  const out = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && c.kind !== "block" && last.kind === c.kind) {
      last.text += `\n${c.text}`;
      last.ids.push(...c.ids);
    } else out.push({ kind: c.kind, text: c.text, ids: [...c.ids] });
  }
  return out;
}

function indentLines(s, indent) {
  return s
    .split("\n")
    .map((l) => (l ? indent + l : l))
    .join("\n");
}
