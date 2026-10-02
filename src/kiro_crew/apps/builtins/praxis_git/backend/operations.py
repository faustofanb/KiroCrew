"""Git operations — staging, commits, branches, merge + conflict resolution,
interactive rebase with a first-class todo editor, stash, cherry-pick, revert,
reset, tags, remotes, worktrees, submodule status and commit search.

Everything here is a real git invocation. Destructive operations carry
explicit guards (force flags, current-branch protection) so the confirm
dialog in the UI is backed by an unwilling backend, not just a dialog.
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

from . import git_adapter as ga
from .diffing import diff_worktree, parse_patch
from .repos import resolve

_REV_RE = re.compile(r"^[A-Za-z0-9_@./^~:-]+$")
_BRANCH_RE = re.compile(r"^[^\s~^:?*[\]\\]+$")


def _rev(rev: str) -> str:
    if not rev or not _REV_RE.match(rev):
        raise ga.GitError(f"invalid revision: {rev!r}", code="bad_revision")
    return rev


def _branch(name: str) -> str:
    if not name or not _BRANCH_RE.match(name) or name.startswith("-") or ".." in name:
        raise ga.GitError(f"invalid branch name: {name!r}", code="bad_name")
    return name


# ── staging / committing ─────────────────────────────────────────────────────


def stage_paths(repo_id: str, paths: list[str]) -> dict:
    repo = resolve(repo_id)
    if not paths:
        raise ValueError("no paths")
    ga.ok(repo, ["add", "-A", "--", *paths])
    return {"staged": paths}


def unstage_paths(repo_id: str, paths: list[str]) -> dict:
    repo = resolve(repo_id)
    if not paths:
        raise ValueError("no paths")
    proc = ga.run(repo, ["reset", "HEAD", "--", *paths])
    if not proc.ok:
        # unborn branch: nothing staged, reset is a no-op success
        if "unknown revision" in (proc.stderr or ""):
            return {"unstaged": paths, "unborn": True}
        raise ga.GitError((proc.stderr or proc.stdout).strip()[:800])
    return {"unstaged": paths}


def stage_all(repo_id: str, include_untracked: bool = True) -> dict:
    repo = resolve(repo_id)
    ga.ok(repo, ["add", "-A"] + ([] if include_untracked else ["-u"]))
    return {"stagedAll": True}


def unstage_all(repo_id: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["reset", "HEAD"])
    if not proc.ok and "unknown revision" not in (proc.stderr or ""):
        raise ga.GitError((proc.stderr or proc.stdout).strip()[:800])
    return {"unstagedAll": True}


def discard_paths(repo_id: str, paths: list[str], staged_too: bool = False) -> dict:
    """Throw away working-tree changes for paths (dangerous — UI confirms).

    ``staged_too`` restores both index and worktree from HEAD.
    """
    repo = resolve(repo_id)
    if not paths:
        raise ValueError("no paths")
    if staged_too:
        ga.ok(repo, ["checkout", "HEAD", "--", *paths])
    else:
        # untracked files can only be discarded by removal; tracked changes
        # revert through a reverse apply of the unstaged diff
        st = ga.parse_status(
            ga.ok(repo, ["status", "--porcelain=v2", "--branch"], timeout=ga.READ_TIMEOUT)
        )
        untracked = [f["path"] for f in st["files"] if f["untracked"] and f["path"] in paths]
        tracked = [p for p in paths if p not in untracked]
        if tracked:
            ga.ok(repo, ["checkout", "--", *tracked])
        for p in untracked:
            target = repo / p
            if target.is_file():
                target.unlink()
    return {"discarded": paths, "stagedToo": staged_too}


def commit(repo_id: str, message: str, amend: bool = False, signoff: bool = False) -> dict:
    if not message or not message.strip():
        raise ValueError("commit message is required")
    repo = resolve(repo_id)
    args = ["commit", "-m", message.strip()]
    if amend:
        args.append("--amend")
    if signoff:
        args.append("--signoff")
    proc = ga.run(repo, args, env_extra={"GIT_EDITOR": "true"})
    if not proc.ok:
        raise ga.GitError(
            (proc.stderr or proc.stdout or "commit failed").strip()[:800], code="commit_failed"
        )
    sha = ga.ok(repo, ["rev-parse", "--short", "HEAD"], timeout=ga.READ_TIMEOUT).strip()
    return {"commit": sha, "amended": amend}


# ── branches ─────────────────────────────────────────────────────────────────

_TRACK_RE = re.compile(r"\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]|\[gone\]")


def list_branches(repo_id: str) -> dict:
    repo = resolve(repo_id)
    out = ga.ok(
        repo,
        [
            "for-each-ref",
            "--format="
            "%(objectname)%1f%(objectname:short)%1f%(refname:short)%1f%(HEAD)%1f"
            "%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(subject)",
            "refs/heads",
        ],
        timeout=ga.READ_TIMEOUT,
    )
    local: list[dict] = []
    for line in out.strip().split("\n"):
        if not line.strip():
            continue
        sha, short, name, head, upstream, track, ts, subject = (line.split("\x1f") + [""] * 8)[:8]
        ahead = behind = None
        if track and track != "gone":
            ma = re.search(r"ahead (\d+)", track)
            mb = re.search(r"behind (\d+)", track)
            ahead = int(ma.group(1)) if ma else 0
            behind = int(mb.group(1)) if mb else 0
        local.append(
            {
                "name": name,
                "sha": short,
                "current": head == "*",
                "upstream": upstream,
                "track": track,
                "ahead": ahead,
                "behind": behind,
                "timestamp": int(ts) if ts.isdigit() else 0,
                "subject": subject[:100],
            }
        )
    remotes_out = ga.run(
        repo,
        [
            "for-each-ref",
            "--format=%(objectname:short)%1f%(refname:short)%1f%(committerdate:unix)",
            "refs/remotes",
        ],
        timeout=ga.READ_TIMEOUT,
    )
    remote: list[dict] = []
    if remotes_out.ok:
        for line in remotes_out.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = (line.split("\x1f") + ["", "", ""])[:3]
            remote.append(
                {
                    "name": parts[1],
                    "sha": parts[0],
                    "timestamp": int(parts[2]) if parts[2].isdigit() else 0,
                }
            )
    return {"repo": repo_id, "local": local, "remote": remote}


def create_branch(repo_id: str, name: str, ref: str = "HEAD", checkout: bool = True) -> dict:
    repo = resolve(repo_id)
    name = _branch(name)
    ga.ok(repo, ["branch", name, _rev(ref)])
    if checkout:
        ga.ok(repo, ["checkout", name])
    return {"branch": name, "checkedOut": checkout}


def checkout(repo_id: str, ref: str, create: str | None = None) -> dict:
    repo = resolve(repo_id)
    if create:
        create = _branch(create)
        ga.ok(repo, ["checkout", "-b", create, _rev(ref)])
        return {"checkedOut": create, "created": True}
    ga.ok(repo, ["checkout", _rev(ref)])
    return {"checkedOut": ref, "created": False}


def delete_branch(repo_id: str, name: str, force: bool = False) -> dict:
    repo = resolve(repo_id)
    name = _branch(name)
    current = ga.ok(repo, ["rev-parse", "--abbrev-ref", "HEAD"], timeout=ga.READ_TIMEOUT).strip()
    if name == current:
        raise ga.GitError(f"{name} is checked out", code="checked_out")
    proc = ga.run(repo, ["branch", "-D" if force else "-d", name])
    if not proc.ok:
        raise ga.GitError(
            (proc.stderr or "delete failed").strip()[:600],
            code="unmerged_branch" if "not fully merged" in (proc.stderr or "") else "git_error",
            hint="use force to delete an unmerged branch",
        )
    return {"deleted": name, "force": force}


def rename_branch(repo_id: str, old: str, new: str) -> dict:
    repo = resolve(repo_id)
    ga.ok(repo, ["branch", "-m", _branch(old), _branch(new)])
    return {"renamed": {old: new}}


def set_upstream(repo_id: str, branch: str, upstream: str) -> dict:
    repo = resolve(repo_id)
    if upstream in ("", "-", "none"):
        ga.ok(repo, ["branch", "--unset-upstream", _branch(branch)])
        return {"branch": branch, "upstream": None}
    ga.ok(repo, ["branch", "--set-upstream-to", _rev(upstream), _branch(branch)])
    return {"branch": branch, "upstream": upstream}


# ── merge + conflict resolution ──────────────────────────────────────────────


def _conflict_files(repo: Path) -> list[str]:
    proc = ga.run(repo, ["diff", "--name-only", "--diff-filter=U"], timeout=ga.READ_TIMEOUT)
    if not proc.ok:
        return []
    return [l for l in proc.stdout.strip().split("\n") if l.strip()]


def merge(repo_id: str, source: str, no_ff: bool = True, message: str = "") -> dict:
    repo = resolve(repo_id)
    args = ["merge", _rev(source)]
    if no_ff:
        args.append("--no-ff")
    if message:
        args += ["-m", message]
    proc = ga.run(repo, args, env_extra={"GIT_EDITOR": "true"})
    if not proc.ok:
        conflicts = _conflict_files(repo)
        if conflicts or "CONFLICT" in (proc.stderr or "") + (proc.stdout or ""):
            return {
                "merged": False,
                "conflict": True,
                "conflicts": conflicts,
                "output": ((proc.stderr or "") + (proc.stdout or "")).strip()[:2000],
            }
        raise ga.GitError(
            (proc.stderr or proc.stdout or "merge failed").strip()[:800], code="merge_failed"
        )
    return {"merged": True, "conflict": False, "output": (proc.stdout or "").strip()[:1500]}


def merge_abort(repo_id: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["merge", "--abort"])
    if not proc.ok:
        raise ga.GitError((proc.stderr or "no merge to abort").strip()[:400], code="no_merge")
    return {"aborted": True}


def merge_continue(repo_id: str, message: str = "") -> dict:
    repo = resolve(repo_id)
    args = ["merge", "--continue"]
    if message:
        args += ["-m", message]
    proc = ga.run(repo, args, env_extra={"GIT_EDITOR": "true"})
    if not proc.ok:
        raise ga.GitError((proc.stderr or proc.stdout).strip()[:800], code="conflict_pending")
    return {"continued": True}


def conflict_state(repo_id: str) -> dict:
    """Files in conflict with stage-1/2/3 availability for the three-pane view."""
    repo = resolve(repo_id)
    files = _conflict_files(repo)
    items = []
    for path in files:
        stages = ga.run(repo, ["ls-files", "-u", "--", path], timeout=ga.READ_TIMEOUT)
        vers: dict[int, str] = {}
        if stages.ok:
            for line in stages.stdout.strip().split("\n"):
                bits = line.split("\t", 1)
                meta = bits[0].split(" ")
                if len(meta) >= 3 and meta[2].isdigit():
                    vers[int(meta[2])] = "blob"
        items.append(
            {
                "path": path,
                "stages": sorted(vers.keys()),
                "hasBase": 1 in vers,
                "hasOurs": 2 in vers,
                "hasTheirs": 3 in vers,
            }
        )
    return {"repo": repo_id, "conflicts": items}


def conflict_versions(repo_id: str, path: str) -> dict:
    """base(:1) / ours(:2) / theirs(:3) content for the three-pane resolver."""
    repo = resolve(repo_id)
    if not path or ".." in path or path.startswith("/"):
        raise ValueError("path is required")
    out: dict[str, str | None] = {}
    labels: dict[str, str] = {}
    for stage, key in ((1, "base"), (2, "ours"), (3, "theirs")):
        proc = ga.run(repo, ["show", f":{stage}:{path}"], timeout=ga.READ_TIMEOUT)
        if proc.ok:
            out[key] = proc.stdout[:600_000]
        else:
            out[key] = None
    try:
        head_txt = ga.ok(
            repo, ["symbolic-ref", "-q", "--short", "HEAD"], timeout=ga.READ_TIMEOUT
        ).strip()
        labels["ours"] = f"HEAD ({head_txt})"
    except ga.GitError:
        labels["ours"] = "HEAD"
    # MERGE_MSG's first line names the incoming side for most merges
    msg_path = repo / ".git" / "MERGE_MSG"
    try:
        first = msg_path.read_text(encoding="utf-8", errors="replace").split("\n", 1)[0]
        labels["theirs"] = first if first else "MERGE_HEAD"
    except Exception:
        labels["theirs"] = "MERGE_HEAD"
    # the working-tree file carries the conflict markers — the canvas the
    # block editor parses
    worktree: str | None = None
    try:
        wt_path = repo / path
        if wt_path.is_file():
            worktree = wt_path.read_text(encoding="utf-8", errors="replace")[:600_000]
    except OSError:
        worktree = None
    return {"repo": repo_id, "path": path, "versions": out, "labels": labels, "worktree": worktree}


def resolve_conflict_file(repo_id: str, path: str, content: str) -> dict:
    """Write resolved content and mark the path resolved (git add)."""
    repo = resolve(repo_id)
    if not path or ".." in path or path.startswith("/"):
        raise ValueError("path is required")
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", errors="surrogateescape")
    ga.ok(repo, ["add", "--", path])
    return {"path": path, "resolved": True}


def resolve_conflict_take(repo_id: str, path: str, side: str) -> dict:
    """Resolve with --ours / --theirs (or delete when both deleted)."""
    repo = resolve(repo_id)
    if side not in ("ours", "theirs"):
        raise ValueError("side must be 'ours' or 'theirs'")
    ga.ok(repo, ["checkout", f"--{side}", "--", path])
    ga.ok(repo, ["add", "--", path])
    return {"path": path, "took": side}


# ── rebase (incl. interactive todo editor) ───────────────────────────────────


def _rebase_dir(repo: Path) -> Path | None:
    proc = ga.run(repo, ["rev-parse", "--git-dir"], timeout=ga.READ_TIMEOUT)
    if not proc.ok:
        return None
    gitdir = Path(proc.stdout.strip())
    if not gitdir.is_absolute():
        gitdir = repo / gitdir
    return gitdir / "rebase-merge" if (gitdir / "rebase-merge").exists() else None


def rebase_status(repo_id: str) -> dict:
    repo = resolve(repo_id)
    rb = _rebase_dir(repo)
    if rb is None:
        return {"repo": repo_id, "inProgress": False}

    def _read(name: str) -> str:
        try:
            return (rb / name).read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""

    todo = [l for l in _read("git-rebase-todo").split("\n") if l.strip() and not l.startswith("#")]
    done = [l for l in _read("done").split("\n") if l.strip()]
    return {
        "repo": repo_id,
        "inProgress": True,
        "interactive": True,
        "onto": _read("onto").strip(),
        "origHead": _read("orig-head").strip(),
        "stoppedAt": _read("stopped-sha").strip(),
        "headline": _read("message").strip()[:300],
        "done": done,
        "todo": todo,
        "conflicts": _conflict_files(repo),
    }


def rebase_start(
    repo_id: str, upstream: str, onto: str | None = None, branch: str | None = None
) -> dict:
    repo = resolve(repo_id)
    args = ["rebase", _rev(upstream)]
    if onto:
        args += ["--onto", _rev(onto)]
    if branch:
        args.append(_branch(branch))
    proc = ga.run(repo, args, env_extra={"GIT_EDITOR": "true"})
    return _rebase_result(proc, repo_id)


def rebase_start_interactive(repo_id: str, upstream: str, todo_lines: list[str]) -> dict:
    """Start ``rebase -i`` with OUR todo (the editor step is pre-applied).

    GIT_SEQUENCE_EDITOR copies the operator-approved todo over git's draft,
    so the rebase runs the exact plan the UI showed.
    """
    repo = resolve(repo_id)
    todo_lines = [l for l in (l.strip() for l in todo_lines) if l]
    if not todo_lines:
        raise ValueError("todo is empty")
    for l in todo_lines:
        cmd = l.split()[0]
        if cmd not in (
            "pick",
            "p",
            "reword",
            "r",
            "edit",
            "e",
            "squash",
            "s",
            "fixup",
            "f",
            "drop",
            "d",
            "exec",
            "x",
            "break",
            "b",
            "label",
            "l",
            "reset",
            "t",
            "merge",
            "m",
        ):
            raise ValueError(f"unknown todo command: {cmd}")
    with tempfile.NamedTemporaryFile("w", suffix="-rebase-todo", delete=False) as tf:
        tf.write("\n".join(todo_lines) + "\n")
        todo_path = tf.name
    try:
        proc = ga.run(
            repo,
            ["rebase", "-i", _rev(upstream)],
            env_extra={"GIT_SEQUENCE_EDITOR": f'cp "{todo_path}"', "GIT_EDITOR": "true"},
        )
    finally:
        Path(todo_path).unlink(missing_ok=True)
    return _rebase_result(proc, repo_id)


def rebase_todo_preview(repo_id: str, upstream: str) -> dict:
    """The default todo git would offer (pick each commit in order)."""
    repo = resolve(repo_id)
    out = ga.ok(
        repo,
        ["log", "--reverse", "--format=pick %h %s", f"{_rev(upstream)}..HEAD"],
        timeout=ga.READ_TIMEOUT,
    )
    return {"upstream": upstream, "todo": [l for l in out.strip().split("\n") if l.strip()]}


def _rebase_result(proc: ga.Proc, repo_id: str) -> dict:
    if proc.ok:
        return {
            "repo": repo_id,
            "rebased": True,
            "conflict": False,
            "output": (proc.stdout or "").strip()[:1500],
        }
    conflicts = _conflict_files(resolve(repo_id))
    return {
        "repo": repo_id,
        "rebased": False,
        "conflict": bool(conflicts),
        "conflicts": conflicts,
        "output": ((proc.stderr or "") + (proc.stdout or "")).strip()[:2000],
    }


def rebase_continue(repo_id: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["rebase", "--continue"], env_extra={"GIT_EDITOR": "true"})
    return _rebase_result(proc, repo_id)


def rebase_skip(repo_id: str) -> dict:
    repo = resolve(repo_id)
    return _rebase_result(
        ga.run(repo, ["rebase", "--skip"], env_extra={"GIT_EDITOR": "true"}), repo_id
    )


def rebase_abort(repo_id: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["rebase", "--abort"], env_extra={"GIT_EDITOR": "true"})
    if not proc.ok:
        raise ga.GitError((proc.stderr or "no rebase to abort").strip()[:400], code="no_rebase")
    return {"aborted": True}


def rebase_reword_stopped(repo_id: str, message: str) -> dict:
    """During an 'edit'/conflict stop, amend the current commit's message."""
    if not message.strip():
        raise ValueError("message is required")
    repo = resolve(repo_id)
    proc = ga.run(
        repo, ["commit", "--amend", "-m", message.strip()], env_extra={"GIT_EDITOR": "true"}
    )
    if not proc.ok:
        raise ga.GitError((proc.stderr or proc.stdout).strip()[:600], code="commit_failed")
    return {"amended": True}


