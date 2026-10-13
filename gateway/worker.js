// Kestrel Web publish gateway: a Cloudflare Worker.
// Kestrel OS apps POST plain text here; the gateway checks it and commits the site into the KESTREL-WEB GitHub repository.
// The GitHub token lives only in this Worker (a secret named GITHUB_TOKEN); the OS never sees it.
//
// Settings (Worker variables):  REPO = "really-gavin/KESTREL-WEB"   BRANCH = "main" (optional)
//   GITHUB_TOKEN (secret)  a fine-grained token with "Contents: read and write" on that one repository
//   LIMITS (optional)      a KV namespace binding: turns on per-address and per-site rate limits
//   BLOCKLIST (optional)   comma-separated domains nobody may claim
//
// Requests (POST, text/plain; answers are text/plain whose first line is OK or ERR):
//   /check     body: domain                                     ->  OK free | OK taken | ERR why
//   /info      body: domain                                     ->  OK, then name=, description=, tags=, pages=a,b,c lines
//   /load      body: domain, newline, page                      ->  OK, then the page text (the Kestrel Web markup)
//   /publish   body: key=value header lines, a line "---", the page text  ->  OK created | OK updated | ERR why
//   /delete    body: domain=, password=, page= lines            ->  OK | ERR why
//   /report    body: a hardware report from `wifi report` (strict line format, see validReport)  ->  OK new | OK known | ERR why
//              Saved as driver-reports/<id>.txt in REPORT_REPO (default: REPO) for each adapter that has no driver; an existing report is never overwritten.
// A site's password is never stored: only a salted PBKDF2 hash of it, in sites/<domain>/.owner

export const MAX_BODY = 20000;
export const MAX_PAGE = 12000;
export const MAX_PAGES = 20;
const RESERVED = new Set(["home", "search", "docs", "news", "apps", "kestrel", "kes", "kess", "admin", "root", "www", "web", "api", "gateway", "system", "official", "secure", "help", "about", "login", "static", "assets", "test", "example", "localhost"]);

export class Reject extends Error {}
const bad = (m) => { throw new Reject(m); };

// ------------------------------------------------------------------ validation
export function validDomain(d) {
  if (typeof d !== "string") bad("write the domain name first");
  if (d.length < 3 || d.length > 30) bad("a domain needs 3 to 30 characters");
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(d)) bad("a domain may use only the letters a-z, digits and - (not at the start or end)");
  if (d.includes("--")) bad("a domain may not contain two - in a row");
  return d;
}
export function claimable(d, env) {
  validDomain(d);
  if (RESERVED.has(d)) bad("that name is reserved");
  const block = ((env && env.BLOCKLIST) || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (block.includes(d)) bad("that name is not available");
  return d;
}
export function validPage(p) {
  if (typeof p !== "string" || !/^[a-z0-9][a-z0-9-]{0,29}$/.test(p)) bad("a page name uses the letters a-z, digits and - (up to 30 characters)");
  return p;
}
function clean1(s, max, what) {
  s = (s || "").trim();
  if (s.length > max) bad(what + " is too long (the limit is " + max + " characters)");
  if (/[^\x20-\x7e]/.test(s)) bad(what + " may use only plain letters, digits and punctuation");
  return s.replace(/[|\r\n]/g, " ");
}
export function validPassword(pw) {
  if (typeof pw !== "string" || pw.length < 6) bad("the password needs at least 6 characters");
  if (pw.length > 64) bad("the password can have at most 64 characters");
  if (/[^\x20-\x7e]/.test(pw)) bad("the password may use only plain letters, digits and punctuation");
  return pw;
}

// ------------------------------------------------------------------ the page language -> HTML
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Where a link in a page of site `me` should point (a relative link, so it works in the browser with no changes).
export function linkTarget(t, me) {
  t = t.trim();
  let m;
  if ((m = /^(kes|kess):\/\/([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9\-\/.]*))?$/.exec(t))) {
    const up = m[1] === "kess" ? "../../secure/" : "../";
    const rest = m[3] || "";
    if (rest.includes("..") || rest.includes("//")) bad("that link address is not allowed: " + t);
    return up + m[2] + "/" + rest;
  }
  if (/^kes:\/\/search\?q=[a-zA-Z0-9+]{1,60}$/.test(t)) return t;
  if (/^[a-z0-9][a-z0-9-]{0,29}(\.html)?$/.test(t)) return t.endsWith(".html") ? t : t + ".html";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) bad("links may only go to other Kestrel Web pages (kes:// or kess://), not to " + t.slice(0, 40));
  bad("that link is not a page name or a kes:// address: " + t.slice(0, 40));
}

