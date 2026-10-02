"""Structured diffs — hunks with real line numbers, word-level segments,
whitespace options, and line-level staging patch reconstruction.

The unified-diff parser keeps per-line old/new numbers so the UI can offer
Fork-style line checkboxes; staging a selection rebuilds a smaller hunk
(all context kept, unselected +/- lines dropped, counts recomputed) and
applies it with ``git apply --cached`` (or ``--reverse`` to unstage).
"""

from __future__ import annotations

import re

from . import git_adapter as ga
from .repos import resolve

PATCH_CAP = 400_000  # per-file patch text cap
CONTENT_CAP = 1_000_000

_WS_FLAGS = {
    "none": [],
    "space": ["-w"],
    "eol": ["--ignore-space-at-eol"],
    "all": ["--ignore-all-space"],
}

_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$")
_BINARY_MARKS = ("Binary files ", "\\ No newline at end of file")


def _ws_args(ignore_ws: str) -> list[str]:
    return _WS_FLAGS.get(ignore_ws or "none", [])


def parse_patch(raw: str, word_mode: bool = False) -> dict:
    """Parse a unified diff into files → hunks → numbered lines.

    ``word_mode`` parses ``--word-diff=porcelain`` output: within a hunk,
    segment lines are prefixed ``+``/``-``/space and ``~`` closes one display
    line; a display line keeps old/new numbering by which segment kinds it
    contains (del advances old, add advances new, pure-eq advances both).
    """
    files: list[dict] = []
    cur_file: dict | None = None
    cur_hunk: dict | None = None
    old_no = new_no = 0
    segs: list[dict] = []
    has_del = has_add = False

    for line in raw.split("\n"):
        if line == "":
            # trailing-newline artifact; a real empty context line is " "
            continue
        if line.startswith("diff --git "):
            cur_file = {
                "header": [line],
                "oldPath": None,
                "newPath": None,
                "status": "modified",
                "hunks": [],
                "binary": False,
            }
            files.append(cur_file)
            cur_hunk = None
        elif cur_file is None:
            continue
        elif line.startswith("--- "):
            cur_file["header"].append(line)
            cur_file["oldPath"] = _clean_path(line[4:])
        elif line.startswith("+++ "):
            cur_file["header"].append(line)
            cur_file["newPath"] = _clean_path(line[4:])
        elif line.startswith("new file mode"):
            cur_file["header"].append(line)
            cur_file["status"] = "added"
        elif line.startswith("deleted file mode"):
            cur_file["header"].append(line)
            cur_file["status"] = "deleted"
        elif line.startswith("rename from "):
            cur_file["header"].append(line)
            cur_file["status"] = "renamed"
            cur_file["oldPath"] = line[len("rename from ") :]
        elif line.startswith("rename to "):
            cur_file["header"].append(line)
            cur_file["newPath"] = line[len("rename to ") :]
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            cur_file["header"].append(line)
            cur_file["binary"] = True
        elif (m := _HUNK_RE.match(line)) is not None:
            old_no = int(m.group(1))
            new_no = int(m.group(3))
            cur_hunk = {
                "header": line,
                "note": m.group(5) or "",
                "oldStart": old_no,
                "oldCount": int(m.group(2)) if m.group(2) else 1,
                "newStart": new_no,
                "newCount": int(m.group(4)) if m.group(4) else 1,
                "lines": [],
            }
            cur_file["hunks"].append(cur_hunk)
            segs, has_del, has_add = [], False, False
        elif cur_hunk is None:
            continue
        elif word_mode:
            if line == "~":
                # porcelain: `~` closes the current display line; advance the
                # counters by the segment kinds it accumulated
                if cur_hunk is not None and segs:
                    t = (
                        "mod"
                        if (has_del and has_add)
                        else "del" if has_del else "add" if has_add else "ctx"
                    )
                    old_ref = old_no if t in ("del", "mod", "ctx") else None
                    new_ref = new_no if t in ("add", "mod", "ctx") else None
                    cur_hunk["lines"].append(
                        {
                            "t": t,
                            "old": old_ref,
                            "new": new_ref,
                            "text": "".join(s["v"] for s in segs),
                            "segs": segs,
                        }
                    )
                    if t in ("del", "mod", "ctx"):
                        old_no += 1
                    if t in ("add", "mod", "ctx"):
                        new_no += 1
                segs, has_del, has_add = [], False, False
            elif line.startswith("\\"):
                pass  # newline notes are irrelevant to word display
            else:
                kind = line[0] if line else " "
                text = line[1:] if line else ""
                if kind == "+":
                    segs.append({"t": "add", "v": text})
                    has_add = True
                elif kind == "-":
                    segs.append({"t": "del", "v": text})
                    has_del = True
                else:
                    segs.append({"t": "eq", "v": text if line.startswith(" ") else line})
        else:
            if line.startswith("+"):
                cur_hunk["lines"].append({"t": "add", "old": None, "new": new_no, "text": line[1:]})
                new_no += 1
            elif line.startswith("-"):
                cur_hunk["lines"].append({"t": "del", "old": old_no, "new": None, "text": line[1:]})
                old_no += 1
            elif line.startswith("\\"):
                cur_hunk["lines"].append({"t": "note", "old": None, "new": None, "text": line})
            else:
                cur_hunk["lines"].append(
                    {"t": "ctx", "old": old_no, "new": new_no, "text": line[1:]}
                )
                old_no += 1
                new_no += 1
    return {"files": files}