# ── stash ────────────────────────────────────────────────────────────────────


def stash_list(repo_id: str) -> dict:
    repo = resolve(repo_id)
    out = ga.ok(
        repo,
        ["stash", "list", "--format=%gd%x1f%H%x1f%ci%x1f%gs"],
        timeout=ga.READ_TIMEOUT,
    )
    items = []
    for line in out.strip().split("\n"):
        if not line.strip():
            continue
        ref, sha, date, subject = (line.split("\x1f") + ["", "", "", ""])[:4]
        items.append({"ref": ref, "sha": sha[:8], "date": date, "subject": subject})
    return {"repo": repo_id, "stashes": items}


def stash_push(
    repo_id: str, message: str = "", include_untracked: bool = False, staged_only: bool = False
) -> dict:
    repo = resolve(repo_id)
    args = ["stash", "push"]
    if message:
        args += ["-m", message]
    if include_untracked:
        args.append("-u")
    if staged_only:
        args.append("--staged")
    proc = ga.run(repo, args)
    if not proc.ok:
        if "local changes" not in (proc.stderr or "") and "No local changes" not in (
            proc.stderr or ""
        ):
            raise ga.GitError((proc.stderr or proc.stdout).strip()[:600], code="stash_failed")
        return {"stashed": False, "note": (proc.stderr or proc.stdout).strip()[:300]}
    return {"stashed": True}


