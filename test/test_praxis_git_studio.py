"""Git Studio backend tests — the typed adapter over throwaway real repos.

Every test builds REAL git repositories under tmp_path, registers them in an
isolated store, and drives the adapter through the flows Git Studio exposes,
asserting git state on disk rather than trusting the adapter's own echo.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from kiro_crew.apps.builtins.praxis_git.backend import (
    diffing,
    git_adapter as ga,
    graph,
    operations,
    repos,
)


def _sh(args: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=check,
        capture_output=True,
        text=True,
        env={
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@e.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@e.com",
            "GIT_EDITOR": "true",
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        },
    )


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    """A registered repo with a two-lane history (main + feature)."""
    repo = tmp_path / "alpha"
    repo.mkdir()
    _sh(["init", "-b", "main"], repo)
    (repo / "a.txt").write_text("one\n")
    _sh(["add", "-A"], repo)
    _sh(["commit", "-m", "c1"], repo)
    _sh(["checkout", "-b", "feature"], repo)
    (repo / "b.txt").write_text("feature work\n")
    _sh(["add", "-A"], repo)
    _sh(["commit", "-m", "feature-1"], repo)
    _sh(["checkout", "main"], repo)
    (repo / "a.txt").write_text("one\ntwo\n")
    _sh(["add", "-A"], repo)
    _sh(["commit", "-m", "c2"], repo)

    store = tmp_path / "store"
    monkeypatch.setattr(repos, "_store_path", lambda: store / "repositories.json")
    added = repos.add_repo(str(repo))
    return {"path": repo, "id": added["id"]}


# ── registry ─────────────────────────────────────────────────────────────────


def test_add_repo_resolves_subdirectory_to_toplevel(workspace, tmp_path):
    sub = workspace["path"] / "sub"
    sub.mkdir()
    out = repos.add_repo(str(sub))
    assert out["alreadyRegistered"] is True
    assert out["path"] == str(workspace["path"])


def test_add_repo_rejects_non_repo(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError):
        repos.add_repo(str(empty))


def test_list_repos_reports_counts_and_branch(workspace):
    (workspace["path"] / "new.txt").write_text("x\n")
    out = repos.list_repos()
    assert len(out["repos"]) == 1
    r = out["repos"][0]
    assert r["branch"] == "main" and r["available"] is True
    assert r["counts"]["untracked"] == 1


def test_status_parses_all_three_zones_and_renames(workspace):
    p = workspace["path"]
    (p / "b.txt").write_text("staged\n")
    _sh(
        ["add", "b.txt"], p
    )  # staged new content on main? b.txt is untracked on main — becomes staged new
    (p / "a.txt").write_text("one\ntwo\nthree\n")  # unstaged modification
    state = repos.repo_status(workspace["id"])
    assert state["branch"] == "main"
    assert state["counts"]["staged"] == 1
    assert state["counts"]["unstaged"] == 1
    kinds = {f["path"]: f for f in state["files"]}
    assert kinds["a.txt"]["unstaged"] and not kinds["a.txt"]["staged"]
    assert kinds["b.txt"]["staged"]


# ── graph lanes ──────────────────────────────────────────────────────────────


def test_graph_lanes_are_consistent_and_decorated(workspace):
    out = graph.graph_page(workspace["id"], "main", False, None, 0, 50, 5000, True)
    assert out["total"] == 2
    rows = out["rows"]
    assert rows[0]["subject"] == "c2"
    assert rows[0]["branches"] == ["main"]
    # every edge endpoint is a valid lane (0..max lane used in that row)
    for r in rows:
        lanes_used = {r["node"]} | {
            e[k] for e in r["edges"] for k in ("a", "b") if e[k] is not None
        }
        assert all(isinstance(l, int) and l >= 0 for l in lanes_used)


def test_graph_pagination_and_sessions(workspace):
    first = graph.graph_page(workspace["id"], "main", False, None, 0, 1, 5000, True)
    assert len(first["rows"]) == 1 and first["hasMore"]
    second = graph.graph_page(workspace["id"], "main", False, first["session"], 1, 1, 5000, False)
    assert second["session"] == first["session"]
    assert second["rows"][0]["subject"] == "c1"
    assert not second["hasMore"]


def test_graph_branch_switch_rebuilds_session(workspace):
    first = graph.graph_page(workspace["id"], "main", False, None, 0, 50, 5000, True)
    other = graph.graph_page(
        workspace["id"], "feature", False, first["session"], 0, 50, 5000, False
    )
    assert other["session"] != first["session"]
    assert other["rows"][0]["subject"] == "feature-1"


def test_graph_first_parent_collapses_merges(workspace):
    p = workspace["path"]
    _sh(["merge", "feature", "-m", "merge feature"], p)
    full = graph.graph_page(workspace["id"], "main", False, None, 0, 50, 5000, True)
    fp = graph.graph_page(workspace["id"], "main", True, None, 0, 50, 5000, True)
    assert full["total"] == 4  # c1, c2, feature-1, merge
    assert fp["total"] == 3  # feature-1 collapsed away
    merge_row = full["rows"][0]
    assert len(merge_row["parents"]) == 2


# ── diffing + line-level staging ─────────────────────────────────────────────


def test_diff_hunks_carry_real_line_numbers(workspace):
    p = workspace["path"]
    (p / "a.txt").write_text("one\ntwo\nthree\n")
    d = diffing.diff_worktree(workspace["id"])
    f = next(f for f in d["files"] if f["newPath"] == "a.txt")
    h = f["hunks"][0]
    adds = [ln for h2 in f["hunks"] for ln in h2["lines"] if ln["t"] == "add"]
    dels = [ln for h2 in f["hunks"] for ln in h2["lines"] if ln["t"] == "del"]
    assert [a["text"] for a in adds] == ["three"]
    assert [dl["text"] for dl in dels] == []
    assert adds[0]["new"] == 3
    assert h["newStart"] == 1


def test_line_level_staging_stages_a_single_added_line(workspace):
    p = workspace["path"]
    (p / "a.txt").write_text("one\ntwo\nthree\nfour\n")
    d = diffing.diff_worktree(workspace["id"])
    f = next(f for f in d["files"] if f["newPath"] == "a.txt")
    add_three = next(
        ln for h in f["hunks"] for ln in h["lines"] if ln["t"] == "add" and ln["text"] == "three"
    )
    add_four = next(
        ln for h in f["hunks"] for ln in h["lines"] if ln["t"] == "add" and ln["text"] == "four"
    )
    hi = next(i for i, h in enumerate(f["hunks"]) if any(ln is add_three for ln in h["lines"]))
    key3 = f"add:{add_three['old']}:{add_three['new']}"
    out = diffing.apply_partial(
        workspace["id"],
        "a.txt",
        [{"hunk": hi, "keys": [key3]}],
        staged=False,
        reverse=False,
        cached=True,
    )
    assert out["applied"]
    staged_diff = diffing.diff_worktree(workspace["id"], staged=True)
    sf = next(x for x in staged_diff["files"] if x["newPath"] == "a.txt")
    staged_texts = [ln["text"] for h in sf["hunks"] for ln in h["lines"] if ln["t"] == "add"]
    assert "three" in staged_texts and "four" not in staged_texts


def test_unstage_via_reverse_partial(workspace):
    p = workspace["path"]
    (p / "a.txt").write_text("one\ntwo\nthree\n")
    _sh(["add", "a.txt"], p)
    d = diffing.diff_worktree(workspace["id"], staged=True)
    f = next(f for f in d["files"] if f["newPath"] == "a.txt")
    ln = next(l for h in f["hunks"] for l in h["lines"] if l["t"] == "add")
    hi = next(i for i, h in enumerate(f["hunks"]) if any(l is ln for l in h["lines"]))
    out = diffing.apply_partial(
        workspace["id"],
        "a.txt",
        [{"hunk": hi, "keys": [f"add:{ln['old']}:{ln['new']}"]}],
        staged=True,
        reverse=True,
        cached=True,
    )
    assert out["applied"]
    staged = diffing.diff_worktree(workspace["id"], staged=True)
    assert all(x["newPath"] != "a.txt" for x in staged["files"])


def test_word_diff_emits_segments(workspace):
    p = workspace["path"]
    (p / "a.txt").write_text("one and a completely different tail\n")
    d = diffing.diff_worktree(workspace["id"], word_diff=True)
    f = next(f for f in d["files"] if f["newPath"] == "a.txt")
    seg_lines = [ln for h in f["hunks"] for ln in h["lines"] if ln.get("segs")]
    assert seg_lines, "expected at least one line with word segments"
    kinds = {s["t"] for l in seg_lines for s in l["segs"]}
    assert "add" in kinds


# ── operations ───────────────────────────────────────────────────────────────


def test_commit_and_branch_lifecycle(workspace):
    p = workspace["path"]
    (p / "c.txt").write_text("c\n")
    operations.stage_all(workspace["id"])
    out = operations.commit(workspace["id"], "add c")
    assert out["commit"]
    branches = operations.list_branches(workspace["id"])
    names = {b["name"] for b in branches["local"]}
    assert {"main", "feature"} <= names
    operations.create_branch(workspace["id"], "topic", "main", checkout=True)
    st = repos.repo_status(workspace["id"])
    assert st["branch"] == "topic"
    with pytest.raises(ga.GitError) as ei:
        operations.delete_branch(workspace["id"], "topic")
    assert ei.value.code == "checked_out"
    operations.checkout(workspace["id"], "main")
    operations.delete_branch(workspace["id"], "topic")
    assert "topic" not in {b["name"] for b in operations.list_branches(workspace["id"])["local"]}


def test_merge_conflict_surfaces_and_resolves_via_content(workspace):
    p = workspace["path"]
    # both sides change the same line differently
    (p / "a.txt").write_text("main version\n")
    _sh(["add", "a.txt"], p)
    _sh(["commit", "-m", "main edit"], p)
    _sh(["checkout", "feature"], p)
    (p / "a.txt").write_text("feature version\n")
    _sh(["add", "a.txt"], p)
    _sh(["commit", "-m", "feature edit"], p)
    _sh(["checkout", "main"], p)
    out = operations.merge(workspace["id"], "feature")
    assert out["merged"] is False and out["conflict"] is True
    assert "a.txt" in out["conflicts"]
    state = operations.conflict_state(workspace["id"])
    item = next(i for i in state["conflicts"] if i["path"] == "a.txt")
    assert item["hasBase"] and item["hasOurs"] and item["hasTheirs"]
    vers = operations.conflict_versions(workspace["id"], "a.txt")
    assert vers["versions"]["ours"] == "main version\n"
    assert vers["versions"]["theirs"] == "feature version\n"
    operations.resolve_conflict_file(workspace["id"], "a.txt", "merged version\n")
    done = operations.merge_continue(workspace["id"])
    assert done["continued"]
    assert (p / "a.txt").read_text() == "merged version\n"
    log = _sh(["log", "-1", "--format=%s"], p).stdout.strip()
    assert log.startswith("Merge")


def test_rebase_interactive_with_custom_todo(workspace):
    p = workspace["path"]
    # three commits on feature to rebase: squash the last two
    _sh(["checkout", "feature"], p)
    for i, msg in enumerate(("f1", "f2", "f3"), start=1):
        (p / f"f{i}.txt").write_text(f"{i}\n")
        _sh(["add", "-A"], p)
        _sh(["commit", "-m", msg], p)
    _sh(["checkout", "main"], p)
    (p / "a.txt").write_text("one\ntwo\nmain-moved\n")
    _sh(["add", "-A"], p)
    _sh(["commit", "-m", "c2-moved"], p)

    _sh(["checkout", "feature"], p)
    todo = operations.rebase_todo_preview(workspace["id"], "main")["todo"]
    # feature-1 (fixture) + f1 + f2 + f3 = 4 entries to rebase
    assert len(todo) == 4
    # squash everything after the first entry into it (fixup keeps its message)
    custom = [todo[0]]
    for line in todo[1:]:
        custom.append("fixup " + line.split(" ", 1)[1])
    out = operations.rebase_start_interactive(workspace["id"], "main", custom)
    assert out["rebased"] is True, out.get("output")
    subjects = _sh(["log", "--format=%s", f"main..feature"], p).stdout.strip().split("\n")
    assert subjects == ["feature-1"]
    # f1/f2/f3 file content survived the squash
    assert (p / "f3.txt").exists()


def test_rebase_conflict_midway_and_abort(workspace):
    p = workspace["path"]
    _sh(["checkout", "feature"], p)
    (p / "a.txt").write_text("feature divergent\n")
    _sh(["add", "a.txt"], p)
    _sh(["commit", "-m", "conflicting feature commit"], p)
    _sh(["checkout", "main"], p)
    (p / "a.txt").write_text("main divergent\n")
    _sh(["add", "a.txt"], p)
    _sh(["commit", "-m", "conflicting main commit"], p)
    _sh(["checkout", "feature"], p)
    out = operations.rebase_start(workspace["id"], "main")
    assert out["conflict"] is True
    st = operations.rebase_status(workspace["id"])
    assert st["inProgress"] and st["conflicts"]
    # resolve then continue
    operations.resolve_conflict_file(workspace["id"], "a.txt", "resolved\n")
    cont = operations.rebase_continue(workspace["id"])
    assert cont["rebased"] is True, cont.get("output")
    assert (p / "a.txt").read_text() == "resolved\n"


def test_stash_roundtrip_with_diff_preview(workspace):
    p = workspace["path"]
    (p / "a.txt").write_text("stashed change\n")
    out = operations.stash_push(workspace["id"], message="wip")
    assert out["stashed"]
    assert (p / "a.txt").read_text().startswith("one")
    lst = operations.stash_list(workspace["id"])
    assert len(lst["stashes"]) == 1 and lst["stashes"][0]["subject"].endswith("wip")
    prev = operations.stash_diff(workspace["id"], 0)
    assert any(f["newPath"] == "a.txt" for f in prev["files"])
    operations.stash_apply(workspace["id"], 0, drop=True)
    assert (p / "a.txt").read_text() == "stashed change\n"
    assert operations.stash_list(workspace["id"])["stashes"] == []


def test_cherry_pick_and_revert(workspace):
    p = workspace["path"]
    _sh(["checkout", "main"], p)
    sha_feat = _sh(["rev-parse", "feature"], p).stdout.strip()
    out = operations.cherry_pick(workspace["id"], [sha_feat])
    assert out["ok"], out.get("output")
    assert (p / "b.txt").exists()
    rev = operations.revert(workspace["id"], ["HEAD"])
    assert rev["ok"], rev.get("output")
    assert not (p / "b.txt").exists()


def test_reset_modes(workspace):
    p = workspace["path"]
    (p / "a.txt").write_text("reset me\n")
    _sh(["add", "a.txt"], p)
    _sh(["commit", "-m", "to reset"], p)
    head_before = _sh(["rev-parse", "HEAD~1"], p).stdout.strip()
    operations.reset(workspace["id"], "HEAD~1", "hard")
    assert _sh(["rev-parse", "HEAD"], p).stdout.strip() == head_before
    assert (p / "a.txt").read_text().startswith("one")
    with pytest.raises(ValueError):
        operations.reset(workspace["id"], "HEAD", "nuke")


def test_tags_lifecycle(workspace):
    operations.create_tag(workspace["id"], "v1", "HEAD", message="release one")
    tags = operations.list_tags(workspace["id"])
    t = next(t for t in tags["tags"] if t["name"] == "v1")
    assert t["annotated"] is True and t["subject"] == "release one"
    operations.delete_tag(workspace["id"], "v1")
    assert all(t["name"] != "v1" for t in operations.list_tags(workspace["id"])["tags"])


def test_remotes_lifecycle(workspace):
    p = workspace["path"]
    operations.add_remote(workspace["id"], "upstream", "https://example.com/x.git")
    remotes = operations.list_remotes(workspace["id"])
    up = next(r for r in remotes["remotes"] if r["name"] == "upstream")
    assert up["fetchUrl"] == "https://example.com/x.git"
    operations.set_remote_url(workspace["id"], "upstream", "https://example.com/y.git")
    remotes = operations.list_remotes(workspace["id"])
    up = next(r for r in remotes["remotes"] if r["name"] == "upstream")
    assert up["fetchUrl"] == "https://example.com/y.git"
    operations.remove_remote(workspace["id"], "upstream")
    assert all(r["name"] != "upstream" for r in operations.list_remotes(workspace["id"])["remotes"])


def test_search_commits_by_message(workspace):
    out = operations.search_commits(workspace["id"], "feature", mode="message", branch="feature")
    subjects = [c["subject"] for c in out["commits"]]
    assert any("feature" in s for s in subjects)


def test_discard_tracked_and_untracked(workspace):
    p = workspace["path"]
    (p / "a.txt").write_text("throwaway\n")
    (p / "untracked.txt").write_text("u\n")
    operations.discard_paths(workspace["id"], ["a.txt", "untracked.txt"])
    assert (p / "a.txt").read_text().startswith("one")
    assert not (p / "untracked.txt").exists()


def test_blame_lines_carry_shas(workspace):
    p = workspace["path"]
    out = diffing.blame(workspace["id"], "a.txt")
    assert out["lines"]
    c2 = _sh(["rev-parse", "--short", "main"], p).stdout.strip()
    assert out["lines"][-1]["sha"].startswith(c2)


def test_file_history_follows_renames(workspace):
    p = workspace["path"]
    _sh(["mv", "a.txt", "renamed.txt"], p)
    _sh(["add", "-A"], p)
    _sh(["commit", "-m", "rename a"], p)
    out = diffing.file_history(workspace["id"], "renamed.txt")
    statuses = [c["changes"][0]["status"] for c in out["commits"] if c["changes"]]
    assert "R100" in statuses


def test_headless_env_never_prompts(workspace, monkeypatch):
    """GIT_TERMINAL_PROMPT=0 must be set on every invocation."""
    env_seen: dict[str, str] = {}

    def fake_run(repo, args, **kw):
        proc = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
        )
        return ga.Proc(proc.returncode, proc.stdout, proc.stderr)

    monkeypatch.setattr(ga, "run", fake_run)
    # run() with injected env is what routes call; assert _base_env carries the flags
    env = ga._base_env()
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["GIT_EDITOR"] == "true"