def _clean_path(p: str) -> str:
    if p == "/dev/null":
        return p
    return re.sub(r"^a/", "", p, count=1) if p.startswith("a/") else re.sub(r"^b/", "", p, count=1)


def _stat_line(line: str) -> dict | None:
    parts = line.split("\t")
    if len(parts) < 3:
        return None
    adds, dels, path = parts[0], parts[1], parts[2]
    if adds == "-":
        return {"path": path, "adds": None, "dels": None, "binary": True}
    return {
        "path": path,
        "adds": int(adds) if adds.isdigit() else 0,
        "dels": int(dels) if dels.isdigit() else 0,
        "binary": False,
    }


def diff_worktree(
    repo_id: str,
    path: str | None = None,
    staged: bool = False,
    context: int = 3,
    ignore_ws: str = "none",
    word_diff: bool = False,
    stat_only: bool = False,
) -> dict:
    """Working-tree diff (unstaged by default, ``--cached`` when staged)."""
    repo = resolve(repo_id)
    args = [
        "diff",
        f"-U{max(0, min(context, 20))}",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
    ]
    args += _ws_args(ignore_ws)
    if word_diff:
        args.append("--word-diff=porcelain")
    if staged:
        args.append("--cached")
    if stat_only:
        args.append("--numstat")
    args.append("--")
    if path:
        args.append(path)
    raw = ga.ok(repo, args, timeout=ga.READ_TIMEOUT)[:PATCH_CAP]
    if stat_only:
        stats = [s for s in (_stat_line(l) for l in raw.strip().split("\n")) if s]
        return {"repo": repo_id, "staged": staged, "stat": stats}
    parsed = parse_patch(raw, word_mode=word_diff)
    return {
        "repo": repo_id,
        "path": path,
        "staged": staged,
        "ignoreWs": ignore_ws,
        "wordDiff": word_diff,
        "files": parsed["files"],
    }


def diff_revision(
    repo_id: str,
    rev: str,
    path: str | None = None,
    context: int = 3,
    ignore_ws: str = "none",
    word_diff: bool = False,
) -> dict:
    """Diff of one commit (``git show``) or a range (``a..b`` / ``a...b``)."""
    repo = resolve(repo_id)
    if not re.fullmatch(r"[A-Za-z0-9_@./^~:(),-]+", rev or ""):
        raise ga.GitError(f"invalid revision: {rev!r}", code="bad_revision")
    args = [
        "show",
        f"-U{max(0, min(context, 20))}",
        "--no-color",
        "--no-ext-diff",
        "--format=",
        "--find-renames",
    ]
    args += _ws_args(ignore_ws)
    if word_diff:
        args.append("--word-diff=porcelain")
    args.append(rev)
    args.append("--")
    if path:
        args.append(path)
    raw = ga.ok(repo, args, timeout=ga.READ_TIMEOUT)[:PATCH_CAP]
    parsed = parse_patch(raw, word_mode=word_diff)
    return {
        "repo": repo_id,
        "rev": rev,
        "ignoreWs": ignore_ws,
        "wordDiff": word_diff,
        "files": parsed["files"],
    }


