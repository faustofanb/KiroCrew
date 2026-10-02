"""Commit graph — topo-ordered DAG with incremental lane layout, paginated.

The lane algorithm is the gitk model: each lane holds the sha of the commit
expected to arrive there next. For every commit in topo order:

* every lane expecting its sha bends INTO the node (the classic merge bend
  lands on the child, drawn as an in-edge);
* the node lane now expects the first parent (straight out-edge), each extra
* parent either merges into a lane already expecting it or claims a free lane
  (curved out-edge that later rows carry vertically until it arrives);
* lanes are never compacted interiorly — free slots are reused, so lane
  indexes are stable across rows and the per-row edge list is sufficient for
  virtualized rendering (no cross-row bookkeeping on the client).

Sessions: a graph build runs one ``git log`` and keeps the computed rows in
memory; pages are sliced from it. Clients hold an opaque session key. The
cache is bounded (LRU by recency, TTL) — a stale key simply rebuilds.
"""

from __future__ import annotations

import re
import threading
import time
import uuid

from . import git_adapter as ga
from .repos import resolve

DEFAULT_PAGE = 400
DEFAULT_CAP = 50_000
SESSION_TTL = 900
MAX_SESSIONS = 12

_ROW_FMT = "%H%x1f%h%x1f%an%x1f%aE%x1f%at%x1f%s%x1f%P%x1e"


class _Session:
    __slots__ = (
        "key",
        "repo",
        "branch",
        "first_parent",
        "rows",
        "total",
        "truncated",
        "cap",
        "built_at",
        "touched",
    )

    def __init__(self, key: str, repo: str, branch: str, first_parent: bool) -> None:
        self.key = key
        self.repo = repo
        self.branch = branch
        self.first_parent = first_parent
        self.rows: list[dict] = []
        self.total = 0
        self.truncated = False
        self.cap = DEFAULT_CAP
        self.built_at = time.time()
        self.touched = time.time()


_SESSIONS: dict[str, _Session] = {}
_LOCK = threading.Lock()


def _evict_locked() -> None:
    now = time.time()
    stale = [k for k, s in _SESSIONS.items() if now - max(s.touched, s.built_at) > SESSION_TTL]
    for k in stale:
        _SESSIONS.pop(k, None)
    while len(_SESSIONS) >= MAX_SESSIONS:
        oldest = min(_SESSIONS, key=lambda k: _SESSIONS[k].touched)
        _SESSIONS.pop(oldest, None)


def _parse_log(out: str, first_parent: bool) -> list[dict]:
    commits: list[dict] = []
    for rec in out.split("\x1e"):
        rec = rec.lstrip("\n")
        if not rec.strip():
            continue
        parts = rec.rstrip("\n").split("\x1f")
        if len(parts) < 6:
            continue
        sha, short, author, email, ts, subject, parents = (
            parts[:7] if len(parts) >= 7 else (*parts, "")
        )
        parents = parents.split() if parents else []
        if first_parent:
            parents = parents[:1]
        commits.append(
            {
                "sha": sha,
                "short": short,
                "author": author,
                "email": email,
                "timestamp": int(ts) if ts.isdigit() else 0,
                "subject": subject,
                "parents": parents,
            }
        )
    return commits


def _free_lane(lanes: list[str | None]) -> int:
    for i, s in enumerate(lanes):
        if s is None:
            return i
    lanes.append(None)  # type: ignore[arg-type]
    return len(lanes) - 1


def _compute_lanes(commits: list[dict]) -> list[dict]:
    """Attach ``node`` lane + per-row ``edges`` to each commit in place.

    An edge is ``{a, b}`` where ``a`` is the lane at the top of the row (null
    = the node) and ``b`` the lane at the bottom (null = the node).
    """
    lanes: list[str | None] = []
    for c in commits:
        sha = c["sha"]
        ins = [i for i, s in enumerate(lanes) if s == sha]
        if ins:
            node = ins[0]
        else:
            node = _free_lane(lanes)
            lanes[node] = sha
        edges: list[dict] = [{"a": i, "b": None} for i in ins]
        parents = c["parents"]
        if not parents:
            lanes[node] = None
        else:
            lanes[node] = parents[0]
            edges.append({"a": None, "b": node})
            for p in parents[1:]:
                if p in lanes:
                    edges.append({"a": None, "b": lanes.index(p)})
                else:
                    k = _free_lane(lanes)
                    lanes[k] = p
                    edges.append({"a": None, "b": k})
        # pass-throughs: every other occupied lane keeps its slot this row
        for i, s in enumerate(lanes):
            if s is not None and i != node and s != sha:
                edges.append({"a": i, "b": i})
        # trim trailing free slots; survivor indexes never shift
        while lanes and lanes[-1] is None:
            lanes.pop()
        c["node"] = node
        c["edges"] = edges
    return commits


