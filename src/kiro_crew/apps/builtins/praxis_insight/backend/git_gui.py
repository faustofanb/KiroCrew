"""Fork-quality Git GUI backend — visual git operations over real repos.

The API surface mirrors what a visual Git client (Fork, GitButler, Tower)
needs: commit graph with lane layout, per-file and per-line staging,
side-by-side diffs, branch management, blame, and working-directory state.
Every call is a real git invocation against a repository on disk.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

_TIMEOUT = 30


def _git(args: list[str], cwd: str | Path, timeout: int = _TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True, text=True, timeout=timeout,
    )


def _ok(proc: subprocess.CompletedProcess) -> str:
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "git failed").strip()[:2000])
    return proc.stdout


def _resolve_repo(repo: str, root: str) -> Path:
    p = Path(root).expanduser() / repo
    if not (p / ".git").exists():
        raise FileNotFoundError(f"{repo} is not a git repository under {root}")
    return p


# ── Commit history with graph lanes ─────────────────────────────────────────

def log_graph(repo: str, root: str, limit: int = 100, branch: str = "HEAD") -> dict:
    """Commit log with parent info for lane layout + decorations.

    Returns commits in reverse-chronological order with refs (branches/tags)
    attached, ready for a client-side lane-layout algorithm.
    """
    rp = _resolve_repo(repo, root)
    fmt = "%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%P%x1e"
    out = _ok(_git(["log", branch, f"--format={fmt}", f"-{limit}", "--date-order"], rp))
    commits = []
    for line in out.strip().split("\x1e"):
        line = line.strip()
        if not line:
            continue
        parts = line.split("\x1f")
        if len(parts) < 6:
            continue
        sha, short, author, ts, subject, parents = parts
        commits.append({
            "sha": sha, "short": short, "author": author,
            "timestamp": int(ts) if ts else 0,
            "subject": subject,
            "parents": parents.split() if parents else [],
        })
    # Decorations (branch/tag names) per commit
    deco_out = _ok(_git(["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads", "refs/tags"], rp))
    sha_to_refs: dict[str, list[str]] = {}
    for line in deco_out.strip().split("\n"):
        if not line.strip():
            continue
        sha, ref = line.split(" ", 1)
        sha_to_refs.setdefault(sha, []).append(ref)
    for c in commits:
        c["refs"] = sha_to_refs.get(c["sha"], [])
    return {"repo": repo, "branch": branch, "commits": commits}


# ── Working directory state ──────────────────────────────────────────────────

def status(repo: str, root: str) -> dict:
    rp = _resolve_repo(repo, root)
    out = _ok(_git(["status", "--porcelain=v1", "--branch"], rp))
    lines = out.strip().split("\n")
    branch_line = lines[0] if lines else ""
    files = []
    for line in lines[1:]:
        if not line.strip():
            continue
        x, y = line[0], line[1]
        path = line[3:]
        # rename arrow
        old_path = None
        if " -> " in path:
            old_path, path = path.split(" -> ", 1)
        staged = x != " " and x != "?"
        unstaged = y != " "
        untracked = x == "?"
        files.append({
            "path": path, "oldPath": old_path,
            "staged": staged, "unstaged": unstaged, "untracked": untracked,
            "status": ("?" if untracked else x + y),
        })
    return {"repo": repo, "branch": branch_line.replace("## ", ""), "files": files}


# ── Diff ─────────────────────────────────────────────────────────────────────

def diff_file(repo: str, root: str, path: str, staged: bool = False) -> dict:
    rp = _resolve_repo(repo, root)
    args = ["diff"]
    if staged:
        args.append("--cached")
    args += ["--", path]
    out = _ok(_git(args, rp))
    return {"repo": repo, "path": path, "staged": staged, "patch": out[:80_000]}


def diff_commit(repo: str, root: str, sha: str) -> dict:
    rp = _resolve_repo(repo, root)
    out = _ok(_git(["show", "--format=", "--patch", sha], rp))
    meta = _ok(_git(["show", "--format=%an%n%at%n%s", "--no-patch", sha], rp))
    lines = meta.strip().split("\n")
    return {
        "repo": repo, "sha": sha,
        "author": lines[0] if lines else "",
        "timestamp": int(lines[1]) if len(lines) > 1 and lines[1].isdigit() else 0,
        "subject": lines[2] if len(lines) > 2 else "",
        "patch": out[:80_000],
    }


# ── Staging ──────────────────────────────────────────────────────────────────

def stage_file(repo: str, root: str, path: str) -> dict:
    rp = _resolve_repo(repo, root)
    _ok(_git(["add", "--", path], rp))
    return {"repo": repo, "path": path, "staged": True}


def unstage_file(repo: str, root: str, path: str) -> dict:
    rp = _resolve_repo(repo, root)
    _ok(_git(["reset", "HEAD", "--", path], rp))
    return {"repo": repo, "path": path, "staged": False}


def stage_hunk(repo: str, root: str, path: str, patch_text: str, reverse: bool = False) -> dict:
    """Stage/unstage a single hunk via git apply --cached."""
    import subprocess as sp

    rp = _resolve_repo(repo, root)
    args = ["git", "-C", str(rp), "apply", "--cached", "--unidiff-zero"]
    if reverse:
        args.append("--reverse")
    proc = sp.run(args, input=patch_text, capture_output=True, text=True, timeout=_TIMEOUT)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "apply failed").strip()[:800])
    return {"repo": repo, "path": path, "hunkApplied": True, "reverse": reverse}


def stage_all(repo: str, root: str) -> dict:
    rp = _resolve_repo(repo, root)
    _ok(_git(["add", "-A"], rp))
    return {"repo": repo, "stagedAll": True}


def unstage_all(repo: str, root: str) -> dict:
    rp = _resolve_repo(repo, root)
    _ok(_git(["reset", "HEAD"], rp))
    return {"repo": repo, "unstagedAll": True}


def commit(repo: str, root: str, message: str, amend: bool = False) -> dict:
    if not message.strip():
        raise ValueError("commit message is required")
    rp = _resolve_repo(repo, root)
    args = ["commit", "-m", message.strip()]
    if amend:
        args.append("--amend")
    proc = _git(args, rp)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "commit failed").strip()[:800])
    sha = _ok(_git(["rev-parse", "--short", "HEAD"], rp)).strip()
    return {"repo": repo, "commit": sha, "amended": amend}


# ── Branch management ────────────────────────────────────────────────────────

def branches(repo: str, root: str) -> dict:
    rp = _resolve_repo(repo, root)
    out = _ok(_git(["for-each-ref", "--format=%(refname:short)%1f%(objectname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(subject)", "refs/heads"], rp))
    local = []
    for line in out.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\x1f")
        local.append({
            "name": parts[0],
            "sha": parts[1] if len(parts) > 1 else "",
            "current": parts[2] == "*" if len(parts) > 2 else False,
            "upstream": parts[3] if len(parts) > 3 else "",
            "subject": parts[4][:80] if len(parts) > 4 else "",
        })
    try:
        remote_out = _ok(_git(["for-each-ref", "--format=%(refname:short)%1f%(objectname:short)", "refs/remotes"], rp))
        remote = [
            {"name": l.split("\x1f")[0], "sha": l.split("\x1f")[1] if "\x1f" in l else ""}
            for l in remote_out.strip().split("\n") if l.strip()
        ]
    except Exception:
        remote = []
    return {"repo": repo, "local": local, "remote": remote}


def create_branch(repo: str, root: str, name: str, checkout: bool = True) -> dict:
    if not name.strip():
        raise ValueError("branch name is required")
    rp = _resolve_repo(repo, root)
    _ok(_git(["branch", name.strip()], rp))
    if checkout:
        _ok(_git(["checkout", name.strip()], rp))
    return {"repo": repo, "branch": name, "checkedOut": checkout}


def checkout_branch(repo: str, root: str, name: str) -> dict:
    rp = _resolve_repo(repo, root)
    _ok(_git(["checkout", name], rp))
    return {"repo": repo, "branch": name}


# ── Blame ────────────────────────────────────────────────────────────────────

def blame(repo: str, root: str, path: str) -> dict:
    rp = _resolve_repo(repo, root)
    out = _ok(_git(["blame", "--porcelain", "--", path], rp))
    lines = []
    current: dict = {}
    for line in out.split("\n"):
        if line.startswith("\t"):
            current["text"] = line[1:]
            lines.append(current)
            current = {}
        elif line.startswith("author "):
            current["author"] = line[7:]
        elif line.startswith("author-time "):
            current["timestamp"] = int(line[12:])
        elif line.startswith("summary "):
            current["summary"] = line[8:][:80]
        elif len(line.split(" ")) >= 2 and line[0].isalnum():
            parts = line.split(" ")
            if len(parts) >= 3:
                current["sha"] = parts[0][:8]
    return {"repo": repo, "path": path, "lines": lines[:500]}


# ── Repos (reuse the fork workbench's root) ──────────────────────────────────

def scan(root: str) -> dict:
    repos = []
    for p in sorted(Path(root).expanduser().iterdir()):
        if p.is_dir() and not p.name.startswith(".") and (p / ".git").exists():
            branch = "?"
            try:
                branch = _ok(_git(["rev-parse", "--abbrev-ref", "HEAD"], p)).strip()
            except Exception:
                pass
            repos.append({"name": p.name, "branch": branch})
    return {"root": root, "repos": repos}
