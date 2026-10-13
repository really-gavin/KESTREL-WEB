import test from "node:test";
import assert from "node:assert/strict";
import worker, { handle, github, renderPage, validDomain, linkTarget, hashPassword, Reject, MAX_PAGES } from "./worker.js";

// An in-memory stand-in for GitHub's contents API.
function fakeGithub() {
  const files = new Map(); let n = 0;
  const gh = {
    files,
    async get(path) {
      if (files.has(path)) return { sha: files.get(path).sha, content: files.get(path).content };
      const pre = path + "/", kids = new Set();
      for (const k of files.keys()) if (k.startsWith(pre)) kids.add(k.slice(pre.length).split("/")[0]);
      return kids.size ? { dir: [...kids] } : null;
    },
    async put(path, content, msg, sha) {
      const cur = files.get(path);
      if (cur && cur.sha !== sha) return false;
      if (!cur && sha) return false;
      files.set(path, { content, sha: "s" + ++n }); return true;
    },
    async del(path, sha) { files.delete(path); },
  };
  return gh;
}
const env = {};
const pub = (gh, fields, page, ip = "1.1.1.1") =>
  handle("/publish", Object.entries(fields).map(([k, v]) => k + "=" + v).join("\n") + "\n---\n" + page, env, gh, ip);
const rejects = async (p, re) => assert.rejects(p, (e) => e instanceof Reject && re.test(e.message), String(re));

test("domain rules", () => {
  for (const d of ["abc", "my-site", "a1b", "x".repeat(30)]) assert.equal(validDomain(d), d);
  for (const d of ["ab", "x".repeat(31), "-ab", "ab-", "a--b", "Abc", "a b", "a.b", "a/b", "", undefined, "été"]) assert.throws(() => validDomain(d), Reject, String(d));
});

test("check: free, taken, reserved, invalid", async () => {
  const gh = fakeGithub();
  assert.equal(await handle("/check", "mysite", env, gh), "OK free");
  assert.equal(await handle("/check", "docs", env, gh), "OK taken");
  await pub(gh, { domain: "mysite", password: "secret1" }, "# Hi");
  assert.equal(await handle("/check", "mysite\n", env, gh), "OK taken");
  await rejects(handle("/check", "No Good", env, gh), /letters/);
});

test("publish creates, then updates with the password", async () => {
  const gh = fakeGithub();
  let r = await pub(gh, { domain: "mysite", password: "secret1", name: "My Site", description: "d", tags: "a b", title: "Welcome" }, "# Hello\nsome text\n- one\n- two\n");
  assert.equal(r, "OK created\nkes://mysite/");
  const html = gh.files.get("sites/mysite/index.html").content;
  assert.match(html, /<title>Welcome<\/title>/); assert.match(html, /<h1>Hello<\/h1>/); assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.equal(gh.files.get("sites/mysite/site.txt").content, "name=My Site\nowner=mysite\ndescription=d\ntags=a b\n");
  assert.ok(gh.files.get("sites/mysite/index.kml"));
  const owner = JSON.parse(gh.files.get("sites/mysite/.owner").content);
  assert.equal(owner.hash, await hashPassword("secret1", owner.salt)); assert.ok(!gh.files.get("sites/mysite/.owner").content.includes("secret1"));
  await rejects(pub(gh, { domain: "mysite", password: "wrong-pw" }, "# Hacked"), /wrong password/);
  assert.match(gh.files.get("sites/mysite/index.html").content, /Hello/);
  r = await pub(gh, { domain: "mysite", password: "secret1", page: "about" }, "# About\n[Home](index)\n[Docs](kes://docs/wifi)\n[Official](kess://kestrel/)");
  assert.equal(r, "OK updated\nkes://mysite/about");
  const about = gh.files.get("sites/mysite/about.html").content;
  assert.match(about, /href="index.html"/); assert.match(about, /href="..\/docs\/wifi"/); assert.match(about, /href="..\/..\/secure\/kestrel\/"/);
  assert.equal(await handle("/info", "mysite", env, gh), "OK\nname=My Site\ndescription=d\ntags=a b\npages=about,index");
  assert.equal(await handle("/load", "mysite\nabout", env, gh), "OK\n# About\n[Home](index)\n[Docs](kes://docs/wifi)\n[Official](kess://kestrel/)");
});

