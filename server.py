#!/usr/bin/env python3
"""Browser UI for Claude Code.
    python3 server.py [project-folder]   (default: current folder); opens http://127.0.0.1:8765
Builds web/ on first run (needs npm); after UI changes run `npm run build` in web/, or use `npm run dev` for UI work.
"""
import json, mimetypes, os, re, select, socket, subprocess, sys, threading, time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
DIST = (Path(__file__).parent / "web" / "dist").resolve()
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
# Claude Code stores transcripts per project dir, path mangled to dashes.
SESSIONS = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(ROOT))
MODES = {"default", "acceptEdits", "plan", "bypassPermissions"}
HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ORIGINS = HOSTS | {"127.0.0.1:5173", "localhost:5173"}  # + the Vite dev server, which proxies to us
UUID = re.compile(r"^[0-9a-f-]{36}$")
IDLE_SECS = 30 * 60  # live Claude processes with no traffic for this long are closed (the next message resumes them)
# This UI renders Mermaid; models often name a node "graph", which Mermaid rejects.
SYSTEM_NOTE = ("Replies are shown in a web UI that renders Markdown and Mermaid. In Mermaid diagrams never use keywords "
               "(graph, end, subgraph, flowchart, class, style, click) as node ids; e.g. write graphMod[\"graph.ts\"].")


def inside(rel):
    p = (ROOT / rel).resolve()
    if not p.is_relative_to(ROOT):
        raise PermissionError(rel)
    return p


def first_prompt(f):
    with f.open() as fh:
        for line in fh:
            d = json.loads(line)
            c = d.get("message", {}).get("content") if d.get("type") == "user" and not d.get("isMeta") else None
            if isinstance(c, str) and not c.startswith("<"):
                return c[:120]
    return "(no prompt)"


def list_sessions():
    files = sorted(SESSIONS.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)[:50]  # ponytail: newest 50, paginate if needed
    return [{"id": f.stem, "title": first_prompt(f), "mtime": f.stat().st_mtime} for f in files]


CLIP = 20_000  # the page shows at most this much of one tool output


def clip(content):
    """Trim what the page never shows before sending a transcript: long tool outputs (it cuts them anyway), images
    returned by tools (screenshots Claude looked at), and thinking signatures. Images you sent are kept."""
    for b in content if isinstance(content, list) else []:
        b.pop("signature", None)
        if b.get("type") != "tool_result":
            continue
        c = b.get("content")
        if isinstance(c, str) and len(c) > CLIP:
            b["content"] = c[:CLIP] + "\n… (truncated)"
        elif isinstance(c, list):
            b["content"] = c = [p if p.get("type") != "image" else {"type": "text", "text": "[image]"} for p in c]
            for part in c:
                if part.get("type") == "text" and len(part.get("text", "")) > CLIP:
                    part["text"] = part["text"][:CLIP] + "\n… (truncated)"
    return content


def load_session(sid):
    msgs = []
    with (SESSIONS / f"{sid}.jsonl").open() as fh:
        for line in fh:
            d = json.loads(line)
            if d.get("type") in ("user", "assistant") and not d.get("isSidechain") and not d.get("isMeta"):
                m = {"role": d["type"], "content": clip(d["message"]["content"])}
                if d["type"] == "assistant" and d["message"].get("usage"):
                    m["usage"] = d["message"]["usage"]  # for the context meter
                msgs.append(m)
    return msgs


def get_tree(rel):
    p = inside(rel)
    items = [{"name": c.name, "dir": c.is_dir()} for c in p.iterdir() if c.name != ".git"]
    return sorted(items, key=lambda i: (not i["dir"], i["name"].lower()))


SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target"}
_files = {"at": 0.0, "list": []}


def project_files():
    """Every file in the project (git's view when it's a repo, so .gitignore applies), cached for a few seconds."""
    if time.time() - _files["at"] < 10:
        return _files["list"]
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, timeout=10)
        files = out.stdout.splitlines() if out.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        files = None
    if files is None:  # not a git repo: walk it, skipping the usual heavy folders
        files = []
        for d, dirs, names in os.walk(ROOT):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
            files += [str(Path(d, n).relative_to(ROOT)) for n in names]
            if len(files) > 50_000:  # ponytail: huge trees get cut off; a real index if that bites
                break
    _files.update(at=time.time(), list=files)
    return files


