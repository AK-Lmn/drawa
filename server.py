#!/usr/bin/env python3
"""Browser UI for Claude Code.
    python3 server.py [project-folder]   (default: current folder); opens http://127.0.0.1:8765
Builds web/ on first run (needs npm); after UI changes run `npm run build` in web/, or use `npm run dev` for UI work.
"""
import base64, functools, hashlib, heapq, json, mimetypes, os, re, secrets, select, socket, subprocess, sys, threading, time
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


@functools.lru_cache(maxsize=512)
def first_prompt_of(path, mtime):  # a transcript's first prompt only changes with the file
    return first_prompt(Path(path))


def list_sessions():
    stats = ((f, f.stat().st_mtime) for f in SESSIONS.glob("*.jsonl"))
    newest = heapq.nlargest(50, stats, key=lambda fm: fm[1])  # ponytail: newest 50, paginate if needed
    return [{"id": f.stem, "title": first_prompt_of(str(f), m), "mtime": m} for f, m in newest]


CLIP = 20_000  # the page shows at most this much of one tool output


def clip(content):
    """Trim what the page never shows before sending a transcript or a live line: long tool outputs and tool inputs
    (it cuts them anyway), images returned by tools (screenshots Claude looked at), and thinking signatures. Images
    you sent are kept, as an /api/images address instead of base64."""
    for b in content if isinstance(content, list) else []:
        b.pop("signature", None)
        t = b.get("type")
        if t == "image" and isinstance(b.get("source"), dict) and b["source"].get("type") == "base64":
            try:  # a pasted image: stored once by content, sent as its address
                b["source"] = {"type": "url", "url": "/api/images/" + store_image(base64.b64decode(b["source"]["data"])),
                               "media_type": b["source"].get("media_type")}
            except (ValueError, OSError, KeyError):
                pass
        elif t == "tool_use" and isinstance(b.get("input"), dict):  # e.g. a Write of a whole file
            b["input"] = {k: v[:CLIP] + "\n… (truncated)" if isinstance(v, str) and len(v) > CLIP else v for k, v in b["input"].items()}
        if t != "tool_result":
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
_files = {"at": 0.0, "index": None, "list": [], "low": []}


def project_files():
    """Every file in the project (git's view when it's a repo, so .gitignore applies), cached for 30s or until the git
    index changes. ponytail: a brand-new untracked file can take up to 30s to show up in @ search."""
    try:
        index = (ROOT / ".git" / "index").stat().st_mtime
    except OSError:
        index = None
    if time.time() - _files["at"] < 30 and index == _files["index"]:
        return _files["list"]
    ok, out = git("ls-files", "-co", "--exclude-standard", timeout=10)
    files = out.splitlines() if ok else None
    if files is None:  # not a git repo: walk it, skipping the usual heavy folders
        files = []
        for d, dirs, names in os.walk(ROOT):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
            files += [str(Path(d, n).relative_to(ROOT)) for n in names]
            if len(files) > 50_000:  # ponytail: huge trees get cut off; a real index if that bites
                break
    _files.update(at=time.time(), index=index, list=files, low=[f.lower() for f in files])
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
    files = project_files()
    for f, low in zip(files, _files["low"]):
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


def run(cmd, timeout=30, stdin=None, env=None):
    """Run a program in the project folder -> CompletedProcess (text). Raises OSError / TimeoutExpired."""
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout, input=stdin, env=env)


def git(*args, timeout=30, stdin=None):
    """Run git in the project; returns (ok, output). Paths always come after `--` (never read as options)."""
    try:
        r = run(["git", *args], timeout, stdin)
        return r.returncode == 0, (r.stdout if r.returncode == 0 else (r.stderr or r.stdout)).strip("\n")
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)


_git = {"at": 0.0, "state": None}
GIT_FILES = 500  # files listed in the Git window; the rest are counted


def git_state():
    """git_status(), shared by every page for a few seconds: each open Git window polls it."""
    if time.time() - _git["at"] > 3 or _git["state"] is None:
        _git.update(state=git_status(), at=time.time())
    return _git["state"]


def git_status():
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
    return {"repo": True, "branch": branch or "(detached)", "upstream": "..." in head, "ahead": ahead, "behind": behind,
            "files": files[:GIT_FILES], "total": len(files), "log": log}


def git_diff(rel, staged):
    inside(rel)  # stays in the project
    ok, out = git("diff", *(["--cached"] if staged else []), "--", rel)
    if ok and not out and not staged:  # untracked: show the whole file as added
        ok, out = git("diff", "--no-index", "--", "/dev/null", rel)
        ok = True  # --no-index exits 1 when files differ
    return {"diff": out[:400_000]}