def stash_apply(repo_id: str, index: int, drop: bool = False) -> dict:
    repo = resolve(repo_id)
    ref = f"stash@{{{max(0, int(index))}}}"
    args = ["stash", "pop" if drop else "apply", ref]
    proc = ga.run(repo, args)
    if not proc.ok:
        conflicts = _conflict_files(repo)
        raise ga.GitError(
            (proc.stderr or proc.stdout).strip()[:800],
            code="stash_conflict" if conflicts else "stash_failed",
        )
    return {"applied": ref, "dropped": drop}


def stash_drop(repo_id: str, index: int) -> dict:
    repo = resolve(repo_id)
    ga.ok(repo, ["stash", "drop", f"stash@{{{max(0, int(index))}}}"])
    return {"dropped": index}


def stash_branch(repo_id: str, index: int, name: str) -> dict:
    repo = resolve(repo_id)
    ga.ok(repo, ["stash", "branch", _branch(name), f"stash@{{{max(0, int(index))}}}"])
    return {"branched": name}


def stash_diff(repo_id: str, index: int) -> dict:
    repo = resolve(repo_id)
    ref = f"stash@{{{max(0, int(index))}}}"
    raw = ga.run(repo, ["stash", "show", "-p", "--no-color", "-M", ref], timeout=ga.READ_TIMEOUT)
    stat = ga.run(repo, ["stash", "show", "--stat", "--format=", ref], timeout=ga.READ_TIMEOUT)
    parsed = parse_patch(raw.stdout[:400_000]) if raw.ok else {"files": []}
    return {
        "repo": repo_id,
        "stash": ref,
        "stat": stat.stdout.strip() if stat.ok else "",
        "files": parsed["files"],
    }