def spread(q, text):
    """Query letters in order inside text: how spread out the tightest left-anchored match is (None if no match)."""
    best = None
    for start in [i for i, ch in enumerate(text) if ch == q[0]][:20]:  # ponytail: first 20 starts is plenty for paths
        i = start
        for ch in q[1:]:
            i = text.find(ch, i + 1)
            if i < 0:
                break
        else:
            span = i - start + 1 - len(q)
            best = span if best is None else min(best, span)
    return best


def find_files(q, limit=40):
    """Fuzzy file search for @ mentions. Ranks: substring of the file name, substring of the path,
    letters in order within the file name, then within the path; tighter matches and shorter paths first."""
    q = q.lower().replace(" ", "")
    scored = []
    for f in project_files():
        low = f.lower()
        name = low.rsplit("/", 1)[-1]
        if not q:
            score = f.count("/")
        elif q in name:
            score = name.index(q) / 100
        elif q in low:
            score = 10
        elif (g := spread(q, name)) is not None:
            score = 20 + g
        elif (g := spread(q, low)) is not None:
            score = 40 + g
        else:
            continue
        scored.append((score, len(f), f))
    return [f for *_, f in sorted(scored)[:limit]]


def git(*args, timeout=30, stdin=None):
    """Run git in the project; returns (ok, output). Paths always come after `--` (never read as options)."""
    try:
        r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, input=stdin)
        return r.returncode == 0, (r.stdout if r.returncode == 0 else (r.stderr or r.stdout)).strip("\n")
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)


def git_state():
    """Branch, ahead/behind, changed files (staged / unstaged / untracked with line counts), recent commits."""
    ok, out = git("status", "--porcelain=v1", "-b", "-z", "--untracked-files=all")
    if not ok:
        return {"repo": False, "error": out}
    entries = out.split("\0")
    head = entries[0][3:] if entries and entries[0].startswith("## ") else ""
    branch = head.split("...")[0].replace("No commits yet on ", "")
    ahead = int(m.group(1)) if (m := re.search(r"ahead (\d+)", head)) else 0
    behind = int(m.group(1)) if (m := re.search(r"behind (\d+)", head)) else 0
    files, i = [], 1
    while i < len(entries):
        e = entries[i]
        i += 1
        if len(e) < 4:
            continue
        x, y, path = e[0], e[1], e[3:]
        if x in "RC":
            i += 1  # the rename's old path follows
        files.append({"path": path, "x": x, "y": y})
    counts = {}
    for staged in (True, False):
        ok, out = git("diff", "--numstat", *(["--cached"] if staged else []))
        for line in out.splitlines() if ok else []:
            a, d, path = (line.split("\t", 2) + ["", ""])[:3]
            key = (path.split(" => ")[-1].rstrip("}"), staged)
            counts[key] = (int(a) if a.isdigit() else 0, int(d) if d.isdigit() else 0)
    for f in files:
        f["staged"] = list(counts.get((f["path"], True), (0, 0)))
        f["unstaged"] = list(counts.get((f["path"], False), (0, 0)))
    ok, out = git("log", "-n", "12", "--pretty=format:%h%x1f%s%x1f%cr%x1f%an")
    log = [dict(zip(("hash", "subject", "when", "author"), l.split("\x1f"))) for l in out.splitlines()] if ok else []
    return {"repo": True, "branch": branch or "(detached)", "upstream": "..." in head, "ahead": ahead, "behind": behind, "files": files, "log": log}


def git_diff(rel, staged):
    inside(rel)  # stays in the project
    ok, out = git("diff", *(["--cached"] if staged else []), "--", rel)
    if ok and not out and not staged:  # untracked: show the whole file as added
        ok, out = git("diff", "--no-index", "--", "/dev/null", rel)
        ok = True  # --no-index exits 1 when files differ
    return {"diff": out[:400_000]}


def git_message():
    """A commit message for the staged changes, written by a one-off Claude call."""
    ok, diff = git("diff", "--cached", "--stat", "--patch")
    if not ok or not diff.strip():
        return {"error": "Nothing staged to describe."}
    prompt = ("Write a git commit message for this staged diff. First line: imperative summary under 70 characters. "
              "Then a blank line and a short body only if the change needs explaining. Reply with the message only, no code fences.")
    try:
        r = subprocess.run(["claude", "-p", "--model", "haiku", prompt], cwd=ROOT, input=diff[:80_000], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"error": str(e)}
    return {"message": r.stdout.strip()} if r.returncode == 0 else {"error": (r.stderr or r.stdout).strip()[:500]}


