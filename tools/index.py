#!/usr/bin/env python3
"""Kestrel Web indexer: reads sites/ and secure/, writes _search/<term>.txt.
Each line of a term file:  score|address|title|snippet   (best first)."""
import os, re, sys, html
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STOP = set("the and for are but not you all any can had her was one our out has have this that with from they will what when your then them were been into more some such than also its who how".split())
TOP = 20

def norm_word(w):
    w = w.lower()
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        w = w[:-1]
    return w

def words(text):
    return [norm_word(w) for w in re.findall(r"[A-Za-z0-9]+", text)]

class P(HTMLParser):
    def __init__(s):
        super().__init__(); s.title = ""; s.text = []; s.skip = 0; s.in_title = False; s.links = []
    def handle_starttag(s, t, a):
        if t in ("script", "style"): s.skip += 1
        if t == "title": s.in_title = True
        if t == "a":
            for k, v in a:
                if k == "href" and v: s.links.append(v)
    def handle_endtag(s, t):
        if t in ("script", "style") and s.skip: s.skip -= 1
        if t == "title": s.in_title = False
    def handle_data(s, d):
        if s.in_title: s.title += d
        elif not s.skip: s.text.append(d)

def read_manifest(path):
    m = {}
    try:
        for ln in open(path, encoding="utf-8"):
            if "=" in ln:
                k, v = ln.rstrip("\n").split("=", 1); m[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return m

def clean(s, n):
    s = re.sub(r"[|\[\]()<>]", " ", s); s = re.sub(r"\s+", " ", s).strip()
    s = "".join(c if 32 <= ord(c) < 127 else "?" for c in s)
    return s[:n]

def crawl(root=ROOT):
    docs = []
    for folder, scheme in (("sites", "kes"), ("secure", "kess")):
        base = os.path.join(root, folder)
        if not os.path.isdir(base): continue
        for host in sorted(os.listdir(base)):
            hd = os.path.join(base, host)
            if not os.path.isdir(hd) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", host): continue
            man = read_manifest(os.path.join(hd, "site.txt"))
            for dp, _, fs in sorted(os.walk(hd)):
                for f in sorted(fs):
                    if not f.endswith(".html"): continue
                    rel = os.path.relpath(os.path.join(dp, f), hd).replace(os.sep, "/")
                    raw = open(os.path.join(dp, f), encoding="utf-8", errors="replace").read()
                    p = P(); p.feed(raw)
                    body = html.unescape(" ".join(p.text))
                    addr = "%s://%s/%s" % (scheme, host, "" if rel == "index.html" else rel)
                    docs.append(dict(addr=addr, title=clean(html.unescape(p.title) or man.get("name", host), 60),
                                     body=body, man=man, host=host, front=(rel == "index.html")))
    return docs

def build(docs):
    idx = {}
    for d in docs:
        sc = {}
        def add(ws, wt, cap=None):
            for w in ws:
                if len(w) < 2 or len(w) > 24 or w in STOP: continue
                sc[w] = sc.get(w, 0) + wt
        add(words(d["title"]), 10)
        add(words(d["man"].get("tags", "")), 8)
        add(words(d["man"].get("name", "")), 6)
        add(words(d["man"].get("description", "")), 4)
        bw = words(d["body"]); cnt = {}
        for w in bw:
            if len(w) < 2 or len(w) > 24 or w in STOP: continue
            cnt[w] = cnt.get(w, 0) + 1
        for w, c in cnt.items(): sc[w] = sc.get(w, 0) + min(c, 5)
        snip = clean(d["body"], 90)
        for w, s in sc.items():
            if d["front"]: s += 2
            idx.setdefault(w, []).append((s, d["addr"], d["title"], snip))
    out = {}
    for w, rows in idx.items():
        rows.sort(key=lambda r: (-r[0], r[1]))
        out[w] = ["%d|%s|%s|%s" % r for r in rows[:TOP]]
    return out

def write(out, root=ROOT):
    sd = os.path.join(root, "_search")
    os.makedirs(sd, exist_ok=True)
    for f in os.listdir(sd):
        if f.endswith(".txt"): os.remove(os.path.join(sd, f))
    for w, lines in out.items():
        with open(os.path.join(sd, w + ".txt"), "w", encoding="ascii", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")

def search(out, query):
    """Reference for what the browser does: AND of all terms, scores added."""
    ws = [w for w in words(query) if len(w) >= 2 and len(w) <= 24 and w not in STOP][:3]
    if not ws: return []
    tot = {}
    for i, w in enumerate(ws):
        cur = {}
        for ln in out.get(w, []):
            s, a, t, sn = ln.split("|", 3); cur[a] = (int(s), t, sn)
        if i == 0: tot = cur
        else: tot = {a: (tot[a][0] + cur[a][0], tot[a][1], tot[a][2]) for a in tot if a in cur}
    return sorted(((s, a, t, sn) for a, (s, t, sn) in tot.items()), key=lambda r: (-r[0], r[1]))

if __name__ == "__main__":
    docs = crawl(); out = build(docs); write(out)
    print("indexed %d pages, %d terms" % (len(docs), len(out)))
