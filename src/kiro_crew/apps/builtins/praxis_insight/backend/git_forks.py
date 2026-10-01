"""Real-git fork workbench — ChangeSet semantics over actual worktrees.

The simulator next door models the domain; THIS module OPERATES. A fork is a
managed worktree set (one per repository, branch ``fork/<id>`` created from a
base branch), and every operation below is a real git invocation bounded to
that managed set:

    create  → git worktree add <root>/.kirocrew-forks/<id>/<repo> -b fork/<id> <base>
    sync    → git -C <worktree> rebase <base>          (conflicts surface verbatim)
    commit  → git -C <worktree> add -A && git commit -m <msg>
    diff    → git -C <worktree> diff <base>...HEAD
    merge   → main checkout (on base, clean) ← git merge --no-ff fork/<id>
    close   → git worktree remove + branch -d/-D

Divergence is COMPUTED, not asserted: a fork is diverged when any repo's base
has commits the fork does not (behind > 0) while the fork carries its own
(ahead > 0). Adjudication is the operator pressing sync/rebase, seeing the
conflict verbatim, and resolving it — never a silent force.

The registry (workspace root + fork records) persists to
``<kirocrew home>/praxis-insight/forks.json``. Swap contract unchanged: when
praxisd lands its ChangeSet writer, these functions become thin proxies.
"""
from __future__ import annotations

import json
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from kiro_crew.config.paths import config_dir

_GIT_TIMEOUT = 30


def _git(args: list[str], cwd: str | Path, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    import os

    env = None
    if extra_env:
        env = {**os.environ, **extra_env}
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        timeout=_GIT_TIMEOUT,
        env=env,
    )


def _ok(proc: subprocess.CompletedProcess) -> str:
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "git failed").strip()[:2000])
    return proc.stdout


# ── Registry ─────────────────────────────────────────────────────────────────

def _store_path() -> Path:
    d = config_dir() / "praxis-insight"
    d.mkdir(parents=True, exist_ok=True)
    return d / "forks.json"


@dataclass
class ForkRepo:
    repo: str          # display name / dir name under the workspace root
    repo_path: str     # main checkout (where merge lands)
    worktree: str      # managed worktree path
    branch: str        # fork/<id>
    base: str          # base branch


@dataclass
class Fork:
    id: str
    title: str
    repos: list[ForkRepo] = field(default_factory=list)
    status: str = "OPEN"  # OPEN | DIVERGED | CONFLICT | MERGED | CLOSED
    note: str = ""

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "note": self.note,
            "repos": [r.__dict__.copy() for r in self.repos],
        }


def _load() -> dict:
    p = _store_path()
    if not p.exists():
        return {"root": "", "forks": []}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"root": "", "forks": []}


def _save(data: dict) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def _forks_dir(root: str) -> Path:
    return Path(root) / ".kirocrew-forks"


# ── Workspace scan ───────────────────────────────────────────────────────────

def get_root() -> str:
    return _load()["root"]


def set_root(root: str) -> dict:
    root = str(Path(root).expanduser().resolve())
    if not Path(root).is_dir():
        raise FileNotFoundError(root)
    data = _load()
    data["root"] = root
    _save(data)
    return {"root": root}


def scan_repos() -> dict:
    """Every first-level directory under the workspace root that is a git repo."""
    root = get_root()
    if not root:
        raise PermissionError("workspace root not set")
    repos = []
    for p in sorted(Path(root).iterdir()):
        if not p.is_dir() or p.name.startswith(".") or not (p / ".git").exists():
            continue
        branch = "?"

        def _safe(args):
            try:
                return _git(args, p).stdout.strip()
            except Exception:
                return "?"
        branch = _safe(["rev-parse", "--abbrev-ref", "HEAD"]) or "?"
        dirty = len(_safe(["status", "--porcelain"]).splitlines()) if branch != "?" else 0
        repos.append({"name": p.name, "branch": branch, "dirty": dirty})
    return {"root": root, "repos": repos}


# ── Fork lifecycle ───────────────────────────────────────────────────────────

def _find(data: dict, fork_id: str) -> Fork:
    for f in data["forks"]:
        if f["id"] == fork_id:
            rec = Fork(id=f["id"], title=f["title"], status=f.get("status", "OPEN"), note=f.get("note", ""))
            rec.repos = [ForkRepo(**r) for r in f["repos"]]
            return rec
    raise KeyError(fork_id)


