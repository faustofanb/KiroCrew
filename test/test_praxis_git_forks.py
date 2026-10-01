"""Real-git fork workbench tests — the whole lifecycle over throwaway repos.

Each test builds a workspace of one or two REAL git repositories under
tmp_path, points the registry at it, and drives the fork through create →
commit → sync → merge → close, asserting the git state on disk rather than
trusting our own bookkeeping.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from kiro_crew.apps.builtins.praxis_insight.backend import git_forks


def _sh(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    """A workspace root with two initialized repos on branch ``main``."""
    for name in ("alpha", "beta"):
        repo = tmp_path / name
        repo.mkdir()
        _sh(["init", "-b", "main"], repo)
        _sh(["config", "user.email", "t@example.com"], repo)
        _sh(["config", "user.name", "t"], repo)
        (repo / "file.txt").write_text(f"{name}-1\n")
        _sh(["add", "-A"], repo)
        _sh(["commit", "-m", "c1"], repo)

    store = tmp_path / "store"
    monkeypatch.setattr(git_forks, "_store_path", lambda: store / "forks.json")

    git_forks.set_root(str(tmp_path))
    return tmp_path


def test_scan_finds_both_repos(workspace):
    out = git_forks.scan_repos()
    names = [r["name"] for r in out["repos"]]
    assert names == ["alpha", "beta"]
    assert all(r["branch"] == "main" and r["dirty"] == 0 for r in out["repos"])


def test_create_fork_makes_real_worktrees_and_branches(workspace):
    out = git_forks.create_fork(["alpha", "beta"], "main", "演示 fork")
    fid = out["fork"]["id"]
    for r in out["fork"]["repos"]:
        wt = Path(r["worktree"])
        assert wt.exists() and (wt / ".git").exists()
        branch = subprocess.run(
            ["git", "-C", str(wt), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True,
        ).stdout.strip()
        assert branch == f"fork/{fid}"


def test_commit_then_ahead_is_visible(workspace):
    out = git_forks.create_fork(["alpha"], "main", "")
    fid = out["fork"]["id"]
    wt = Path(out["fork"]["repos"][0]["worktree"])
    (wt / "file.txt").write_text("alpha-2\n")
    commit = git_forks.commit_fork(fid, "alpha", "c2 on fork")
    assert commit["commit"]
    listed = git_forks.list_forks()
    state = listed["forks"][0]["repoStates"][0]
    assert state["ahead"] == 1 and state["behind"] == 0


def test_base_moves_fork_reports_diverged_then_sync_rebases(workspace):
    out = git_forks.create_fork(["alpha"], "main", "")
    fid = out["fork"]["id"]
    wt = Path(out["fork"]["repos"][0]["worktree"])
    (wt / "fork.txt").write_text("fork work\n")
    git_forks.commit_fork(fid, "alpha", "fork commit")

    # Upstream moves on main.
    repo = workspace / "alpha"
    (repo / "file.txt").write_text("alpha-1\nupstream\n")
    _sh(["add", "-A"], repo)
    _sh(["commit", "-m", "upstream commit"], repo)

    listed = git_forks.list_forks()
    assert listed["forks"][0]["fork"]["status"] == "DIVERGED"

    result = git_forks.sync_fork(fid)
    assert result["fork"]["status"] == "OPEN"
    # Rebase put the fork commit on top of upstream: both files present.
    assert (wt / "fork.txt").exists()
    assert "upstream" in (wt / "file.txt").read_text()
    listed = git_forks.list_forks()
    assert listed["forks"][0]["repoStates"][0]["behind"] == 0


def test_merge_requires_base_checked_out_and_lands_commits(workspace):
    out = git_forks.create_fork(["alpha"], "main", "")
    fid = out["fork"]["id"]
    wt = Path(out["fork"]["repos"][0]["worktree"])
    (wt / "merged.txt").write_text("from fork\n")
    git_forks.commit_fork(fid, "alpha", "to merge")

    result = git_forks.merge_fork(fid)
    assert result["fork"]["status"] == "MERGED"
    assert (workspace / "alpha" / "merged.txt").exists()
    log = subprocess.run(
        ["git", "-C", str(workspace / "alpha"), "log", "--oneline"],
        capture_output=True, text=True,
    ).stdout
    assert "to merge" in log


def test_merge_refuses_when_main_checkout_is_on_another_branch(workspace):
    out = git_forks.create_fork(["alpha"], "main", "")
    fid = out["fork"]["id"]
    repo = workspace / "alpha"
    _sh(["checkout", "-b", "elsewhere"], repo)
    result = git_forks.merge_fork(fid)
    assert result["results"][0]["ok"] is False
    assert "elsewhere" in result["results"][0]["output"]


def test_close_removes_worktree_and_branch(workspace):
    out = git_forks.create_fork(["alpha"], "main", "")
    fid = out["fork"]["id"]
    wt = Path(out["fork"]["repos"][0]["worktree"])
    git_forks.close_fork(fid)
    assert not wt.exists()
    branches = subprocess.run(
        ["git", "-C", str(workspace / "alpha"), "branch", "--list", "fork/*"],
        capture_output=True, text=True,
    ).stdout.strip()
    assert branches == ""


def test_registry_persists_across_loads(workspace):
    out = git_forks.create_fork(["beta"], "main", "持久化")
    data = json.loads(git_forks._store_path().read_text(encoding="utf-8"))
    assert any(f["id"] == out["fork"]["id"] for f in data["forks"])
    assert git_forks.list_forks()["forks"][0]["fork"]["title"] == "持久化"