def haiku(prompt, text):
    """A one-off Claude call (commit messages, PR descriptions) -> (ok, its reply or the error)."""
    try:
        r = run(["claude", "-p", "--model", "haiku", prompt], 120, text)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return (True, r.stdout.strip()) if r.returncode == 0 else (False, (r.stderr or r.stdout).strip()[:500])


def git_message():
    """A commit message for the staged changes, written by a one-off Claude call."""
    ok, diff = git("diff", "--cached", "--stat", "--patch")
    if not ok or not diff.strip():
        return {"error": "Nothing staged to describe."}
    prompt = ("Write a git commit message for this staged diff. First line: imperative summary under 70 characters. "
              "Then a blank line and a short body only if the change needs explaining. Reply with the message only, no code fences.")
    ok, out = haiku(prompt, diff[:80_000])
    return {"message": out} if ok else {"error": out}

# GitHub, through the `gh` CLI on this machine: its login, its permissions. Nothing GitHub-related is stored here.
class GhError(Exception):
    pass


GH_ENV = {**os.environ, "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1", "GH_NO_UPDATE_NOTIFIER": "1", "GH_PAGER": ""}


def gh(*args, timeout=60, stdin=None):
    """Run gh in the project; returns its output or raises GhError with gh's own message."""
    try:
        r = run(["gh", *args], timeout, stdin, GH_ENV)
    except FileNotFoundError:
        raise GhError("The GitHub CLI (gh) isn't installed. Get it from https://cli.github.com, then run `gh auth login`.")
    except (OSError, subprocess.TimeoutExpired) as e:
        raise GhError(str(e))
    if r.returncode:
        raise GhError((r.stderr or r.stdout).strip()[:2000] or f"gh exited with {r.returncode}")
    return r.stdout


def gh_json(*args):
    return json.loads(gh(*args) or "null")


def num(v):
    n = int(str(v))
    if n <= 0:
        raise GhError("bad number")
    return str(n)


def checks(rollup):
    """GitHub's two kinds of status (check runs and commit statuses) as one list: name, state, url."""
    out = {}  # name -> (newness, check): the same check runs again on re-runs and on push + pull_request events
    for c in rollup or []:
        if c.get("__typename") == "StatusContext":
            st = {"SUCCESS": "pass", "PENDING": "pending", "EXPECTED": "pending"}.get(c.get("state"), "fail")
            row = {"name": c.get("context", ""), "state": st, "url": c.get("targetUrl") or ""}
        else:
            done = c.get("status") == "COMPLETED"
            st = "pending" if not done else {"SUCCESS": "pass", "NEUTRAL": "skip", "SKIPPED": "skip"}.get(c.get("conclusion"), "fail")
            name = " / ".join(x for x in (c.get("workflowName"), c.get("name")) if x)
            row = {"name": name, "state": st, "url": c.get("detailsUrl") or ""}
        newness = (c.get("startedAt") or c.get("completedAt") or c.get("createdAt") or "", st == "pending")
        if row["name"] not in out or newness >= out[row["name"]][0]:
            out[row["name"]] = (newness, row)
    return [row for _, row in out.values()]


def who(a):
    return (a or {}).get("login", "")


PR_LIST = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,updatedAt,statusCheckRollup,labels,state"
LIST_MAX = 50  # rows the lists show; they fetch one more to know there are more
DIFF_MAX = 400_000


def labels(r):
    return [l["name"] for l in r.get("labels") or []]


def pr_row(p):
    return {"number": p["number"], "title": p["title"], "author": who(p.get("author")), "head": p.get("headRefName"),
            "base": p.get("baseRefName"), "draft": p.get("isDraft"), "review": p.get("reviewDecision") or "",
            "updated": p.get("updatedAt"), "state": p.get("state"), "labels": labels(p),
            "checks": checks(p.get("statusCheckRollup"))}


@functools.cache
def gh_repo():
    """The repo's name, url and default branch: asked once (a slow call); an error isn't cached, so it's retried."""
    return gh_json("repo", "view", "--json", "nameWithOwner,url,defaultBranchRef")


