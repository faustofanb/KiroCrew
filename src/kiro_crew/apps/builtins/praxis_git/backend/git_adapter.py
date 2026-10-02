"""Typed git subprocess adapter — the one place Git Studio touches git.

Every operation is a real git invocation against a repository on disk; there
are no mocks. Results are structured, failures raise ``GitError`` with a
stable machine code so routes can map to HTTP without sniffing stderr text.

Headless rules baked into the runner:

* ``GIT_EDITOR=true`` / ``GIT_SEQUENCE_EDITOR=true`` — continue-type commands
  never stall on an editor;
* ``GIT_TERMINAL_PROMPT=0`` — network commands fail fast instead of hanging
  on a credential prompt nobody can answer;
* ``-c core.quotepath=false`` — non-ASCII paths arrive readable, not escaped;
* output is never paged (subprocess pipes are not a tty anyway, but the
  explicit env keeps aliases from interfering).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

#: Read-only commands (status/log/branches…) get a tight budget; mutating
#: commands get the roomier default. Graph builds on huge repos get their own.
READ_TIMEOUT = 20
DEFAULT_TIMEOUT = 60


class GitError(RuntimeError):
    """A git invocation that exited non-zero, with a stable route-mappable code."""

    def __init__(self, message: str, code: str = "git_error", hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.hint = hint


def _base_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "GIT_EDITOR": "true",
            "GIT_SEQUENCE_EDITOR": "true",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_PAGER": "cat",
            "PAGER": "cat",
            "GIT_CONFIG_PARAMETERS": "'core.quotepath=false'",
        }
    )
    if extra:
        env.update(extra)
    return env


class Proc:
    """Structured git result — never raises on non-zero, callers decide."""

    __slots__ = ("returncode", "stdout", "stderr")

    def __init__(self, returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def output(self) -> str:
        """stdout when ok, else the most useful stream (for error messages)."""
        return self.stdout if self.ok else (self.stderr or self.stdout)


def run(
    repo: str | Path,
    args: list[str],
    *,
    timeout: int = DEFAULT_TIMEOUT,
    input_text: str | None = None,
    env_extra: dict[str, str] | None = None,
) -> Proc:
    """Run git in ``repo`` and capture both streams. ``args`` exclude the git binary."""
    cmd = ["git", "-C", str(repo), *args]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_text,
            env=_base_env(env_extra),
        )
    except subprocess.TimeoutExpired as exc:
        raise GitError(
            f"git {' '.join(args[:3])}… timed out after {timeout}s",
            code="timeout",
        ) from exc
    except FileNotFoundError as exc:
        raise GitError("git binary not found on PATH", code="no_git") from exc
    return Proc(proc.returncode, proc.stdout, proc.stderr)


def ok(repo: str | Path, args: list[str], **kw) -> str:
    """Run git and return stdout, raising ``GitError`` on failure."""
    proc = run(repo, args, **kw)
    if not proc.ok:
        raise GitError((proc.stderr or proc.stdout or "git failed").strip()[:2000])
    return proc.stdout


def classify_error(exc: Exception) -> tuple[str, str]:
    """(http_code, machine_code) for a raised exception."""
    if isinstance(exc, GitError):
        return {"timeout": "504", "no_git": "500"}.get(exc.code, "409"), exc.code
    if isinstance(exc, ValueError):
        return "400", "bad_request"
    if isinstance(exc, KeyError):
        return "404", "not_found"
    if isinstance(exc, FileNotFoundError):
        return "404", "not_found"
    return "500", "error"


# ── Repository identity ──────────────────────────────────────────────────────


def is_git_repo(path: Path) -> bool:
    """A worktree qualifies via its ``.git`` file; a normal repo via the dir."""
    git = path / ".git"
    return git.is_file() or git.is_dir()


def toplevel_of(path: str) -> Path | None:
    """Resolve a subdirectory to its repo toplevel (None when outside a repo)."""
    proc = run(Path(path).expanduser(), ["rev-parse", "--show-toplevel"], timeout=READ_TIMEOUT)
    if not proc.ok:
        return None
    top = proc.stdout.strip()
    return Path(top) if top else None


# ── In-progress operation detection (merge / rebase / cherry-pick / revert) ──

_OP_STATE_FILES = [
    ("rebase-merge", "rebase"),
    ("rebase-apply", "rebase"),
    ("MERGE_HEAD", "merge"),
    ("CHERRY_PICK_HEAD", "cherry-pick"),
    ("REVERT_HEAD", "revert"),
    ("BISECT_LOG", "bisect"),
]


def in_progress_op(repo: Path) -> str | None:
    """Which long-running git operation owns this checkout right now, if any."""
    try:
        proc = run(repo, ["rev-parse", "--git-dir"], timeout=READ_TIMEOUT)
        if not proc.ok:
            return None
        gitdir = Path(proc.stdout.strip())
        if not gitdir.is_absolute():
            gitdir = repo / gitdir
    except GitError:
        return None
    for name, op in _OP_STATE_FILES:
        if (gitdir / name).exists():
            return op
    return None


# ── status --porcelain=v2 --branch parsing ───────────────────────────────────
#
# v2 is the machine-readable contract. Branch header lines start with ``#``
# (branch.head / branch.upstream / branch.ab); change lines are:
#   ``1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>``        ordinary
#   ``2 <XY> <sub> … <path><sep><origPath>``                 rename/copy
#   ``u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`` unmerged
#   ``? <path>``                                             untracked

_UNCODE = {
    "DD": "both deleted",
    "AU": "added by us",
    "UD": "deleted by them",
    "UA": "added by them",
    "DU": "deleted by us",
    "AA": "both added",
    "UU": "both modified",
}


def parse_status(out: str) -> dict:
    """Parse porcelain v2 output into the working-directory state object."""
    head = {"branch": "", "upstream": "", "ahead": None, "behind": None, "detached": False}
    files: list[dict] = []
    for line in out.split("\n"):
        if not line:
            continue
        if line.startswith("# branch.head "):
            name = line[len("# branch.head ") :]
            if name == "(detached)":
                head["detached"] = True
                head["branch"] = ""
            else:
                head["branch"] = name
        elif line.startswith("# branch.upstream "):
            head["upstream"] = line[len("# branch.upstream ") :]
        elif line.startswith("# branch.ab "):
            parts = line[len("# branch.ab ") :].split()
            for p in parts:
                if p.startswith("+"):
                    head["ahead"] = int(p[1:])
                elif p.startswith("-"):
                    head["behind"] = int(p[1:])
        elif line[0] == "?":
            files.append(
                {
                    "path": line[2:],
                    "oldPath": None,
                    "staged": False,
                    "unstaged": True,
                    "untracked": True,
                    "conflict": False,
                    "status": "??",
                    "label": "untracked",
                }
            )
        elif line[0] == "u":
            fields = line.split(" ", 10)
            if len(fields) < 11:
                continue
            code = fields[1]
            files.append(
                {
                    "path": fields[10],
                    "oldPath": None,
                    "staged": False,
                    "unstaged": True,
                    "untracked": False,
                    "conflict": True,
                    "status": code,
                    "label": _UNCODE.get(code, "conflict"),
                }
            )
        elif line[0] in ("1", "2"):
            # v2 change lines: "1 XY sub mH mI mW hH hI path" (9 fields);
            # "2 XY sub mH mI mW hH hI Xscore path\x00orig" (10 fields)
            need = 9 if line[0] == "1" else 10
            fields = line.split(" ", need)
            if len(fields) < need:
                continue
            xy = fields[1]
            path = fields[need - 1]
            old_path = None
            if line[0] == "2" and "\x00" in path:
                path, old_path = path.split("\x00", 1)
            # v2 marks "no change" with '.', not ' ' (v1's convention)
            x, y = xy[0], xy[1]
            files.append(
                {
                    "path": path,
                    "oldPath": old_path,
                    "staged": x not in (" ", ".", "?"),
                    "unstaged": y not in (" ", "."),
                    "untracked": False,
                    "conflict": False,
                    "status": xy,
                    "label": _v1_label(x, y),
                }
            )
    staged = sum(1 for f in files if f["staged"])
    unstaged = sum(1 for f in files if f["unstaged"] and not f["untracked"])
    untracked = sum(1 for f in files if f["untracked"])
    conflicts = sum(1 for f in files if f["conflict"])
    return {
        "branch": head["branch"],
        "detached": head["detached"],
        "upstream": head["upstream"],
        "ahead": head["ahead"],
        "behind": head["behind"],
        "files": files,
        "counts": {
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked,
            "conflicts": conflicts,
        },
    }


def _v1_label(x: str, y: str) -> str:
    pairs = {
        "M ": "staged modified",
        " M": "modified",
        "MM": "modified (staged + worktree)",
        "A ": "staged new file",
        "AM": "new file (staged, worktree modified)",
        "D ": "staged deleted",
        " D": "deleted",
        "R ": "staged renamed",
        "RM": "renamed (staged, worktree modified)",
        "C ": "staged copied",
        "U*": "conflict",
        "??": "untracked",
    }
    return pairs.get(x + y, (x + y).strip() or "modified")