def git_op(body):
    op, paths = body.get("op"), [str(p) for p in body.get("paths") or []]
    for p in paths:
        inside(p)
    if op == "stage":
        ok, out = git("add", "--", *paths) if paths else git("add", "-A")
    elif op == "unstage":
        ok, out = git("restore", "--staged", "--", *paths) if paths else git("reset", "-q")
    elif op == "commit":
        msg = str(body.get("message", "")).strip()
        if not msg:
            return {"ok": False, "out": "Write a commit message first."}
        ok, out = git("commit", "-F", "-", stdin=msg)
    elif op == "push":
        ok, out = git("push", timeout=120)
        if not ok and "no upstream" in out:
            ok, out = git("push", "-u", "origin", "HEAD", timeout=120)
    elif op == "pull":
        ok, out = git("pull", "--ff-only", timeout=120)
    elif op == "init":
        ok, out = git("init")
    elif op == "message":
        return git_message()
    else:
        return {"ok": False, "out": f"unknown op {op}"}
    return {"ok": ok, "out": out[-4000:]}


def get_file(rel):
    data = inside(rel).read_bytes()[:1_000_000]  # ponytail: 1MB cap, viewer not an editor
    return {"text": None if b"\0" in data else data.decode("utf-8", "replace")}


CLAUDE = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
          "--include-partial-messages", "--replay-user-messages", "--append-system-prompt", SYSTEM_NOTE,
          "--permission-prompt-tool", "stdio"]  # tool approvals (incl. plan approval) come to the page as control_requests