test("an unchanged republish writes nothing new", async () => {
  const gh = fakeGithub();
  await pub(gh, { domain: "same", password: "secret1" }, "# A");
  const before = [...gh.files].map(([k, v]) => k + v.sha).sort().join();
  await pub(gh, { domain: "same", password: "secret1" }, "# A");
  assert.equal([...gh.files].map(([k, v]) => k + v.sha).sort().join(), before);
});

test("sites that exist without an owner (the starter sites) and reserved names cannot be claimed", async () => {
  const gh = fakeGithub(); gh.files.set("sites/news/index.html", { content: "x", sha: "z" });
  await rejects(pub(gh, { domain: "news", password: "secret1" }, "# x"), /not available/);
  await rejects(pub(gh, { domain: "kestrel", password: "secret1" }, "# x"), /reserved/);
  await rejects(handle("/publish", "domain=zzz\npassword=secret1\n---\n# x", { BLOCKLIST: "zzz,yyy" }, gh), /not available/);
});

test("nothing unsafe gets through the page language", async () => {
  const gh = fakeGithub();
  const html = renderPage('# <script>alert(1)</script>\nA & B "q" <b>x</b>\n- <img src=x onerror=1>\n', 'T"><script>', "me");
  assert.ok(!/<script|<img|<b>/.test(html)); assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('T"><'));
  for (const t of ["http://evil.example/", "https://evil.example/", "javascript:alert(1)", "data:text/html,x", "//evil.example", "kes://a/../../x", "UPPER", "a b", "mailto:x@y.z"])
    assert.throws(() => linkTarget(t, "me"), Reject, t);
  assert.throws(() => renderPage("café", "T", "me"), Reject);
  assert.throws(() => renderPage("emoji 😀", "T", "me"), Reject);
  await rejects(pub(gh, { domain: "evil", password: "secret1" }, "[x](http://evil.example/)"), /only go to other Kestrel Web/);
  assert.equal(gh.files.size, 0, "a rejected page must not claim the domain");
  assert.match(renderPage("[Search](kes://search?q=wifi)", "T", "m"), /href="kes:\/\/search\?q=wifi"/);
});

test("limits and bad input", async () => {
  const gh = fakeGithub();
  await rejects(pub(gh, { domain: "big", password: "secret1" }, "a".repeat(12001)), /too long/);
  await rejects(pub(gh, { domain: "big", password: "short" }, "x"), /at least 6/);
  await rejects(pub(gh, { domain: "big", password: "secret1", title: "t".repeat(81) }, "x"), /too long/);
  await rejects(pub(gh, { domain: "big", password: "secret1", page: "Bad Page" }, "x"), /page name/);
  await rejects(handle("/publish", "x".repeat(20001), env, gh), /too large/);
  await rejects(handle("/nothing", "", env, gh), /unknown/);
  await pub(gh, { domain: "pages", password: "secret1" }, "# i");
  for (let i = 1; i < MAX_PAGES; i++) await pub(gh, { domain: "pages", password: "secret1", page: "p" + i }, "# " + i);
  await rejects(pub(gh, { domain: "pages", password: "secret1", page: "one-more" }, "# x"), /at most/);
  await pub(gh, { domain: "pages", password: "secret1", page: "p1" }, "# changed");            // existing pages can still change
});