def gh_state():
    """The repo on GitHub, and the pull request for the branch you're on (if any)."""
    _, branch = git("branch", "--show-current")  # empty on a detached HEAD: no pull request to look for
    try:
        repo = gh_repo()
        # `pr list --head`: [] means "no pull request"; any other failure (auth, network) is a real error
        prs = gh_json("pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_LIST + ",url") if branch else []
    except GhError as e:
        return {"ok": False, "error": str(e)}
    pr = {**pr_row(prs[0]), "url": prs[0].get("url")} if prs else None
    return {"ok": True, "repo": repo["nameWithOwner"], "url": repo["url"], "default": (repo.get("defaultBranchRef") or {}).get("name", ""),
            "branch": branch, "pr": pr}


def gh_prs(state):
    return [pr_row(p) for p in gh_json("pr", "list", "--state", state if state in ("open", "closed", "merged", "all") else "open",
                                       "--limit", str(LIST_MAX + 1), "--json", PR_LIST)]


def issue_row(i):
    return {"number": i["number"], "title": i["title"], "author": who(i.get("author")), "updated": i.get("updatedAt"),
            "state": i.get("state"), "labels": labels(i)}


def gh_issues(state):
    return [issue_row(i) for i in gh_json("issue", "list", "--state", state if state in ("open", "closed", "all") else "open",
                                          "--limit", str(LIST_MAX + 1), "--json", "number,title,author,labels,updatedAt,state")]


def comment(c):
    return {"author": who(c.get("author") or c.get("user")), "body": c.get("body") or "", "when": c.get("createdAt") or c.get("submittedAt") or c.get("created_at") or ""}


def gh_pr(n):
    n = num(n)
    p = gh_json("pr", "view", n, "--json", PR_LIST + ",url,body,additions,deletions,changedFiles,reviews,comments,mergeable,createdAt")
    # comments on lines of code (reviews' inline comments): not in `pr view`. --slurp: every page, as one list of pages
    inline_error = ""
    try:
        inline = [c for page in gh_json("api", "--paginate", "--slurp", f"repos/{{owner}}/{{repo}}/pulls/{n}/comments?per_page=100") for c in page]
    except GhError as e:
        inline, inline_error = [], str(e).split("\n")[0]
    try:
        diff = gh("pr", "diff", n)
    except GhError as e:
        diff = f"(no diff: {e})"
    return {**pr_row(p), "url": p.get("url"), "body": p.get("body") or "", "additions": p.get("additions"), "deletions": p.get("deletions"),
            "files": p.get("changedFiles"), "mergeable": p.get("mergeable"), "created": p.get("createdAt"),
            "comments": [comment(c) for c in p.get("comments") or []],
            "reviews": [{**comment(r), "state": r.get("state")} for r in p.get("reviews") or [] if r.get("body") or r.get("state") != "COMMENTED"],
            "inline": [{**comment(c), "path": c.get("path"), "line": c.get("line") or c.get("original_line"), "hunk": (c.get("diff_hunk") or "")[-600:]} for c in inline],
            "inline_error": inline_error, "diff": diff[:DIFF_MAX], "diff_truncated": len(diff) > DIFF_MAX}


def gh_issue(n):
    i = gh_json("issue", "view", num(n), "--json", "number,title,body,author,state,labels,url,comments,createdAt,updatedAt")
    return {**issue_row(i), "body": i.get("body") or "", "url": i.get("url"), "created": i.get("createdAt"),
            "comments": [comment(c) for c in i.get("comments") or []]}


def gh_log(url):
    """The failing steps' log of a GitHub Actions job (from a check's details URL), for Claude to read."""
    m = re.search(r"/actions/runs/(\d+)/job/(\d+)", url or "")
    if not m:
        raise GhError("Only GitHub Actions checks have logs here; open the check's page for others.")
    try:
        out = gh("run", "view", m.group(1), "--job", m.group(2), "--log-failed", timeout=120)
    except GhError as e:
        # ponytail: matched on gh's error text; GitHub answers 410 Gone once a run's logs have expired
        raise GhError("GitHub no longer keeps this run's logs (they expire)." if "HTTP 410" in str(e) else str(e))
    return {"log": out[-20_000:]}


BRANCH = re.compile(r"^(?!-)[\w./-]+$")  # a branch name, never something git or gh would read as an option


def branch_arg(b):
    if not BRANCH.match(b):
        raise GhError(f"{b!r} isn't a branch name.")
    return b


def gh_draft(base):
    """A pull request title and description for this branch against `base`, written by a one-off Claude call."""
    base = branch_arg(base)
    if git("rev-parse", "--verify", "-q", f"origin/{base}")[0]:
        ref = f"origin/{base}"
    else:
        ok, err = git("rev-parse", "--verify", base)
        if not ok:
            return {"error": f"No branch {base} here or on origin: {err}"}
        ref = base
    ok, log = git("log", "--format=%s%n%b", f"{ref}..HEAD")
    ok2, diff = git("diff", "--stat", "--patch", f"{ref}...HEAD")
    if not ok or not ok2 or not diff.strip():
        return {"error": f"No changes between {base} and this branch to describe."}
    prompt = ("Write a GitHub pull request for these commits and diff. First line: the title (imperative, under 70 characters). "
              "Then a blank line, then the description in Markdown: what changed and why, and anything a reviewer should check. "
              "Keep it short. Reply with the title and description only, no code fences.")
    ok, out = haiku(prompt, f"Commits:\n{log}\n\nDiff:\n{diff}"[:100_000])
    if not ok:
        return {"error": out}
    title, _, body = out.partition("\n")
    return {"title": title.strip().lstrip("# ").strip(), "body": body.strip()}


def gh_op(body):
    op = body.get("op")
    try:
        if op == "checkout":
            return {"ok": True, "out": gh("pr", "checkout", num(body.get("n")), timeout=120).strip()}
        if op == "draft":
            return gh_draft(str(body.get("base") or "main").strip())
        if op == "create":
            title, base = str(body.get("title") or "").strip(), str(body.get("base") or "").strip()
            if not title or not base:
                return {"ok": False, "out": "A pull request needs a title and a base branch."}
            branch_arg(base)
            ok, out = git("push", "-u", "origin", "HEAD", timeout=120)  # gh can't open a PR for a branch GitHub doesn't have
            if not ok:
                return {"ok": False, "out": out[-2000:]}
            args = ["pr", "create", f"--title={title}", f"--base={base}", "--body-file", "-", *(["--draft"] if body.get("draft") else [])]
            return {"ok": True, "out": gh(*args, stdin=str(body.get("body") or ""), timeout=120).strip()}
        if op == "comment":
            kind = "pr" if body.get("kind") == "pr" else "issue"
            text = str(body.get("body") or "").strip()
            if not text:
                return {"ok": False, "out": "Write a comment first."}
            return {"ok": True, "out": gh(kind, "comment", num(body.get("n")), "--body-file", "-", stdin=text).strip()}
    except (GhError, ValueError) as e:
        return {"ok": False, "out": str(e)}
    return {"ok": False, "out": f"unknown op {op}"}


def git_op(body):
    _git["at"] = 0  # whatever it does, the next status is fresh
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


IMAGE_MAX = 15_000_000
IMAGE_MAGIC = [(b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"GIF8", "image/gif")]


def image_type(data):
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return next((t for magic, t in IMAGE_MAGIC if data.startswith(magic)), None)


# Pictures on the canvas, kept as files so every browser and address (127.0.0.1:8765, the Vite dev server) sees the
# same ones: outside the project (no repo noise), named by their content's hash.
IMAGE_STORE = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "claude-ui" / "images"
HASH = re.compile(r"^[0-9a-f]{64}$")


def store_image(data):
    """Keep image bytes in the store -> their key (the hash). ponytail: never garbage-collected; files are small and
    shared by content, so removing a window can't tell whether another layout still shows the same picture."""
    key = hashlib.sha256(data).hexdigest()
    f = IMAGE_STORE / key
    if not f.exists():
        IMAGE_STORE.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(f)  # never a half-written picture
    return key


def save_image(b64):
    """Store an image the page sends (base64) -> its key."""
    try:
        data = base64.b64decode(str(b64), validate=True)
    except ValueError:
        return {"error": "not base64"}
    if len(data) > IMAGE_MAX or not image_type(data):
        return {"error": "not a PNG, JPEG, GIF or WebP image under 15MB"}
    return {"key": store_image(data)}


def stash_image(path):
    """Store an image Claude named (absolute, or relative to the project: Claude can read either anyway) -> its key.
    Only the key goes through the event stream, never megabytes of base64."""
    f = Path(os.path.expanduser(path))
    f = f if f.is_absolute() else ROOT / f
    if not f.is_file():
        raise ValueError(f"No file at {f}.")
    if f.stat().st_size > IMAGE_MAX:
        raise ValueError(f"{f} is over {IMAGE_MAX // 1_000_000}MB.")
    data = f.read_bytes()
    if not image_type(data):
        raise ValueError(f"{f} isn't a PNG, JPEG, GIF or WebP image.")
    return store_image(data)


def get_file(rel):
    data = inside(rel).read_bytes()[:1_000_000]  # ponytail: 1MB cap, viewer not an editor
    return {"text": None if b"\0" in data else data.decode("utf-8", "replace")}


CLAUDE = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
          "--include-partial-messages", "--replay-user-messages", "--append-system-prompt", SYSTEM_NOTE,
          "--permission-prompt-tool", "stdio",  # tool approvals (incl. plan approval) come to the page as control_requests
          "--allowedTools", "mcp__canvas__canvas_list,mcp__canvas__canvas_read"]  # looking at the canvas never asks