# ── cherry-pick / revert ─────────────────────────────────────────────────────


def cherry_pick(repo_id: str, shas: list[str], no_commit: bool = False) -> dict:
    repo = resolve(repo_id)
    if not shas:
        raise ValueError("no commits")
    args = ["cherry-pick"]
    if no_commit:
        args.append("--no-commit")
    args += [_rev(s) for s in shas]
    proc = ga.run(repo, args, env_extra={"GIT_EDITOR": "true"})
    return _seq_result(proc, repo_id, "cherry-pick")


def revert(repo_id: str, shas: list[str], no_commit: bool = False) -> dict:
    repo = resolve(repo_id)
    if not shas:
        raise ValueError("no commits")
    args = ["revert"]
    if no_commit:
        args.append("--no-commit")
    args += [_rev(s) for s in shas]
    proc = ga.run(repo, args, env_extra={"GIT_EDITOR": "true"})
    return _seq_result(proc, repo_id, "revert")


def _seq_result(proc: ga.Proc, repo_id: str, op: str) -> dict:
    if proc.ok:
        return {
            "repo": repo_id,
            "op": op,
            "ok": True,
            "conflict": False,
            "output": (proc.stdout or "").strip()[:1200],
        }
    conflicts = _conflict_files(resolve(repo_id))
    return {
        "repo": repo_id,
        "op": op,
        "ok": False,
        "conflict": bool(conflicts),
        "conflicts": conflicts,
        "output": ((proc.stderr or "") + (proc.stdout or "")).strip()[:1600],
    }


