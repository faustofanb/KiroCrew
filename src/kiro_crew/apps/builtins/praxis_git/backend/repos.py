"""Repository registry — which checkouts Git Studio operates on.

Unlike the fork workbench (workspace-root scan), Git Studio tracks arbitrary
absolute paths the operator adds — the same freedom a desktop Git client has.
The registry persists to ``<crew home>/praxis-git/repositories.json`` as a
plain list; a missing path is reported, not silently dropped.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from kiro_crew.config.paths import config_dir

from . import git_adapter as ga


def _store_path() -> Path:
    d = config_dir() / "praxis-git"
    d.mkdir(parents=True, exist_ok=True)
    return d / "repositories.json"


def _load() -> list[dict]:
    p = _store_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data.get("repos", []) if isinstance(data, dict) else []
    except Exception:
        return []


def _save(repos: list[dict]) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"repos": repos}, ensure_ascii=False, indent=1), encoding="utf-8")


def _repo_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:10]


def resolve(repo_id: str) -> Path:
    """Registry id → absolute checkout path."""
    for r in _load():
        if r["id"] == repo_id:
            p = Path(r["path"])
            if not ga.is_git_repo(p):
                raise FileNotFoundError(
                    f"registered path is no longer a git repository: {r['path']}"
                )
            return p
    raise KeyError(repo_id)


def add_repo(raw_path: str) -> dict:
    """Register a checkout. Subdirectories resolve to their repo toplevel."""
    if not raw_path.strip():
        raise ValueError("path is required")
    expanded = Path(raw_path).expanduser()
    if not expanded.exists():
        raise FileNotFoundError(f"no such directory: {raw_path}")
    path = ga.toplevel_of(str(expanded))
    if path is None:
        raise ValueError(f"not inside a git repository: {raw_path}")
    repos = _load()
    rid = _repo_id(str(path))
    if any(r["id"] == rid for r in repos):
        return {"id": rid, "path": str(path), "alreadyRegistered": True}
    record = {"id": rid, "path": str(path), "name": path.name, "addedAt": int(time.time())}
    repos.append(record)
    _save(repos)
    return {"id": rid, "path": str(path), "name": path.name, "alreadyRegistered": False}


def remove_repo(repo_id: str) -> dict:
    repos = _load()
    kept = [r for r in repos if r["id"] != repo_id]
    if len(kept) == len(repos):
        raise KeyError(repo_id)
    _save(kept)
    return {"removed": repo_id}


def _repo_summary(record: dict) -> dict:
    p = Path(record["path"])
    item = {
        "id": record["id"],
        "path": record["path"],
        "name": record.get("name") or p.name,
        "available": ga.is_git_repo(p),
        "branch": "",
        "upstream": "",
        "ahead": None,
        "behind": None,
        "detached": False,
        "counts": {"staged": 0, "unstaged": 0, "untracked": 0, "conflicts": 0},
        "inProgress": None,
        "stashCount": 0,
        "head": "",
    }
    if not item["available"]:
        item["error"] = "path missing or no longer a git repository"
        return item
    try:
        out = ga.ok(
            p, ["status", "--porcelain=v2", "--branch", "--find-renames"], timeout=ga.READ_TIMEOUT
        )
        state = ga.parse_status(out)
        item.update(
            {
                "branch": state["branch"],
                "upstream": state["upstream"],
                "ahead": state["ahead"],
                "behind": state["behind"],
                "detached": state["detached"],
                "counts": state["counts"],
                "inProgress": ga.in_progress_op(p),
                "head": ga.ok(p, ["rev-parse", "--short", "HEAD"], timeout=ga.READ_TIMEOUT).strip(),
            }
        )
        stashes = ga.run(p, ["stash", "list", "--format=%gd"], timeout=ga.READ_TIMEOUT)
        if stashes.ok:
            item["stashCount"] = len([l for l in stashes.stdout.split("\n") if l.strip()])
    except ga.GitError as exc:
        item["error"] = str(exc)[:300]
    return item


def list_repos() -> dict:
    return {"repos": [_repo_summary(r) for r in _load()]}


def repo_status(repo_id: str) -> dict:
    p = resolve(repo_id)
    out = ga.ok(
        p, ["status", "--porcelain=v2", "--branch", "--find-renames"], timeout=ga.READ_TIMEOUT
    )
    state = ga.parse_status(out)
    state["repo"] = repo_id
    state["path"] = str(p)
    state["inProgress"] = ga.in_progress_op(p)
    stashes = ga.run(p, ["stash", "list", "--format=%gd"], timeout=ga.READ_TIMEOUT)
    state["stashCount"] = (
        len([l for l in stashes.stdout.split("\n") if l.strip()]) if stashes.ok else 0
    )
    state["head"] = ga.ok(p, ["rev-parse", "--short", "HEAD"], timeout=ga.READ_TIMEOUT).strip()
    return state
