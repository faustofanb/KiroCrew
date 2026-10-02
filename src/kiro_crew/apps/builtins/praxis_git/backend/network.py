"""Network operations — fetch / pull / push as streaming subprocesses.

git writes transfer progress to stderr with carriage-return updates. These
ops run under asyncio subprocesses (never blocking the event loop), parse
the progress lines, and publish them on an asyncio.Queue the SSE endpoint
drains. Output is bounded (MAX_EVENTS) and finished ops are reaped after a
short retention so a reconnecting client can still read the tail.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid

from . import git_adapter as ga
from .repos import resolve

OP_TTL = 300
MAX_EVENTS = 3000
MAX_CONCURRENT = 3

_PROGRESS_RE = re.compile(
    r"(?P<phase>Enumerating|Counting|Compressing|Writing|Receiving|Resolving|Updating|remote:|Unpacking|Delta indexing)objects?"
    r"[^%]*?(?P<pct>\d+)% \((?P<cur>\d+)/(?P<total>\d+)\)"
)
_CREDENTIAL_RE = re.compile(r"(password|token|pass@)[^\s]*", re.I)


class NetworkOp:
    def __init__(self, op_id: str, repo: str, kind: str, argv: list[str]) -> None:
        self.id = op_id
        self.repo = repo
        self.kind = kind
        self.argv = argv
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=MAX_EVENTS)
        self.done = False
        self.exit_code: int | None = None
        self.error = ""
        self.started_at = time.time()
        self.finished_at: float | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.cancelled = False

    def push(self, event: dict) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            pass  # bounded: drop rather than block the loop


_OPS: dict[str, NetworkOp] = {}
_OPS_LOCK = asyncio.Lock()


def _sanitize(text: str) -> str:
    return _CREDENTIAL_RE.sub(r"\1<redacted>", text)


def _argv(kind: str, repo_id: str, body: dict) -> list[str]:
    """Build the git argv for a network op from validated fields."""
    remote = body.get("remote") or "origin"
    if not re.fullmatch(r"[A-Za-z0-9._-]+", remote):
        raise ga.GitError(f"invalid remote name: {remote!r}", code="bad_name")
    if kind == "fetch":
        args = ["fetch", "--progress", remote]
        if body.get("prune"):
            args.append("--prune")
        if body.get("all"):
            args.append("--all")
        elif body.get("branch"):
            args.append(body["branch"])
        if body.get("tags"):
            args.append("--tags")
        return args
    if kind == "pull":
        args = ["pull", "--progress"]
        if body.get("rebase"):
            args.append("--rebase")
        if body.get("ffOnly"):
            args.append("--ff-only")
        args.append(remote)
        if body.get("branch"):
            args.append(body["branch"])
        return args
    if kind == "push":
        args = ["push", "--progress"]
        force = bool(body.get("force"))
        if body.get("forceWithLease", not force):
            args.append("--force-with-lease")
        if force:
            args.append("--force")
        if body.get("setUpstream"):
            args.append("--set-upstream")
        args.append(remote)
        for ref in body.get("refs", []):
            if not re.fullmatch(r"[A-Za-z0-9_@./^~:+-]+", str(ref)):
                raise ga.GitError(f"invalid refspec: {ref!r}", code="bad_refspec")
            args.append(str(ref))
        return args
    raise ValueError(f"unknown network op {kind}")


async def _run_op(op: NetworkOp, cwd: str) -> None:
    env = os.environ.copy()
    env.update(
        {
            "GIT_EDITOR": "true",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_PAGER": "cat",
            "PAGER": "cat",
            "GIT_CONFIG_PARAMETERS": "'core.quotepath=false'",
            "LC_ALL": "C",
        }
    )
    try:
        op.process = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            cwd,
            *op.argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except Exception as exc:  # spawn failure
        op.error = str(exc)
        op.done = True
        op.exit_code = -1
        op.finished_at = time.time()
        op.push({"type": "error", "text": str(exc)})
        op.push({"type": "done", "exitCode": -1})
        return

    async def _drain(stream, is_stderr: bool) -> None:
        assert stream is not None
        while True:
            chunk = await stream.readline()
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace").rstrip("\r\n")
            if not text.strip():
                continue
            clean = _sanitize(text)
            m = _PROGRESS_RE.search(clean)
            if m:
                op.push(
                    {
                        "type": "progress",
                        "phase": m.group("phase").strip(),
                        "pct": int(m.group("pct")),
                        "current": int(m.group("cur")),
                        "total": int(m.group("total")),
                    }
                )
            elif is_stderr or clean.startswith(
                ("From ", "To ", "* ", "Already up to date", "Fast-forward", "Merge made by")
            ):
                op.push(
                    {
                        "type": "line",
                        "stream": "stderr" if is_stderr else "stdout",
                        "text": clean[:500],
                    }
                )

    await asyncio.gather(_drain(op.process.stdout, False), _drain(op.process.stderr, True))
    code = await op.process.wait()
    op.exit_code = code
    op.done = True
    op.finished_at = time.time()
    op.push({"type": "done", "exitCode": code})


async def start_op(repo_id: str, kind: str, body: dict) -> dict:
    argv = _argv(kind, repo_id, body)
    repo_path = resolve(repo_id)
    op_id = uuid.uuid4().hex[:12]
    op = NetworkOp(op_id, repo_id, kind, argv)
    running = [o for o in _OPS.values() if not o.done]
    if len(running) >= MAX_CONCURRENT:
        raise ga.GitError("too many concurrent network operations", code="busy")
    _OPS[op_id] = op
    op.push({"type": "start", "kind": kind, "argv": ["git", *argv]})
    asyncio.get_running_loop().create_task(_run_op(op, str(repo_path)))
    _reap()
    return {"opId": op_id, "kind": kind, "argv": ["git", *argv]}


def get_op(op_id: str) -> NetworkOp:
    op = _OPS.get(op_id)
    if op is None:
        raise KeyError(op_id)
    return op


async def cancel_op(op_id: str) -> dict:
    op = get_op(op_id)
    if op.process is not None and op.exit_code is None:
        op.cancelled = True
        try:
            op.process.terminate()
        except ProcessLookupError:
            pass
    return {"cancelling": op_id}


def _reap() -> None:
    now = time.time()
    for k in [
        k for k, o in _OPS.items() if o.done and o.finished_at and now - o.finished_at > OP_TTL
    ]:
        _OPS.pop(k, None)


async def stream_events(op: NetworkOp, writer) -> None:
    """Drain an op's queue onto an aiohttp SSE response until done+drained.

    ``writer`` is a prepared ``StreamResponse`` — its ``write`` is itself a
    coroutine, so every frame is awaited, not just the drain.
    """
    import json

    while True:
        if op.done and op.queue.empty():
            await writer.write(b"data: " + json.dumps({"type": "closed"}).encode() + b"\n\n")
            return
        try:
            event = await asyncio.wait_for(op.queue.get(), timeout=15.0)
        except asyncio.TimeoutError:
            await writer.write(b": keepalive\n\n")  # comment frame holds the connection
            continue
        await writer.write(b"data: " + json.dumps(event).encode() + b"\n\n")