def _write_back(data: dict, fork: Fork) -> None:
    for i, f in enumerate(data["forks"]):
        if f["id"] == fork.id:
            data["forks"][i] = fork.to_json()
            return
    data["forks"].append(fork.to_json())


def create_fork(repos: list[str], base: str, title: str) -> dict:
    root = get_root()
    if not root:
        raise PermissionError("workspace root not set")
    if not repos:
        raise ValueError("select at least one repository")
    fork_id = "f-" + uuid.uuid4().hex[:6]
    branch = f"fork/{fork_id}"
    wt_root = _forks_dir(root) / fork_id
    wt_root.mkdir(parents=True, exist_ok=True)
    records: list[ForkRepo] = []
    try:
        for name in repos:
            repo_path = Path(root) / name
            if not (repo_path / ".git").exists():
                raise FileNotFoundError(f"{name} is not a git repository")
            worktree = wt_root / name
            _ok(_git(["worktree", "add", str(worktree), "-b", branch, base], repo_path))
            records.append(
                ForkRepo(repo=name, repo_path=str(repo_path), worktree=str(worktree), branch=branch, base=base)
            )
    except Exception:
        # Roll back everything this create already made.
        for r in records:
            subprocess.run(["git", "-C", r.repo_path, "worktree", "remove", "--force", r.worktree], capture_output=True)
            subprocess.run(["git", "-C", r.repo_path, "branch", "-D", r.branch], capture_output=True)
        raise
    fork = Fork(id=fork_id, title=title or fork_id, repos=records)
    data = _load()
    _write_back(data, fork)
    _save(data)
    return {"fork": fork.to_json(), **_status(fork)}


def _repo_status(r: ForkRepo) -> dict:
    def count(args: list[str]) -> int:
        try:
            out = _ok(_git(args, r.worktree)).strip()
            return int(out) if out else 0
        except Exception:
            return 0

    ahead = count(["rev-list", "--count", f"{r.base}..HEAD"])
    behind = count(["rev-list", "--count", f"HEAD..{r.base}"])
    try:
        dirty = len(_ok(_git(["status", "--porcelain"], r.worktree)).splitlines())
        rebasing = (Path(r.worktree) / ".git").exists() and False
        wt_git = Path(_ok(_git(["rev-parse", "--git-dir"], r.worktree)).strip())
        rebasing = (wt_git / "rebase-merge").exists() or (wt_git / "rebase-apply").exists()
    except Exception:
        dirty, rebasing = 0, False
    return {
        "repo": r.repo,
        "branch": r.branch,
        "base": r.base,
        "ahead": ahead,
        "behind": behind,
        "dirty": dirty,
        "rebasing": rebasing,
        "conflict": dirty > 0 and rebasing,
    }


def _status(fork: Fork) -> dict:
    repo_states = [_repo_status(r) for r in fork.repos]
    merged = fork.status == "MERGED" or all(s["ahead"] == 0 for s in repo_states) and fork.status == "MERGED"
    return {"repoStates": repo_states}


def list_forks() -> dict:
    data = _load()
    out = []
    for f in data["forks"]:
        fork = _find(data, f["id"])
        states = [_repo_status(r) for r in fork.repos]
        if fork.status in ("OPEN", "DIVERGED"):
            if any(s["rebasing"] for s in states):
                fork.status = "CONFLICT"
            elif any(s["behind"] > 0 and s["ahead"] > 0 for s in states):
                fork.status = "DIVERGED"
            elif fork.status == "DIVERGED" and not any(s["behind"] > 0 and s["ahead"] > 0 for s in states):
                fork.status = "OPEN"
            _write_back(data, fork)
        out.append({"fork": fork.to_json(), "repoStates": states})
    _save(data)
    return {"root": data["root"], "forks": out}


def sync_fork(fork_id: str) -> dict:
    data = _load()
    fork = _find(data, fork_id)
    results = []
    for r in fork.repos:
        proc = _git(["rebase", r.base], r.worktree)
        results.append(
            {
                "repo": r.repo,
                "ok": proc.returncode == 0,
                "output": (proc.stderr or proc.stdout or "").strip()[:1200],
            }
        )
    fork.status = "CONFLICT" if any(not x["ok"] for x in results) else "OPEN"
    fork.note = "" if fork.status == "OPEN" else "rebase 冲突：在 worktree 中解决后点「继续 rebase」"
    _write_back(data, fork)
    _save(data)
    return {"fork": fork.to_json(), "results": results}