test("delete a page", async () => {
  const gh = fakeGithub();
  await pub(gh, { domain: "del", password: "secret1" }, "# i"); await pub(gh, { domain: "del", password: "secret1", page: "x" }, "# x");
  await rejects(handle("/delete", "domain=del\npassword=nope-nope\npage=x", env, gh), /wrong password/);
  await rejects(handle("/delete", "domain=del\npassword=secret1\npage=index", env, gh), /front page/);
  assert.equal(await handle("/delete", "domain=del\npassword=secret1\npage=x", env, gh), "OK deleted");
  assert.ok(!gh.files.has("sites/del/x.html") && !gh.files.has("sites/del/x.kml") && gh.files.has("sites/del/index.html"));
  await rejects(handle("/delete", "domain=del\npassword=secret1\npage=x", env, gh), /no such page/);
});

test("two people claiming the same name at once: exactly one wins", async () => {
  const gh = fakeGithub();
  const a = pub(gh, { domain: "race", password: "aaaaaa" }, "# a"), b = pub(gh, { domain: "race", password: "bbbbbb" }, "# b");
  const r = await Promise.allSettled([a, b]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(r.map((x) => x.status)));
});

test("rate limits (with a KV namespace)", async () => {
  const kv = new Map(); const env2 = { LIMITS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) } };
  const gh = fakeGithub();
  for (const d of ["aaa", "bbb", "ccc"]) await handle("/publish", `domain=${d}\npassword=secret1\n---\n# x`, env2, gh, "9.9.9.9");
  await rejects(handle("/publish", "domain=ddd\npassword=secret1\n---\n# x", env2, gh, "9.9.9.9"), /claimed enough/);
  await handle("/publish", "domain=ddd\npassword=secret1\n---\n# x", env2, gh, "8.8.8.8");
  for (let i = 0; i < 10; i++) await rejects(handle("/publish", "domain=aaa\npassword=wrong-pw\n---\n# x", env2, gh, "7.7.7.7"), /wrong password/);
  await rejects(handle("/publish", "domain=aaa\npassword=secret1\n---\n# x", env2, gh, "7.7.7.7"), /too many wrong passwords/);
});

test("the GitHub client speaks the contents API (paths, base64, sha, 422)", async () => {
  const calls = []; const store = new Map();
  const fetchFn = async (url, opt = {}) => {
    const u = new URL(url); const path = decodeURIComponent(u.pathname.replace("/repos/o/r/contents/", ""));
    calls.push([opt.method || "GET", path, opt.headers.Authorization]);
    if (!opt.method) { const f = store.get(path); return f ? new Response(JSON.stringify({ sha: f.sha, content: btoa(f.c) + "\n" }), { status: 200 }) : new Response("{}", { status: 404 }); }
    const b = JSON.parse(opt.body);
    if (opt.method === "PUT") { const cur = store.get(path); if (cur && cur.sha !== b.sha) return new Response("{}", { status: 422 }); store.set(path, { c: atob(b.content), sha: "n" + store.size + "x" }); return new Response("{}", { status: 201 }); }
    store.delete(path); return new Response("{}", { status: 200 });
  };
  const g = github({ REPO: "o/r", GITHUB_TOKEN: "tok" }, fetchFn);
  assert.equal(await g.get("a/b.txt"), null);
  assert.equal(await g.put("a/b.txt", "hi", "m"), true);
  assert.equal(await g.put("a/b.txt", "again", "m"), false);
  const cur = await g.get("a/b.txt"); assert.equal(cur.content, "hi");
  assert.equal(await g.put("a/b.txt", "again", "m", cur.sha), true);
  assert.ok(calls.every((c) => c[2] === "Bearer tok"));
});

test("the HTTP wrapper", async () => {
  const r = await worker.fetch(new Request("https://g.test/check", { method: "POST", body: "x" }), {});
  assert.equal(r.status, 500); assert.match(await r.text(), /not set up/);
  const g = await worker.fetch(new Request("https://g.test/"), {});
  assert.match(await g.text(), /Kestrel Web gateway/);
});