# Claude's canvas tools, served over MCP by this server (/mcp/<card>/<token>) and carried out by the page that has the
# canvas open (see Live.canvas_call and web/src/canvas/tools.ts). Changing things (create) asks, per the card's mode.
CANVAS_TOOLS = [
    {"name": "canvas_list", "description":
        "List what's on the user's canvas: the visual workspace this session lives on. Returns each item's id, kind "
        "(session, note, diagram, sketch, plan, snippet, image, file, files, run, git, github), title, position and size in canvas "
        "pixels, and whether it's collapsed. Your own session card is marked \"you\": true; items the user drew on "
        "(with the pen) are marked \"drawnOn\": true. Also lists the arrows drawn between items (from, to, label).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "canvas_read", "description":
        "Read one canvas item: its content as text (a note's text, a diagram's Mermaid source, a plan's markdown, a "
        "snippet's text, a file node's path), plus a picture of it whenever the user drew on or over it, since drawings "
        "never appear in the text. Sketches and images always come as a picture. Pass image: true to get a picture of any item. "
        "Use the id from canvas_list (a prefix is enough).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"},
                     "image": {"type": "boolean", "description": "Also return a picture of the item as it looks"}}, "required": ["id"]}},
    {"name": "canvas_create", "description":
        "Put something on the user's canvas, beside your session card (or beside another item). Use it when the user "
        "asks to put, draw, pin or show something on the canvas, or when a diagram would genuinely help; not for normal "
        "answers. Kinds: note (short text shown large on the canvas, like a sticky note), diagram (Mermaid source; "
        "drawn, and the user can edit it), snippet (a small window of code, text or command output), image (a PNG, JPEG, "
        "GIF or WebP file you saved, e.g. a screenshot you took of the app with a headless browser: pass its path). "
        "The item gets an "
        "arrow from your session. Returns the new item's id.",
     "inputSchema": {"type": "object", "properties": {
         "kind": {"type": "string", "enum": ["note", "diagram", "snippet", "image"]},
         "text": {"type": "string", "description": "The note's text, the diagram's Mermaid source, or the snippet's content (not for image)"},
         "path": {"type": "string", "description": "Image only: the image file, absolute or relative to the project"},
         "title": {"type": "string", "description": "Window title (diagram, snippet, image)"},
         "type": {"type": "string", "enum": ["code", "text", "output"], "description": "Snippet only (default code)"},
         "lang": {"type": "string", "description": "Snippet code language, e.g. ts, py"},
         "near": {"type": "string", "description": "Place it beside this item id instead of your card"},
     }, "required": ["kind"]}},
    {"name": "canvas_update", "description":
        "Change an existing item on the canvas in place: a diagram's Mermaid source (redrawn where it is), a note's "
        "text, a snippet's text; and a diagram's or snippet's title. When the user asks you to change something on the "
        "canvas, update it rather than creating a new item. Read it first (canvas_read) to see its current content and "
        "anything the user drew on it. Pass the whole new text, not a diff. Invalid Mermaid is refused and the diagram "
        "stays as it was.",
     "inputSchema": {"type": "object", "properties": {
         "id": {"type": "string", "description": "The item's id from canvas_list (a prefix is enough)"},
         "text": {"type": "string", "description": "The full new content"},
         "title": {"type": "string", "description": "A new window title (diagram, snippet)"},
     }, "required": ["id"]}},
    {"name": "canvas_link", "description":
        "Draw an arrow between two canvas items (from -> to), optionally labelled, to show how they relate. It stays "
        "attached as they move. Use item ids from canvas_list.",
     "inputSchema": {"type": "object", "properties": {
         "from": {"type": "string"}, "to": {"type": "string"},
         "label": {"type": "string", "description": "A short label shown on the arrow"},
     }, "required": ["from", "to"]}},
]


