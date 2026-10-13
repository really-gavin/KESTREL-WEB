import os, sys, tempfile, shutil, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import index

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def mk(root, folder, host, files, man="name=T\ntags=\n"):
    d = os.path.join(root, folder, host); os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "site.txt"), "w").write(man)
    for n, c in files.items():
        os.makedirs(os.path.dirname(os.path.join(d, n)), exist_ok=True)
        open(os.path.join(d, n), "w").write(c)

class T(unittest.TestCase):
    def test_real_repo(self):
        out = index.build(index.crawl(ROOT))
        r = index.search(out, "wifi")
        self.assertEqual(r[0][1], "kes://docs/wifi.html")
        r = index.search(out, "Setting WiFi")
        self.assertEqual(r[0][1], "kes://docs/wifi.html")
        self.assertEqual(index.search(out, "zzzzqq"), [])
        self.assertEqual(index.search(out, ""), [])
        self.assertEqual(index.search(out, "the and"), [])
        self.assertTrue(any(a.startswith("kess://") for _, a, _, _ in index.search(out, "official")))
    def test_and_semantics(self):
        r = tempfile.mkdtemp()
        try:
            mk(r, "sites", "a", {"index.html": "<title>A</title><p>apple banana</p>"})
            mk(r, "sites", "b", {"index.html": "<title>B</title><p>apple cherry</p>"})
            out = index.build(index.crawl(r))
            self.assertEqual(len(index.search(out, "apple")), 2)
            self.assertEqual([x[1] for x in index.search(out, "apple banana")], ["kes://a/"])
            self.assertEqual(index.search(out, "banana cherry"), [])
        finally: shutil.rmtree(r)
    def test_hostile_content(self):
        r = tempfile.mkdtemp()
        try:
            mk(r, "sites", "x", {"index.html": "<title>a|bé</title><script>secret</script><p>visïble | pipe</p>", "Bad Name.html": "x"})
            mk(r, "sites", "Bad_Host", {"index.html": "<p>nope</p>"})
            out = index.build(index.crawl(r))
            self.assertEqual(index.search(out, "secret"), [])
            self.assertEqual(index.search(out, "nope"), [])
            for ln in out["pipe"]:
                self.assertEqual(ln.count("|"), 3)
                ln.encode("ascii")
        finally: shutil.rmtree(r)
    def test_write_roundtrip(self):
        r = tempfile.mkdtemp()
        try:
            mk(r, "sites", "a", {"index.html": "<p>hello world</p>"})
            index.write(index.build(index.crawl(r)), r)
            self.assertTrue(os.path.exists(os.path.join(r, "_search", "hello.txt")))
            index.write({}, r)
            self.assertFalse(os.path.exists(os.path.join(r, "_search", "hello.txt")))
        finally: shutil.rmtree(r)
unittest.main()