# ── line-level staging ───────────────────────────────────────────────────────


def _line_key(t: str, old, new) -> str:
    return f"{t}:{old}:{new}"


def build_partial_patch(diff_files: list[dict], path: str, selections: list[dict]) -> str:
    """Rebuild a patch containing only the selected +/- lines of ``path``.

    ``selections``: ``[{hunk: <index>, keys: ["add:None:12", …]}]``. All
    context lines are kept, unselected changes are dropped, and hunk headers
    are recomputed. Hunks with no selected changes are omitted.
    """
    target = next(
        (f for f in diff_files if f.get("newPath") == path or f.get("oldPath") == path), None
    )
    if target is None:
        raise ga.GitError(f"{path} not present in diff", code="no_diff")
    sel_by_hunk: dict[int, set[str]] = {s["hunk"]: set(s.get("keys", [])) for s in selections}
    out: list[str] = [target["header"][0]]
    # file mode / rename metadata lines (everything before the first @@)
    for h in target["header"][1:]:
        out.append(h)
    produced = 0
    for hi, hunk in enumerate(target["hunks"]):
        keys = sel_by_hunk.get(hi)
        if not keys:
            continue
        kept: list[dict] = []
        for ln in hunk["lines"]:
            k = _line_key(ln["t"], ln["old"], ln["new"])
            if ln["t"] in ("add", "del") and k in keys:
                kept.append(ln)
            elif ln["t"] in ("ctx", "note"):
                kept.append(ln)
        changes = sum(1 for ln in kept if ln["t"] in ("add", "del"))
        if changes == 0:
            continue
        old_count = sum(1 for ln in kept if ln["t"] in ("del", "ctx"))
        new_count = sum(1 for ln in kept if ln["t"] in ("add", "ctx"))
        note = f" {hunk['note']}" if hunk.get("note") else ""
        out.append(f"@@ -{hunk['oldStart']},{old_count} +{hunk['newStart']},{new_count} @@{note}")
        for ln in kept:
            sign = {"add": "+", "del": "-", "ctx": " ", "note": "\\"}[ln["t"]]
            out.append(sign + ln["text"])
        produced += 1
    if produced == 0:
        raise ga.GitError("selection is empty — nothing to stage", code="empty_selection")
    return "\n".join(out) + "\n"


def apply_partial(
    repo_id: str,
    path: str,
    selections: list[dict],
    *,
    staged: bool,
    reverse: bool,
    cached: bool,
) -> dict:
    """Apply a line-selection patch. Staging = ``--cached``; unstage = reverse.

    ``staged=True`` means: operate against the staged diff (the selection
    came from the staged view, so reverse-unstage it from the index).
    """
    repo = resolve(repo_id)
    d = diff_worktree(repo_id, path=path, staged=staged)
    patch = build_partial_patch(d["files"], path, selections)
    args = ["apply", "--unidiff-zero", "--whitespace=nowarn"]
    if cached:
        args.append("--cached")
    if reverse:
        args.append("--reverse")
    proc = ga.run(repo, args, input_text=patch, timeout=ga.DEFAULT_TIMEOUT)
    if not proc.ok:
        raise ga.GitError((proc.stderr or "apply failed").strip()[:800], code="apply_failed")
    return {"repo": repo_id, "path": path, "applied": True, "reverse": reverse, "cached": cached}


# ── blame / history / content ────────────────────────────────────────────────