def tool_error(text):
    return {"content": [{"type": "text", "text": text}], "isError": True}


class Live:
    """One long-running `claude` per session card: messages go in on stdin (queued while busy, like the terminal),
    output is buffered so the page can (re)attach to the stream at any point."""

    KEEP = 20_000  # ponytail: output lines kept for re-attaching; older ones dropped (the transcript has them)
    KEEP_BYTES = 40_000_000  # and at most this much text

    def __init__(self, cid, sid, mode, model):
        # the canvas tools: this card's own MCP address, with a secret only this process knows
        self.token = secrets.token_hex(16)
        mcp = ["--mcp-config", json.dumps({"mcpServers": {"canvas": {"type": "http", "url": f"http://127.0.0.1:{PORT}/mcp/{cid}/{self.token}"}}})] if cid else []
        cmd = [*CLAUDE, *mcp, *(["--resume", sid] if sid else []), *(["--permission-mode", mode] if mode in MODES else []),
               *(["--model", model] if model else [])]
        self.p = subprocess.Popen(cmd, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.mode, self.model = mode, model
        self.lines, self.base, self.last, self.size = [], 0, time.time(), 0
        self.gen = secrets.token_hex(3)  # this process, among the card's processes: a page's line offsets belong to one
        self.asks = {}  # open approval requests: request_id -> the request line (re-sent to pages that attach later)
        self.readers = []  # pages reading this stream (newest last): the newest carries out canvas tool calls
        self.calls = {}  # canvas tool call id -> [Event, result]
        self.busy = False  # mid-turn: told to pages that attach (a reloaded page can't know otherwise)
        self.open_msg = None  # line where the message being streamed began: a page attaching now reads from there
        self.cond = threading.Condition()
        threading.Thread(target=self.pump, daemon=True).start()

    def canvas_call(self, name, args):
        """Relay a canvas tool call to the page, wait for its answer (an MCP tool result)."""
        if not self.readers:
            return tool_error("The canvas isn't open in a browser right now, so it can't be read or changed. Ask the user to open it.")
        cid, done, to = secrets.token_hex(8), threading.Event(), self.readers[-1]
        self.calls[cid] = [done, None, to]
        self.push(json.dumps({"type": "canvas_call", "id": cid, "to": to, "tool": name, "args": args}) + "\n")
        if not done.wait(60):
            self.calls.pop(cid, None)
            return tool_error("The canvas page didn't answer (closed, or busy). Try again or ask the user.")
        return self.calls.pop(cid)[1]

    def detach(self, reader):
        """A page stopped reading: calls it was carrying out can't be answered any more; say so right away.
        (A page re-opening its stream reads under the same id: its calls stand while any of its streams is open.)"""
        self.readers.remove(reader)
        if reader in self.readers:
            return
        for call in list(self.calls.values()):
            if call[2] == reader and not call[0].is_set():
                call[1] = tool_error("The canvas page closed or reloaded before answering. Try again.")
                call[0].set()

    def pump(self):
        for line in self.p.stdout:
            if not line.strip():
                continue
            if not line.startswith("{"):  # stderr noise -> an error line the page can show
                line = json.dumps({"type": "error", "text": line.strip()}) + "\n"
            elif line.startswith(('{"type":"system","subtype":"init"', '{"type":"stream_event","event":{"type":"message_start"')):
                self.busy = True
                if "message_start" in line[:60]:
                    with self.cond:
                        self.open_msg = self.base + len(self.lines)  # the index this line gets
            elif line.startswith('{"type":"stream_event","event":{"type":"message_stop"'):
                self.open_msg = None  # complete: the transcript has it now
            elif '"type":"result"' in line and json.loads(line).get("type") == "result":  # its keys come in any order
                self.busy = False
            elif len(line) > 4000 and ('"type":"user"' in line or '"type":"assistant"' in line):
                line = trimmed(line)
            elif '"can_use_tool"' in line or '"permissionMode"' in line:
                d = json.loads(line)
                if d.get("type") == "control_request" and d["request"].get("subtype") == "can_use_tool":
                    self.asks[d["request_id"]] = line
                elif d.get("subtype") == "status" and d.get("permissionMode"):
                    self.mode = d["permissionMode"]  # e.g. plan approved -> Claude left plan mode
            self.push(line)
        self.busy = False  # the process ended mid-turn: nothing is running any more
        self.push(json.dumps({"type": "exit", "code": self.p.wait()}) + "\n")

    def push(self, line):
        with self.cond:
            self.lines.append(line)
            self.size += len(line)
            if len(self.lines) > self.KEEP or self.size > self.KEEP_BYTES:
                drop = len(self.lines) // 2
                self.size -= sum(map(len, self.lines[:drop]))
                del self.lines[:drop]
                self.base += drop
            self.last = time.time()
            self.cond.notify_all()
        changed_somewhere()

    @property
    def alive(self):
        return self.p.poll() is None

    def write(self, obj):
        if obj.get("type") == "user":
            self.busy = True
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


def trimmed(line):
    """A big user/assistant line from the live stream, trimmed like a transcript (clip) and without the CLI's
    duplicate `tool_use_result` (the full tool output again, which the page doesn't read)."""
    try:
        d = json.loads(line)
    except ValueError:
        return line
    if d.get("type") not in ("user", "assistant") or not isinstance(d.get("message"), dict):
        return line
    d.pop("tool_use_result", None)
    clip(d["message"].get("content"))
    return json.dumps(d) + "\n"


# Every page reads all its cards over ONE stream (browsers allow ~6 connections per host over HTTP/1.1; a stream per
# card would starve every other request). Pushes bump SEQ so a stream waiting on any of its cards wakes up.
EVENTS = threading.Condition()
SEQ = [0]


def changed_somewhere():
    with EVENTS:
        SEQ[0] += 1
        EVENTS.notify_all()


def session_route(q):
    sid = q.get("id", "")
    if not UUID.match(sid):
        return {"error": "bad session id"}, 404
    if (SESSIONS / f"{sid}.jsonl").exists():
        return load_session(sid)
    # the CLI writes it once the first message is queued; until then the page reads the live process instead
    return {"error": "This session's transcript isn't written yet.", "missing": True}, 404


# GET /api/... -> handler(query); a (body, status) tuple sets the status. Errors are mapped in do_GET.
GET = {
    "/api/info": lambda q: {"root": str(ROOT)},
    "/api/tree": lambda q: get_tree(q.get("path", "")),
    "/api/file": lambda q: get_file(q["path"]),
    "/api/git": lambda q: git_state(),
    "/api/git/diff": lambda q: git_diff(q["path"], q.get("staged") == "1"),
    "/api/files": lambda q: find_files(q.get("q", "")),
    "/api/meta": lambda q: meta(),
    "/api/sessions": lambda q: list_sessions() if SESSIONS.is_dir() else [],
    "/api/session": session_route,
    "/api/gh": lambda q: gh_state(),
    "/api/gh/prs": lambda q: gh_prs(q.get("state", "open")),
    "/api/gh/issues": lambda q: gh_issues(q.get("state", "open")),
    "/api/gh/pr": lambda q: gh_pr(q.get("n")),
    "/api/gh/issue": lambda q: gh_issue(q.get("n")),
    "/api/gh/log": lambda q: gh_log(q.get("url")),
}


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
        lv = Live(None, None, None, None)
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
            return self.events(q)
        if url.path.startswith("/mcp/"):
            return self.send_error(405)  # the canvas MCP server has no server-to-client stream
        if not url.path.startswith("/api/"):
            return self.static(url.path)
        try:
            if url.path.startswith("/api/images/") and HASH.match(url.path[12:]):
                data = (IMAGE_STORE / url.path[12:]).read_bytes()  # a missing one raises OSError -> 404
                return self.send_bytes(data, image_type(data) or "application/octet-stream", "private, max-age=31536000, immutable")
            route = GET.get(url.path)
            if not route:
                return self.send_error(404)
            out = route(q)
            self.send_json(*out) if isinstance(out, tuple) else self.send_json(out)
        except PermissionError:
            self.send_json({"error": "outside project folder"}, 403)
        except (GhError, ValueError) as e:
            self.send_json({"error": str(e)}, 502)
        except (OSError, KeyError) as e:
            self.send_json({"error": str(e)}, 404)

    def send_bytes(self, data, kind, cache=None):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        if cache:
            self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def static(self, path):
        f = (DIST / (path.lstrip("/") or "index.html")).resolve()
        if not DIST.is_dir():
            return self.send_error(503, "UI not built: run `npm install && npm run build` in web/")
        if not f.is_relative_to(DIST) or not f.is_file():
            return self.send_error(404)
        self.send_bytes(f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")

    def events(self, q):
        """A page's one stream of all its cards' output, as NDJSON lines tagged with the card ("_c").
        `c` = cid:from:gen,... (from = the card's next line, -1 = only new ones; gen = the process that offset belongs to).
        A card whose process starts later, or restarts, is read from its first line. `page` names the page for canvas
        tool calls."""
        page = q.get("page", "")
        if not re.fullmatch(r"[0-9a-f]{8,32}", page):
            return self.send_error(400)
        subs, absent = {}, set()
        for part in q.get("c", "").split(","):
            cid, n, gen = (part.split(":") + ["", ""])[:3]
            if UUID.match(cid):
                subs[cid] = (int(n) if re.fullmatch(r"-?\d+", n) else -1, gen)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        tag = lambda cid, line: f'{{"_c":"{cid}",{line[1:]}' if line[1:2] not in ("}", "") else ""
        held = {}  # cid -> [its Live, next line]
        try:
            while True:
                seen, out = SEQ[0], []
                for cid, (start, gen) in subs.items():
                    lv, st = LIVE.get(cid), held.get(cid)
                    if not lv and not st:
                        absent.add(cid)  # no process yet: when one starts, all of its output is new to this page
                    if lv and (not st or st[0] is not lv):  # attach
                        if st or cid in absent or (gen and gen != lv.gen):
                            start = 0  # a process this page hasn't read yet: from its first line
                        with lv.cond:
                            # fresh (-1): new lines, plus the message being streamed right now (not in the transcript yet)
                            n = max(lv.open_msg if lv.open_msg is not None else lv.base + len(lv.lines), lv.base) if start < 0 else max(start, lv.base)
                            missed = start < lv.base  # its approval requests may have been dropped (or never read)
                        if st:
                            st[0].detach(page)
                        lv.readers.append(page)
                        held[cid] = st = [lv, n]
                        out.append(tag(cid, json.dumps({"type": "attach", "from": n, "gen": lv.gen, "reader": page, "busy": lv.busy}) + "\n"))
                        if missed and n:
                            out += [tag(cid, a) for a in lv.asks.values()]
                    if st:
                        with st[0].cond:
                            chunk = st[0].lines[max(0, st[1] - st[0].base):]
                            st[1] = st[0].base + len(st[0].lines)
                        out += [tag(cid, line) for line in chunk]
                if not out:
                    with EVENTS:
                        if SEQ[0] == seen:
                            EVENTS.wait(15)
                    if SEQ[0] == seen:
                        out = ["\n"]  # keep-alive
                self.wfile.write("".join(out).encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            for lv, _ in held.values():
                lv.detach(page)

    def mcp(self, cid, token):
        """The canvas tools as a minimal MCP server (streamable HTTP, JSON responses). Only the card's own Claude
        process knows the token; a browser can't use it (it would send an Origin, which is refused)."""
        lv = LIVE.get(cid)
        if self.headers.get("Origin") or not lv or not secrets.compare_digest(token, lv.token):
            return self.send_error(403)
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
        except ValueError:
            return self.send_json({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
        if not isinstance(req, dict):
            return self.send_json({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}})
        if "id" not in req:  # a notification (e.g. notifications/initialized): nothing to answer
            self.send_response(202)
            self.end_headers()
            return
        method, params = req.get("method"), req.get("params") if isinstance(req.get("params"), dict) else {}
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                      "serverInfo": {"name": "claude-ui-canvas", "version": "1"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": CANVAS_TOOLS}
        elif method == "tools/call":
            name, args = params.get("name"), params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            try:
                if name == "canvas_create" and args.get("kind") == "image":
                    args = {**args, "image": stash_image(str(args.get("path") or ""))}
                result = lv.canvas_call(name, args)
            except (ValueError, OSError) as e:
                result = tool_error(str(e) or "Couldn't read that image.")
        else:
            return self.send_json({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": f"unknown method {method}"}})
        self.send_json({"jsonrpc": "2.0", "id": req["id"], "result": result})

    def do_POST(self):
        parts = urlparse(self.path).path.split("/")
        if len(parts) == 4 and parts[1] == "mcp" and self.headers.get("Host") in HOSTS:  # /mcp/<card>/<token>
            return self.mcp(parts[2], parts[3])
        # Any website you visit can POST to localhost; only accept our own page (Origin) on our own host (DNS rebinding).
        origin = self.headers.get("Origin", "")
        if self.headers.get("Host") not in HOSTS or origin.split("://")[-1] not in ORIGINS:
            return self.send_error(403)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if urlparse(self.path).path == "/api/shell":
            return self.shell(str(body.get("cmd", "")))
        if urlparse(self.path).path == "/api/images":
            return self.send_json(save_image(body.get("data", "")))
        if urlparse(self.path).path == "/api/gh":
            return self.send_json(gh_op(body))
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
                    lv = LIVE[cid] = Live(cid, body.get("sid"), mode, model)
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
            elif path == "/api/mode":
                # a card's permission mode changed: switch its running process now (not running: next send starts it so)
                if body.get("mode") not in MODES:
                    return self.send_error(400)
                if lv and lv.alive and body["mode"] != lv.mode:
                    lv.control("set_permission_mode", mode=body["mode"])  # lv.mode follows when Claude confirms (pump)
            elif path == "/api/canvas" and lv:
                # the page's answer to a canvas tool call (an MCP tool result)
                call = lv.calls.get(str(body.get("id", "")))
                if call and isinstance(body.get("result"), dict):
                    call[1] = body["result"]
                    call[0].set()
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


def main():
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


if __name__ == "__main__":
    main()