def sequencer_continue(repo_id: str, op: str) -> dict:
    repo = resolve(repo_id)
    sub = "cherry-pick" if op == "cherry-pick" else "revert"
    proc = ga.run(repo, [sub, "--continue"], env_extra={"GIT_EDITOR": "true"})
    return _seq_result(proc, repo_id, sub)


def sequencer_abort(repo_id: str, op: str) -> dict:
    repo = resolve(repo_id)
    sub = "cherry-pick" if op == "cherry-pick" else "revert"
    proc = ga.run(repo, [sub, "--abort"])
    if not proc.ok:
        raise ga.GitError((proc.stderr or f"no {sub} to abort").strip()[:400], code="no_sequencer")
    return {"aborted": op}


# ── reset / checkout-history ─────────────────────────────────────────────────

RESET_MODES = ("soft", "mixed", "hard")


def reset(repo_id: str, ref: str, mode: str = "mixed") -> dict:
    repo = resolve(repo_id)
    if mode not in RESET_MODES:
        raise ValueError(f"mode must be one of {RESET_MODES}")
    ga.ok(repo, ["reset", f"--{mode}", _rev(ref)])
    return {"reset": _rev(ref), "mode": mode}


# ── tags ─────────────────────────────────────────────────────────────────────


def list_tags(repo_id: str) -> dict:
    repo = resolve(repo_id)
    out = ga.ok(
        repo,
        [
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(objectname:short)%1f%(refname:short)%1f%(objecttype)%1f%(contents:subject)%1f%(creatordate:unix)%1f%(*objectname:short)",
            "refs/tags",
        ],
        timeout=ga.READ_TIMEOUT,
    )
    tags = []
    for line in out.strip().split("\n"):
        if not line.strip():
            continue
        sha, name, otype, subject, ts, deref = (line.split("\x1f") + [""] * 6)[:6]
        tags.append(
            {
                "name": name,
                "sha": sha,
                "target": deref or sha,
                "annotated": otype == "tag",
                "subject": subject[:100],
                "timestamp": int(ts) if ts.isdigit() else 0,
            }
        )
    return {"repo": repo_id, "tags": tags}


