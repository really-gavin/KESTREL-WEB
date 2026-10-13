import sys, os
sys.path.insert(0, '/home/claude/kestrel-src/kestrel/tools')
import kestrel, kestvm
from kestvm import App, Trap
BASE = "https://raw.githubusercontent.com/really-gavin/KESTREL-WEB/main/"
ROOT = "/home/claude/kestrel-web/"
kestvm.ARITY[:] = kestvm.ARITY[:43] + [1, 1, 1, 2][:4]
class M(App):
    def string(self, a):
        a &= 0xFFFFFFFF
        if a < 16 or a >= self.memsz: raise Trap('bad string')
        e = self.mem.find(b'\0', a, self.memsz)
        return bytes(self.mem[a:e])
    def put(self, b):
        p = self.alloc(len(b) + 1); self.mem[p:p+len(b)] = b; return p
    def sys(self, n, a):
        if n == 36:
            x = self.string(a[0]) + self.string(a[1]); return self.put(x)
        if n == 43:
            url = self.string(a[0]).decode()
            self.fetched.append(url)
            assert url.startswith(BASE), url
            path = ROOT + url[len(BASE):]
            if os.path.isfile(path):
                body = open(path, 'rb').read().decode()
                out = "=%s\n@x\n%s" % (url, body)
            else:
                out = "=%s\n@Could not load\n\n# Could not load this page\n" % url
            if not hasattr(self, 'pg'): self.pg = self.alloc(48008)
            b = out.encode()[:48000]; self.mem[self.pg:self.pg+len(b)+1] = b + b'\0'; return self.pg
        return super().sys(n, a)
src = open(sys.argv[1]).read()
data = kestrel.compile_source(src, 't.kes') if hasattr(kestrel, 'compile_source') else None
data = kestrel.compile_source(src, 't.kes')
m = M(data); m.fetched = []
try: m.run(max_steps=200_000_000)
except Trap as e: print("TRAP", e)
except Exception:
    import traceback; traceback.print_exc()
print(bytes(m.term_bytes).decode() if hasattr(m,'term_bytes') else ''.join(m.term) if m.term and isinstance(m.term[0], str) else b''.join(m.term).decode())
print("FETCHED", m.fetched, "exit", m.exit_code, "trap", m.trap)