class Live:
    """One long-running `claude` per session card: messages go in on stdin (queued while busy, like the terminal),
    output is buffered so the page can (re)attach to the stream at any point."""

    KEEP = 20_000  # ponytail: output lines kept for re-attaching; older ones dropped (the transcript has them)

    def __init__(self, sid, mode, model):
        cmd = [*CLAUDE, *(["--resume", sid] if sid else []), *(["--permission-mode", mode] if mode in MODES else []),
               *(["--model", model] if model else [])]
        self.p = subprocess.Popen(cmd, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.mode, self.model = mode, model
        self.lines, self.base, self.last = [], 0, time.time()
        self.asks = {}  # open approval requests: request_id -> the request line (re-sent to pages that attach later)
        self.cond = threading.Condition()
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        for line in self.p.stdout:
            if not line.strip():
                continue
            if not line.startswith("{"):  # stderr noise -> an error line the page can show
                line = json.dumps({"type": "error", "text": line.strip()}) + "\n"
            elif '"can_use_tool"' in line or '"permissionMode"' in line:
                d = json.loads(line)
                if d.get("type") == "control_request" and d["request"].get("subtype") == "can_use_tool":
                    self.asks[d["request_id"]] = line
                elif d.get("subtype") == "status" and d.get("permissionMode"):
                    self.mode = d["permissionMode"]  # e.g. plan approved -> Claude left plan mode
            self.push(line)
        self.push(json.dumps({"type": "exit", "code": self.p.wait()}) + "\n")

    def push(self, line):
        with self.cond:
            self.lines.append(line)
            if len(self.lines) > self.KEEP:
                drop = len(self.lines) - self.KEEP // 2
                del self.lines[:drop]
                self.base += drop
            self.last = time.time()
            self.cond.notify_all()

    @property
    def alive(self):
        return self.p.poll() is None

    def write(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()
        self.last = time.time()

    def control(self, subtype, **kw):
        self.write({"type": "control_request", "request_id": f"ui-{time.time_ns()}", "request": {"subtype": subtype, **kw}})

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.p.kill()


LIVE = {}  # card id (from the page) -> Live
LIVE_LOCK = threading.Lock()


def reap():
    while True:
        time.sleep(60)
        with LIVE_LOCK:
            idle = [cid for cid, lv in LIVE.items() if not lv.alive or time.time() - lv.last > IDLE_SECS]
            for cid in idle:
                LIVE.pop(cid).close()


META = {}


def meta():
    """Models and slash commands / skills, from Claude's own `initialize` answer (asked once, cached)."""
    if not META:
        lv = Live(None, None, None)
        lv.control("initialize")
        deadline = time.time() + 20
        with lv.cond:
            while time.time() < deadline and not META:
                for line in lv.lines:
                    d = json.loads(line)
                    if d.get("type") == "control_response":
                        r = d["response"].get("response") or {}
                        META.update(models=r.get("models", []), commands=r.get("commands", []))
                lv.cond.wait(1)
        lv.close()
    return META


class H(BaseHTTPRequestHandler):
    def send_json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("Host") not in HOSTS:  # DNS rebinding would otherwise expose your files
            return self.send_error(403)
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/events":
            return self.events(q.get("cid", ""), int(q.get("from", "-1")))
        try:
            if not url.path.startswith("/api/"):
                self.static(url.path)
            elif url.path == "/api/info":
                self.send_json({"root": str(ROOT)})
            elif url.path == "/api/tree":
                self.send_json(get_tree(q.get("path", "")))
            elif url.path == "/api/file":
                self.send_json(get_file(q["path"]))
            elif url.path == "/api/git":
                self.send_json(git_state())
            elif url.path == "/api/git/diff":
                self.send_json(git_diff(q["path"], q.get("staged") == "1"))
            elif url.path == "/api/files":
                self.send_json(find_files(q.get("q", "")))
            elif url.path == "/api/meta":
                self.send_json(meta())
            elif url.path == "/api/sessions":
                self.send_json(list_sessions() if SESSIONS.is_dir() else [])
            elif url.path == "/api/session" and UUID.match(q.get("id", "")):
                self.send_json(load_session(q["id"]))
            else:
                self.send_error(404)
        except PermissionError:
            self.send_json({"error": "outside project folder"}, 403)
        except (OSError, KeyError) as e:
            self.send_json({"error": str(e)}, 404)

    def static(self, path):
        f = (DIST / (path.lstrip("/") or "index.html")).resolve()
        if not DIST.is_dir():
            return self.send_error(503, "UI not built: run `npm install && npm run build` in web/")
        if not f.is_relative_to(DIST) or not f.is_file():
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.end_headers()
        self.wfile.write(f.read_bytes())

    def events(self, cid, start):
        """Stream a live session's output as NDJSON, from line `start` (-1 = only new lines). Ends when it exits."""
        lv = LIVE.get(cid)
        if not lv:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        with lv.cond:
            n = lv.base + len(lv.lines) if start < 0 else max(start, lv.base)
        try:
            # first line: the absolute index this stream starts at, so the page can re-attach right after its last line
            self.wfile.write((json.dumps({"type": "attach", "from": n}) + "\n").encode())
            if start < 0:  # attaching fresh: still-open approval requests would otherwise be missed
                self.wfile.write("".join(lv.asks.values()).encode())
            while True:
                with lv.cond:
                    if n >= lv.base + len(lv.lines):
                        lv.cond.wait(15)
                    chunk = lv.lines[n - lv.base:]
                    n = lv.base + len(lv.lines)
                self.wfile.write("".join(chunk).encode() or b"\n")  # bare newline = keep-alive
                self.wfile.flush()
                if chunk and '"type": "exit"' in chunk[-1]:
                    return
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        # Any website you visit can POST to localhost; only accept our own page (Origin) on our own host (DNS rebinding).
        origin = self.headers.get("Origin", "")
        if self.headers.get("Host") not in HOSTS or origin.split("://")[-1] not in ORIGINS:
            return self.send_error(403)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if urlparse(self.path).path == "/api/shell":
            return self.shell(str(body.get("cmd", "")))
        if urlparse(self.path).path == "/api/git":
            try:
                return self.send_json(git_op(body))
            except PermissionError:
                return self.send_json({"ok": False, "out": "path outside project folder"}, 403)
        cid = body.get("cid", "")
        if not UUID.match(cid):
            return self.send_error(400)
        path = urlparse(self.path).path
        with LIVE_LOCK:
            lv = LIVE.get(cid)
            if path == "/api/send":
                mode, model = body.get("mode"), body.get("model") or None
                if not lv or not lv.alive:
                    lv = LIVE[cid] = Live(body.get("sid"), mode, model)
                else:  # settings changed since this process started: switch them in place
                    if mode in MODES and mode != lv.mode:
                        lv.control("set_permission_mode", mode=mode)
                        lv.mode = mode
                    if model and model != lv.model:
                        lv.control("set_model", model=model)
                        lv.model = model
                if not isinstance(body.get("p"), (str, list)):
                    return self.send_error(400)
                lv.write({"type": "user", "message": {"role": "user", "content": body["p"]}})  # list = text + image blocks
            elif path == "/api/respond" and lv and lv.alive:
                # answer a tool approval: allow (optionally "always", from Claude's own suggestion) or deny with feedback
                rid = body.get("request_id", "")
                ask = json.loads(lv.asks.pop(rid, "{}")).get("request", {})
                if body.get("allow"):
                    resp = {"behavior": "allow", "updatedInput": ask.get("input", {})}
                    answers = body.get("answers")
                    if isinstance(answers, dict):  # AskUserQuestion: {question text: chosen label(s)}
                        resp["updatedInput"] = {**resp["updatedInput"], "answers": {str(k): str(v) for k, v in answers.items()}}
                    if body.get("always") and ask.get("permission_suggestions"):
                        resp["updatedPermissions"] = ask["permission_suggestions"]
                else:
                    resp = {"behavior": "deny", "message": str(body.get("message") or "The user declined this.")}
                lv.write({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": resp}})
                if body.get("mode") in MODES:
                    lv.control("set_permission_mode", mode=body["mode"])
                    lv.mode = body["mode"]
            elif path == "/api/interrupt" and lv and lv.alive:
                lv.control("interrupt")
            elif path == "/api/close" and lv:
                LIVE.pop(cid).close()
        self.send_json({"ok": True, "live": bool(lv and lv.alive)})

    def shell(self, cmd):
        """Shell mode (! in the message box): run your command in the project folder, streaming its output.
        The last chunk is NUL + {"exit": code}. Stop = the page closing the request: the command is killed at once."""
        if not cmd.strip():
            return self.send_error(400)
        p = subprocess.Popen(["bash", "-c", cmd], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             start_new_session=True, env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"})
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        fd = p.stdout.fileno()
        try:
            while True:
                ready, _, _ = select.select([fd, self.connection], [], [], 1)
                # the page sends nothing after its request: its socket turning readable means it closed (Stop)
                if self.connection in ready and not self.connection.recv(1, socket.MSG_PEEK):
                    return
                if fd in ready:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            self.wfile.write(b"\0" + json.dumps({"exit": p.wait()}).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if p.poll() is None:
                os.killpg(p.pid, 9)  # the whole group: pipelines and whatever the command started
            p.stdout.close()

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/api/", "/assets/")):  # tree/file polling and bundles would flood the terminal
            super().log_message(fmt, *args)


def restart_on_change():
    # ponytail: 1s mtime poll instead of a watcher dependency
    me = Path(__file__).resolve()
    seen = me.stat().st_mtime
    while True:
        time.sleep(1)
        try:
            if me.stat().st_mtime == seen:
                continue
            seen = me.stat().st_mtime
            compile(me.read_text(), str(me), "exec")  # broken save -> keep old server running
        except (OSError, SyntaxError) as e:
            print("not restarting:", e, flush=True)
            continue
        print("server.py changed, restarting", flush=True)
        for lv in LIVE.values():  # exec would orphan them; the page resumes each session on its next message
            lv.p.kill()
        os.execv(sys.executable, [sys.executable, str(me), *sys.argv[1:]])


if not (DIST / "index.html").exists():  # first run from a fresh clone: build the UI so there is one command to learn
    print("Building the UI (first run only)...", flush=True)
    try:
        subprocess.run("npm install && npm run build", shell=True, cwd=DIST.parent, check=True)
    except subprocess.CalledProcessError:
        sys.exit("UI build failed. Needs Node.js 18+ (npm on PATH).")
threading.Thread(target=restart_on_change, daemon=True).start()
threading.Thread(target=reap, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}"
print(f"Claude UI for {ROOT} -> {URL}", flush=True)
if not os.environ.get("CLAUDE_UI_OPENED"):  # set before exec, so self-restarts don't open another tab
    os.environ["CLAUDE_UI_OPENED"] = "1"
    import webbrowser; webbrowser.open(URL)
# Localhost only: this endpoint runs Claude Code with your permissions.
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