def create_tag(repo_id: str, name: str, ref: str = "HEAD", message: str = "") -> dict:
    repo = resolve(repo_id)
    if not name or not re.fullmatch(r"[^\s~^:]+", name):
        raise ga.GitError(f"invalid tag name: {name!r}", code="bad_name")
    args = ["tag"]
    if message:
        args += ["-a", name, "-m", message, _rev(ref)]
    else:
        args += [name, _rev(ref)]
    proc = ga.run(repo, args)
    if not proc.ok:
        raise ga.GitError(
            (proc.stderr or "tag failed").strip()[:500],
            code="tag_exists" if "exists" in (proc.stderr or "") else "git_error",
        )
    return {"tag": name, "annotated": bool(message)}


def delete_tag(repo_id: str, name: str) -> dict:
    repo = resolve(repo_id)
    ga.ok(repo, ["tag", "-d", name])
    return {"deleted": name}


# ── remotes ──────────────────────────────────────────────────────────────────


def list_remotes(repo_id: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["remote", "-v"], timeout=ga.READ_TIMEOUT)
    remotes: dict[str, dict] = {}
    if proc.ok:
        for line in proc.stdout.strip().split("\n"):
            if not line.strip():
                continue
            bits = line.split("\t")
            if len(bits) < 2:
                continue
            name, rest = bits[0], bits[1]
            url, _, kind = rest.rpartition(" (")
            kind = kind.rstrip(")")
            entry = remotes.setdefault(name, {"name": name, "fetchUrl": "", "pushUrl": ""})
            if kind == "fetch":
                entry["fetchUrl"] = url
            elif kind == "push":
                entry["pushUrl"] = url
    default = ga.run(repo, ["config", "--get", "checkout.defaultRemote"], timeout=ga.READ_TIMEOUT)
    return {
        "repo": repo_id,
        "remotes": list(remotes.values()),
        "defaultRemote": (default.stdout.strip() if default.ok else "") or "origin",
    }