export function renderPage(source, title, me) {
  if (/[^\x09\x0a\x20-\x7e]/.test(source.replace(/\r/g, ""))) bad("the page may use only plain letters, digits and punctuation (no accents or emoji yet)");
  const out = [];
  let para = [], list = false;
  const flushPara = () => { if (para.length) { out.push("<p>" + esc(para.join(" ")) + "</p>"); para = []; } };
  const closeList = () => { if (list) { out.push("</ul>"); list = false; } };
  for (const raw of source.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if (line.trim() === "") { flushPara(); closeList(); continue; }
    if ((m = /^(#{1,3}) (.+)$/.exec(line))) { flushPara(); closeList(); out.push("<h" + m[1].length + ">" + esc(m[2].trim()) + "</h" + m[1].length + ">"); continue; }
    if ((m = /^- (.+)$/.exec(line))) { flushPara(); if (!list) { out.push("<ul>"); list = true; } out.push("<li>" + esc(m[1].trim()) + "</li>"); continue; }
    if ((m = /^\[([^\]\[]{1,80})\]\(([^()\s]{1,120})\)$/.exec(line.trim()))) { flushPara(); closeList(); out.push('<p><a href="' + esc(linkTarget(m[2], me)) + '">' + esc(m[1]) + "</a></p>"); continue; }
    closeList(); para.push(line.trim());
  }
  flushPara(); closeList();
  return "<html><head><title>" + esc(title) + "</title></head><body>\n" + out.join("\n") + "\n</body></html>\n";
}

// ------------------------------------------------------------------ passwords
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
export async function hashPassword(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations: 100000 }, key, 256));
}
export const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));
function sameHex(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

// ------------------------------------------------------------------ GitHub
export function github(env, fetchFn = fetch) {
  const base = "https://api.github.com/repos/" + env.REPO + "/contents/";
  const ref = env.BRANCH || "main";
  const hdr = { Authorization: "Bearer " + env.GITHUB_TOKEN, "User-Agent": "kestrel-gateway", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  return {
    async get(path) {
      const r = await fetchFn(base + enc(path) + "?ref=" + encodeURIComponent(ref), { headers: hdr });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("github " + r.status);
      const j = await r.json();
      if (Array.isArray(j)) return { dir: j.map((x) => x.name) };
      return { sha: j.sha, content: atob((j.content || "").replace(/\n/g, "")) };
    },
    async put(path, content, message, sha) {
      const body = { message, content: btoa(content), branch: ref };
      if (sha) body.sha = sha;
      const r = await fetchFn(base + enc(path), { method: "PUT", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 422 || r.status === 409) return false;        // exists already / changed meanwhile
      if (!r.ok) throw new Error("github " + r.status);
      return true;
    },
    async del(path, sha, message) {
      const r = await fetchFn(base + enc(path), { method: "DELETE", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify({ message, sha, branch: ref }) });
      if (!r.ok && r.status !== 404) throw new Error("github " + r.status);
    },
  };
}

// ------------------------------------------------------------------ rate limits (only when a KV namespace is bound as LIMITS)
async function limit(env, key, max, ttl, msg) {
  if (!env.LIMITS) return;
  const n = parseInt((await env.LIMITS.get(key)) || "0", 10);
  if (n >= max) bad(msg);
  await env.LIMITS.put(key, String(n + 1), { expirationTtl: ttl });
}

// ------------------------------------------------------------------ hardware reports (`wifi report` in Kestrel OS)
// Only a fixed line format is accepted, so a report can carry hardware IDs and nothing else (it is later read by people and by an AI: it must stay data).
export function validReport(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l !== "");
  if (lines.length < 3 || lines.length > 40) bad("not a Kestrel hardware report");
  if (lines[0] !== "kestrel-wifi-report 1" || lines[lines.length - 1] !== "end") bad("not a Kestrel hardware report");
  const H = "[0-9a-f]";
  const rx = [/^kestrel [a-z0-9.-]{1,20}$/, new RegExp("^pci " + H + "{4}:" + H + "{4} sub " + H + "{8} rev " + H + "{2} class " + H + "{6} driver (yes|no)$"),
    new RegExp("^usb " + H + "{4}:" + H + "{4} bcd " + H + "{4} class " + H + "{2} driver (yes|no)$"), new RegExp("^usbdesc " + H + "{36}$"), new RegExp("^usbcfg (" + H + "{2}){9,320}$")];
  const ids = [];
  for (const l of lines.slice(1, -1)) {
    if (!rx.some((r) => r.test(l))) bad("a line of the report is not allowed: " + l.slice(0, 30).replace(/[^\x20-\x7e]/g, "?"));
    let m;
    if ((m = /^pci (\w{4}):(\w{4}) .* driver no$/.exec(l))) ids.push("pci-" + m[1] + "-" + m[2]);
    if ((m = /^usb (\w{4}):(\w{4}) .* driver no$/.exec(l))) ids.push("usb-" + m[1] + "-" + m[2]);
  }
  if (!ids.length) bad("every adapter in the report already has a driver");
  return { text: lines.join("\n") + "\n", ids: [...new Set(ids)].slice(0, 4) };
}

// ------------------------------------------------------------------ parsing the request
export function parseHeaders(text) {
  const i = text.indexOf("\n---\n");
  const head = i < 0 ? text : text.slice(0, i), page = i < 0 ? "" : text.slice(i + 5);
  const h = {};
  for (const l of head.replace(/\r/g, "").split("\n")) { const k = l.indexOf("="); if (k > 0) h[l.slice(0, k).trim()] = l.slice(k + 1); }
  return { h, page };
}

const ownerPath = (d) => "sites/" + d + "/.owner";
async function readOwner(gh, d) {
  const f = await gh.get(ownerPath(d));
  if (!f) return null;
  try { return { ...JSON.parse(f.content), sha: f.sha }; } catch { return null; }
}
async function checkPassword(env, gh, d, pw, ip) {
  const o = await readOwner(gh, d);
  if (!o) bad("that domain is not available");
  await limit(env, "fail:" + d, 10, 3600, "too many wrong passwords for this site; try again in an hour");
  const h = await hashPassword(pw, o.salt);
  if (!sameHex(h, o.hash)) bad("wrong password for " + d);
  if (env.LIMITS) await env.LIMITS.delete("fail:" + d);
  return o;
}

// ------------------------------------------------------------------ the operations
export async function handle(path, body, env, gh, ip = "") {
  if (body.length > MAX_BODY) bad("the request is too large");
  if (path === "/check") {
    const d = validDomain(body.trim());
    if (RESERVED.has(d)) return "OK taken";
    return (await gh.get("sites/" + d)) ? "OK taken" : "OK free";
  }
  if (path === "/info") {
    const d = validDomain(body.trim());
    const dir = await gh.get("sites/" + d);
    if (!dir || !dir.dir) bad("no site called " + d);
    const meta = await gh.get("sites/" + d + "/site.txt");
    const pages = dir.dir.filter((n) => n.endsWith(".kml")).map((n) => n.slice(0, -4)).sort();
    const m = {}; for (const l of (meta ? meta.content : "").split("\n")) { const k = l.indexOf("="); if (k > 0) m[l.slice(0, k)] = l.slice(k + 1); }
    return "OK\nname=" + (m.name || d) + "\ndescription=" + (m.description || "") + "\ntags=" + (m.tags || "") + "\npages=" + pages.join(",");
  }
  if (path === "/load") {
    const [d0, p0] = body.replace(/\r/g, "").split("\n");
    const d = validDomain((d0 || "").trim()), p = validPage((p0 || "index").trim());
    const f = await gh.get("sites/" + d + "/" + p + ".kml");
    if (!f) bad("no such page");
    return "OK\n" + f.content;
  }
  if (path === "/publish") {
    const { h, page } = parseHeaders(body);
    const d = validDomain(h.domain), pw = validPassword(h.password), p = validPage(h.page || "index");
    const title = clean1(h.title, 80, "the page title") || d;
    const old = {};                                                  // fields left out of a later publish keep their earlier values
    const oldMeta = await gh.get("sites/" + d + "/site.txt");
    for (const l of (oldMeta ? oldMeta.content : "").split("\n")) { const k = l.indexOf("="); if (k > 0) old[l.slice(0, k)] = l.slice(k + 1); }
    const pick = (k, max, what) => (h[k] === undefined ? old[k] || "" : clean1(h[k], max, what));
    const name = pick("name", 60, "the site name") || d;
    const desc = pick("description", 160, "the description"), tags = pick("tags", 120, "the tags");
    if (page.length > MAX_PAGE) bad("the page is too long (the limit is " + MAX_PAGE + " characters)");
    const html = renderPage(page, title, d);                 // rejects anything unsafe before a single file is written
    const existing = await gh.get("sites/" + d);
    let created = false;
    if (!existing) {
      claimable(d, env);
      await limit(env, "claim:" + ip, 3, 86400, "this address has claimed enough sites for today");
      const salt = newSalt();
      const rec = JSON.stringify({ salt, hash: await hashPassword(pw, salt), created: new Date().toISOString().slice(0, 10) });
      if (!(await gh.put(ownerPath(d), rec, "Claim " + d))) bad("that domain was just taken");
      created = true;
    } else {
      await checkPassword(env, gh, d, pw, ip);
      if (!existing.dir) bad("that domain is not available");
    }
    await limit(env, "pub:" + ip, 120, 3600, "too many publishes from this address; try again later");
    if (!created) {
      const dir = existing.dir || [];
      const pages = dir.filter((n) => n.endsWith(".kml")).map((n) => n.slice(0, -4));
      if (!pages.includes(p) && pages.length >= MAX_PAGES) bad("a site can have at most " + MAX_PAGES + " pages");
    }
    const write = async (file, content, msg) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await gh.get("sites/" + d + "/" + file);
        if (cur && cur.content === content) return;
        if (await gh.put("sites/" + d + "/" + file, content, msg, cur ? cur.sha : undefined)) return;
      }
      throw new Error("could not save " + file);
    };
    await write("site.txt", "name=" + name + "\nowner=" + d + "\ndescription=" + desc + "\ntags=" + tags + "\n", (created ? "Create " : "Update ") + d);
    await write(p + ".kml", page, "Page " + d + "/" + p);
    await write(p === "index" ? "index.html" : p + ".html", html, "Page " + d + "/" + p);
    return "OK " + (created ? "created" : "updated") + "\nkes://" + d + "/" + (p === "index" ? "" : p);
  }
  if (path === "/report") {
    const { text, ids } = validReport(body);
    await limit(env, "rep:" + ip, 10, 86400, "this address has sent enough reports for today");
    const rgh = env.REPORT_REPO && env.REPORT_REPO !== env.REPO ? github({ ...env, REPO: env.REPORT_REPO }) : gh;
    let fresh = 0;
    for (const id of ids) {
      const file = "driver-reports/" + id + ".txt";
      if (await rgh.get(file)) continue;
      if (await rgh.put(file, text, "Report " + id)) fresh++;
    }
    return "OK " + (fresh ? "new" : "known");
  }
  if (path === "/delete") {
    const { h } = parseHeaders(body);
    const d = validDomain(h.domain), pw = validPassword(h.password), p = validPage(h.page || "");
    if (p === "index") bad("the front page cannot be deleted");
    await checkPassword(env, gh, d, pw, ip);
    let n = 0;
    for (const f of [p + ".kml", p + ".html"]) {
      const cur = await gh.get("sites/" + d + "/" + f);
      if (cur) { await gh.del("sites/" + d + "/" + f, cur.sha, "Delete " + d + "/" + p); n++; }
    }
    if (!n) bad("no such page");
    return "OK deleted";
  }
  bad("unknown request");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=us-ascii", "Cache-Control": "no-store" } });
    if (req.method !== "POST") return text("Kestrel Web gateway. Kestrel OS apps use this address to publish sites.\n");
    if (!env.GITHUB_TOKEN || !env.REPO) return text("ERR the gateway is not set up yet (GITHUB_TOKEN or REPO is missing)", 500);
    try {
      const body = await req.text();
      return text(await handle(url.pathname, body, env, github(env), req.headers.get("CF-Connecting-IP") || ""));
    } catch (e) {
      if (e instanceof Reject) return text("ERR " + e.message, 400);
      return text("ERR the gateway had a problem; try again in a minute", 500);
    }
  },
};