def rebase_continue(fork_id: str, abort: bool = False) -> dict:
    data = _load()
    fork = _find(data, fork_id)
    results = []
    for r in fork.repos:
        # --continue reuses the recorded commit message, but git still consults
        # GIT_EDITOR/Core.editor for it; headless there is no editor, so the
        # rebase stalls and fails. ``GIT_EDITOR=true`` accepts the message.
        args = ["rebase", "--abort"] if abort else ["rebase", "--continue"]
        proc = _git(args, r.worktree, extra_env={"GIT_EDITOR": "true"})
        results.append({"repo": r.repo, "ok": proc.returncode == 0, "output": (proc.stderr or proc.stdout or "").strip()[:800]})
    fork.status = "OPEN" if all(x["ok"] for x in results) else "CONFLICT"
    _write_back(data, fork)
    _save(data)
    return {"fork": fork.to_json(), "results": results}


def commit_fork(fork_id: str, repo: str, message: str) -> dict:
    if not message or not message.strip():
        raise ValueError("commit message is required")
    data = _load()
    fork = _find(data, fork_id)
    r = next((x for x in fork.repos if x.repo == repo), None)
    if r is None:
        raise KeyError(repo)
    _ok(_git(["add", "-A"], r.worktree))
    proc = _git(["commit", "-m", message.strip()], r.worktree)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "nothing to commit").strip()[:800])
    return {"repo": repo, "commit": _ok(_git(["rev-parse", "--short", "HEAD"], r.worktree)).strip()}


def diff_fork(fork_id: str) -> dict:
    data = _load()
    fork = _find(data, fork_id)
    out = []
    for r in fork.repos:
        try:
            stat = _ok(_git(["diff", "--stat", f"{r.base}...HEAD"], r.worktree)).strip()
            patch = _ok(_git(["diff", f"{r.base}...HEAD"], r.worktree))[:120_000]
        except Exception as exc:
            stat, patch = f"error: {exc}", ""
        out.append({"repo": r.repo, "stat": stat, "patch": patch})
    return {"fork": fork.to_json(), "repos": out}


def merge_fork(fork_id: str) -> dict:
    data = _load()
    fork = _find(data, fork_id)
    results = []
    for r in fork.repos:
        # Guards: the main checkout must be ON the base branch and clean — a
        # merge that lands on whatever branch happens to be checked out is how
        # work silently lands in the wrong place.
        current = _ok(_git(["rev-parse", "--abbrev-ref", "HEAD"], r.repo_path)).strip()
        if current != r.base:
            results.append({"repo": r.repo, "ok": False, "output": f"主检出在 {current}，需切到 {r.base} 再合并"})
            continue
        dirty = _ok(_git(["status", "--porcelain"], r.repo_path)).strip()
        if dirty:
            results.append({"repo": r.repo, "ok": False, "output": "主检出有未提交改动，先处理再合并"})
            continue
        proc = _git(["merge", "--no-ff", r.branch, "-m", f"merge {r.branch} into {r.base}"], r.repo_path)
        results.append({"repo": r.repo, "ok": proc.returncode == 0, "output": (proc.stderr or proc.stdout or "").strip()[:800]})
    if all(x["ok"] for x in results):
        fork.status = "MERGED"
        _write_back(data, fork)
        _save(data)
    return {"fork": fork.to_json(), "results": results}


def close_fork(fork_id: str, delete_branch: bool = True) -> dict:
    data = _load()
    fork = _find(data, fork_id)
    if fork.status == "MERGED" or all(_repo_status(r)["ahead"] == 0 for r in fork.repos):
        pass  # nothing to lose
    results = []
    for r in fork.repos:
        proc = _git(["worktree", "remove", "--force", r.worktree], r.repo_path)
        results.append({"repo": r.repo, "ok": proc.returncode == 0, "output": (proc.stderr or "").strip()[:400]})
        if delete_branch:
            flag = "-d" if fork.status == "MERGED" else "-D"
            subprocess.run(["git", "-C", r.repo_path, "branch", flag, r.branch], capture_output=True, text=True)
    fork.status = "CLOSED"
    _write_back(data, fork)
    _save(data)
    return {"fork": fork.to_json(), "results": results}