def add_remote(repo_id: str, name: str, url: str) -> dict:
    repo = resolve(repo_id)
    if not name or not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise ga.GitError(f"invalid remote name: {name!r}", code="bad_name")
    if not url or " " in url:
        raise ValueError("url is required")
    proc = ga.run(repo, ["remote", "add", name, url])
    if not proc.ok:
        raise ga.GitError((proc.stderr or "remote add failed").strip()[:500])
    return {"added": name}


def remove_remote(repo_id: str, name: str) -> dict:
    repo = resolve(repo_id)
    ga.ok(repo, ["remote", "remove", name])
    return {"removed": name}


def set_remote_url(repo_id: str, name: str, url: str, push: bool = False) -> dict:
    repo = resolve(repo_id)
    args = ["remote", "set-url"] + (["--push"] if push else []) + [name, url]
    ga.ok(repo, args)
    return {"remote": name, "url": url, "push": push}


def prune_remote(repo_id: str, name: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["remote", "prune", name], timeout=ga.DEFAULT_TIMEOUT)
    if not proc.ok:
        raise ga.GitError((proc.stderr or "prune failed").strip()[:500])
    return {"pruned": name, "output": proc.stdout.strip()[:1000]}


# ── worktrees / submodules ───────────────────────────────────────────────────


def worktree_list(repo_id: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["worktree", "list", "--porcelain"], timeout=ga.READ_TIMEOUT)
    trees: list[dict] = []
    cur: dict | None = None
    if proc.ok:
        for line in proc.stdout.strip().split("\n"):
            if not line:
                continue
            if line.startswith("worktree "):
                cur = {
                    "path": line[len("worktree ") :],
                    "head": "",
                    "branch": "",
                    "bare": False,
                    "detached": False,
                }
                trees.append(cur)
            elif cur is None:
                continue
            elif line.startswith("HEAD "):
                cur["head"] = line[5:][:8]
            elif line.startswith("branch "):
                cur["branch"] = line[len("branch ") :].replace("refs/heads/", "")
            elif line == "bare":
                cur["bare"] = True
            elif line == "detached":
                cur["detached"] = True
    return {"repo": repo_id, "worktrees": trees}