def _decorate(repo_path, commits: list[dict]) -> None:
    by_sha: dict[str, dict] = {c["sha"]: c for c in commits}
    out = ga.ok(
        repo_path,
        [
            "for-each-ref",
            "--format=%(objectname)%1f%(refname)%1f%(refname:short)%1f%(objecttype)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        timeout=ga.READ_TIMEOUT,
    )
    for line in out.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\x1f")
        if len(parts) < 4:
            continue
        sha, refname, short, otype = parts
        c = by_sha.get(sha)
        if c is None:
            continue
        if refname.startswith("refs/heads/"):
            c.setdefault("branches", []).append(short)
        elif refname.startswith("refs/remotes/"):
            # keep the remote name in the decoration (origin/main)
            c.setdefault("remotes", []).append(short)
        elif refname.startswith("refs/tags/"):
            c.setdefault("tags", []).append(short + ("^{commit}" if otype != "commit" else ""))
    try:
        head = ga.ok(repo_path, ["rev-parse", "HEAD"], timeout=ga.READ_TIMEOUT).strip()
        if head in by_sha:
            by_sha[head]["head"] = True
    except ga.GitError:
        pass


def _build(repo_id: str, branch: str, first_parent: bool, cap: int) -> _Session:
    repo_path = resolve(repo_id)
    # branch must be validated before it joins argv (option-injection guard)
    if not re.fullmatch(r"[A-Za-z0-9_@./^~:-]+", branch or "HEAD"):
        raise ga.GitError(f"invalid revision: {branch!r}", code="bad_revision")
    args = ["log", "--topo-order", f"--format={_ROW_FMT}", f"-n{cap}"]
    if first_parent:
        args.append("--first-parent")
    args.append(branch or "HEAD")
    out = ga.ok(repo_path, args, timeout=180)
    commits = _parse_log(out, first_parent)
    # distinguish "capped" from "exact": truncated when we got the full cap
    truncated = len(commits) >= cap
    _compute_lanes(commits)
    _decorate(repo_path, commits)
    s = _Session(uuid.uuid4().hex[:12], repo_id, branch, first_parent)
    s.rows = commits
    s.total = len(commits)
    s.truncated = truncated
    s.cap = cap
    with _LOCK:
        _evict_locked()
        _SESSIONS[s.key] = s
    return s


def _get_session(key: str) -> _Session:
    with _LOCK:
        s = _SESSIONS.get(key)
        if s is not None:
            s.touched = time.time()
    if s is None:
        raise KeyError(key)
    return s


def graph_page(
    repo_id: str,
    branch: str,
    first_parent: bool,
    session_key: str | None,
    offset: int,
    limit: int,
    cap: int,
    refresh: bool,
) -> dict:
    if refresh or not session_key:
        s = _build(repo_id, branch or "HEAD", first_parent, max(1000, min(cap, 200_000)))
    else:
        try:
            s = _get_session(session_key)
        except KeyError:
            # expired/evicted — rebuild transparently
            s = _build(repo_id, branch or "HEAD", first_parent, max(1000, min(cap, 200_000)))
        if (s.repo, s.branch, s.first_parent) != (repo_id, branch or "HEAD", first_parent):
            s = _build(repo_id, branch or "HEAD", first_parent, max(1000, min(cap, 200_000)))
    limit = max(1, min(limit, 2000))
    offset = max(0, offset)
    rows = s.rows[offset : offset + limit]
    return {
        "session": s.key,
        "repo": repo_id,
        "branch": s.branch,
        "firstParent": s.first_parent,
        "total": s.total,
        "truncated": s.truncated,
        "cap": s.cap,
        "offset": offset,
        "limit": limit,
        "hasMore": offset + len(rows) < s.total,
        "rows": rows,
    }