def blame(repo_id: str, path: str, ref: str = "HEAD") -> dict:
    """Porcelain blame with move/copy detection (-C -M) and rename following."""
    repo = resolve(repo_id)
    if not path or ".." in path or path.startswith("/"):
        raise ValueError("path is required")
    args = ["blame", "--porcelain", "-C", "-M"]
    if ref and ref != "HEAD":
        if not re.fullmatch(r"[A-Za-z0-9_@./^~:-]+", ref):
            raise ga.GitError(f"invalid revision: {ref!r}", code="bad_revision")
        args.append(ref)
    args += ["--", path]
    raw = ga.ok(repo, args, timeout=ga.DEFAULT_TIMEOUT)[:CONTENT_CAP]
    lines: list[dict] = []
    cur: dict = {}
    for line in raw.split("\n"):
        m = re.match(r"^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$", line)
        if m:
            if cur:
                lines.append(cur)
            cur = {
                "sha": m.group(1)[:8],
                "origLine": int(m.group(2)),
                "line": int(m.group(3)),
                "boundary": False,
            }
        elif line.startswith("author "):
            cur["author"] = line[7:]
        elif line.startswith("author-mail "):
            cur["email"] = line[12:].strip("<>")
        elif line.startswith("author-time "):
            cur["timestamp"] = int(line[12:]) if line[12:].isdigit() else 0
        elif line.startswith("summary "):
            cur["summary"] = line[8:][:120]
        elif line.startswith("filename "):
            cur["origPath"] = line[9:]
        elif line.startswith("boundary"):
            cur["boundary"] = True
        elif line.startswith("\t"):
            cur["text"] = line[1:]
    if cur:
        lines.append(cur)
    return {"repo": repo_id, "path": path, "ref": ref, "lines": lines}


def file_history(repo_id: str, path: str, limit: int = 200, follow: bool = True) -> dict:
    repo = resolve(repo_id)
    if not path or ".." in path or path.startswith("/"):
        raise ValueError("path is required")
    # Separator BEFORE the fields: each record then starts with its header
    # line, and the commit's own name-status lines follow inside the record.
    fmt = "%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%P"
    args = ["log", f"--format={fmt}", f"-n{max(1, min(limit, 1000))}", "--name-status", "-M", "--"]
    if follow:
        args.insert(1, "--follow")
    args.append(path)
    raw = ga.ok(repo, args, timeout=ga.DEFAULT_TIMEOUT)[:CONTENT_CAP]
    commits: list[dict] = []
    for rec in raw.split("\x1e"):
        rec = rec.strip("\n")
        if not rec.strip():
            continue
        lines_ = rec.split("\n")
        head = lines_[0].split("\x1f")
        if len(head) < 6:
            continue
        sha, short, author, ts, subject, parents = head[:6]
        changes: list[dict] = []
        for cl in lines_[1:]:
            if not cl.strip():
                continue
            bits = cl.split("\t")
            if len(bits) >= 2:
                entry = {"status": bits[0], "path": bits[-1]}
                if len(bits) == 3:
                    entry["oldPath"] = bits[1]
                changes.append(entry)
        commits.append(
            {
                "sha": sha,
                "short": short,
                "author": author,
                "timestamp": int(ts) if ts.isdigit() else 0,
                "subject": subject,
                "parents": parents.split() if parents else [],
                "changes": changes,
            }
        )
    return {"repo": repo_id, "path": path, "follow": follow, "commits": commits}


def file_content(repo_id: str, ref: str, path: str) -> dict:
    """Bounded content of one blob (null when binary/too large)."""
    repo = resolve(repo_id)
    if not path or ".." in path or path.startswith("/"):
        raise ValueError("path is required")
    if not re.fullmatch(r"[A-Za-z0-9_@./^~:{}-]+", ref or ""):
        raise ga.GitError(f"invalid revision: {ref!r}", code="bad_revision")
    # size guard before pulling the blob
    size_out = ga.run(repo, ["cat-file", "-s", f"{ref}:{path}"], timeout=ga.READ_TIMEOUT)
    if size_out.ok:
        try:
            if int(size_out.stdout.strip()) > CONTENT_CAP:
                return {
                    "repo": repo_id,
                    "path": path,
                    "ref": ref,
                    "tooLarge": True,
                    "content": None,
                    "binary": False,
                }
        except ValueError:
            pass
    raw = ga.run(repo, ["show", f"{ref}:{path}"], timeout=ga.READ_TIMEOUT)
    if not raw.ok:
        raise ga.GitError((raw.stderr or "not found").strip()[:400], code="not_found")
    blob = raw.stdout[:CONTENT_CAP]
    binary = "\x00" in blob[:8000]
    return {
        "repo": repo_id,
        "path": path,
        "ref": ref,
        "content": None if binary else blob,
        "binary": binary,
        "tooLarge": False,
    }