def worktree_add(repo_id: str, path: str, branch: str | None = None, ref: str = "HEAD") -> dict:
    repo = resolve(repo_id)
    if not path or not path.startswith("/"):
        raise ValueError("absolute worktree path is required")
    args = ["worktree", "add"]
    if branch:
        args += ["-b", _branch(branch)]
    args += [path, _rev(ref)]
    proc = ga.run(repo, args)
    if not proc.ok:
        raise ga.GitError((proc.stderr or "worktree add failed").strip()[:600])
    return {"added": path}


def worktree_remove(repo_id: str, path: str, force: bool = False) -> dict:
    repo = resolve(repo_id)
    args = ["worktree", "remove"] + (["--force"] if force else []) + [path]
    proc = ga.run(repo, args)
    if not proc.ok:
        raise ga.GitError(
            (proc.stderr or "worktree remove failed").strip()[:600], code="dirty_worktree"
        )
    return {"removed": path}


def submodule_status(repo_id: str) -> dict:
    repo = resolve(repo_id)
    proc = ga.run(repo, ["submodule", "status"], timeout=ga.DEFAULT_TIMEOUT)
    subs = []
    if proc.ok:
        for line in proc.stdout.strip().split("\n"):
            if not line.strip():
                continue
            state = line[0] if line[0] in " -+U" else " "
            rest = line[1:].split(" ")
            sha = rest[0] if rest else ""
            path = rest[1] if len(rest) > 1 else ""
            desc = " ".join(rest[2:]) if len(rest) > 2 else ""
            subs.append(
                {
                    "path": path,
                    "sha": sha[:8],
                    "state": {
                        " ": "inited",
                        "-": "uninitialized",
                        "+": "different HEAD",
                        "U": "merge conflicts",
                    }[state],
                    "describe": desc.strip("()"),
                }
            )
    return {"repo": repo_id, "submodules": subs}


# ── search ───────────────────────────────────────────────────────────────────


def search_commits(
    repo_id: str,
    query: str,
    mode: str = "all",
    limit: int = 100,
    branch: str = "HEAD",
    path: str | None = None,
) -> dict:
    repo = resolve(repo_id)
    if not query.strip():
        raise ValueError("query is required")
    mode = mode if mode in ("message", "author", "hash", "all", "path") else "all"
    fmt = "%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%P%x1e"
    args = ["log", f"--format={fmt}", f"-n{max(1, min(limit, 500))}"]
    if mode in ("message", "all"):
        args += [f"--grep={query}", "-i"]
    if mode in ("author", "all"):
        args.append(f"--author={query}")
    if branch:
        args.append(_rev(branch))
    args.append("--")
    if path:
        args.append(path)
    out = ga.run(repo, args, timeout=ga.DEFAULT_TIMEOUT)
    if not out.ok and mode == "hash":
        # hash search with a non-revision string: nothing to find
        return {
            "repo": repo_id,
            "query": query,
            "mode": mode,
            "commits": [],
            "note": "no such revision",
        }
    if not out.ok:
        raise ga.GitError((out.stderr or "search failed").strip()[:500])
    commits = []
    for rec in out.stdout.split("\x1e"):
        rec = rec.strip("\n")
        if not rec.strip():
            continue
        parts = rec.split("\x1f")
        if len(parts) < 6:
            continue
        sha, short, author, ts, subject, parents = parts[:6]
        commits.append(
            {
                "sha": sha,
                "short": short,
                "author": author,
                "timestamp": int(ts) if ts.isdigit() else 0,
                "subject": subject,
                "parents": parents.split() if parents else [],
            }
        )
    return {"repo": repo_id, "query": query, "mode": mode, "commits": commits}


# ── working-tree snapshot for the graph page ─────────────────────────────────


def staged_files_summary(repo_id: str) -> dict:
    d = diff_worktree(repo_id, staged=True, stat_only=True)
    return {"staged": d["stat"]}
