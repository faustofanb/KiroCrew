"""Remote operations — streaming exec, SFTP-over-ssh, bounded history.

Everything rides the system ssh binary against the stored connection (key
auth, accept-new host keys). Exec streams over an op registry like Git
Studio's network ops; downloads/uploads stream through ``ssh cat`` / stdin
so nothing large lands in memory.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import time
import uuid
from pathlib import Path

from . import store

EXEC_TIMEOUT = 30
OUTPUT_CAP = 256 * 1024
HISTORY_CAP = 200


def _history_path() -> Path:
    from kiro_crew.config.paths import config_dir

    d = config_dir() / "praxis-ssh"
    d.mkdir(parents=True, exist_ok=True)
    return d / "history.jsonl"


def history() -> dict:
    p = _history_path()
    if not p.exists():
        return {"history": []}
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        return {"history": [json.loads(l) for l in lines[-HISTORY_CAP:] if l.strip()]}
    except Exception:
        return {"history": []}


def _append_history(entry: dict) -> None:
    p = _history_path()
    try:
        lines = []
        if p.exists():
            lines = p.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        lines.append(json.dumps(entry, ensure_ascii=False))
        with p.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        # ring: rewrite when over cap
        if len(lines) > HISTORY_CAP * 2:
            keep = lines[-HISTORY_CAP:]
            p.write_text("\n".join(keep) + "\n", encoding="utf-8")
    except OSError:
        pass


# ── exec (streamed) ──────────────────────────────────────────────────────────


class ExecOp:
    def __init__(self, op_id: str, conn_id: str, command: str) -> None:
        self.id = op_id
        self.conn_id = conn_id
        self.command = command
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=2000)
        self.done = False
        self.exit_code: int | None = None
        self.error = ""
        self.process: asyncio.subprocess.Process | None = None
        self.cancelled = False
        self.started_at = time.time()


_OPS: dict[str, ExecOp] = {}


async def start_exec(conn_id: str, command: str) -> dict:
    if not command.strip():
        raise ValueError("command is required")
    c = store.get_connection(conn_id)
    op = ExecOp(uuid.uuid4().hex[:12], conn_id, command.strip())
    _OPS[op.id] = op
    _reap()
    op.queue.put_nowait({"type": "start", "command": op.command})
    asyncio.get_running_loop().create_task(_run_exec(op, c))
    return {"opId": op.id}


async def _run_exec(op: ExecOp, c: dict) -> None:
    base = store._ssh_base_args(c)
    argv = [*base, store._target(c), "--", op.command]
    total = 0
    try:
        op.process = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "TERM": "dumb"},
        )
        timed_out = False

        async def _drain(stream, stream_name: str) -> None:
            nonlocal total
            assert stream is not None
            while True:
                chunk = await stream.readline()
                if not chunk:
                    return
                text = chunk.decode("utf-8", errors="replace").rstrip("\n")
                if not text:
                    continue
                if total < OUTPUT_CAP:
                    op.queue.put_nowait(
                        {"type": "line", "stream": stream_name, "text": text[:2000]}
                    )
                    total += len(text)
                elif total == OUTPUT_CAP:
                    op.queue.put_nowait(
                        {"type": "line", "stream": "stderr", "text": "… output truncated …"}
                    )
                    total += 1

        try:
            await asyncio.wait_for(
                asyncio.gather(
                    _drain(op.process.stdout, "stdout"), _drain(op.process.stderr, "stderr")
                ),
                timeout=EXEC_TIMEOUT,
            )
            code = await op.process.wait()
        except asyncio.TimeoutError:
            timed_out = True
            op.process.kill()
            code = await op.process.wait()
            op.queue.put_nowait({"type": "timeout", "seconds": EXEC_TIMEOUT})
        op.exit_code = code if not timed_out else -1
    except FileNotFoundError as exc:
        op.error = str(exc)
        op.exit_code = -1
    except Exception as exc:  # spawn failures etc.
        op.error = str(exc)
        op.exit_code = -1
    finally:
        op.done = True
        err_clean = (op.error or "")[:300]
        op.queue.put_nowait({"type": "done", "exitCode": op.exit_code, "error": err_clean})
        _append_history(
            {
                "at": int(op.started_at),
                "connectionId": op.conn_id,
                "command": op.command[:500],
                "exitCode": op.exit_code,
                "timedOut": op.exit_code == -1 and not err_clean,
            }
        )


def get_op(op_id: str) -> ExecOp:
    op = _OPS.get(op_id)
    if op is None:
        raise KeyError(op_id)
    return op


def _reap() -> None:
    now = time.time()
    for k in [k for k, o in _OPS.items() if o.done and now - o.started_at > 300]:
        _OPS.pop(k, None)


async def stream_op(op: ExecOp, writer) -> None:
    """SSE frames until the op is done and drained (see git-studio network)."""
    while True:
        if op.done and op.queue.empty():
            await writer.write(b"data: " + json.dumps({"type": "closed"}).encode() + b"\n\n")
            return
        try:
            event = await asyncio.wait_for(op.queue.get(), timeout=15.0)
        except asyncio.TimeoutError:
            await writer.write(b": keepalive\n\n")
            continue
        await writer.write(b"data: " + json.dumps(event).encode() + b"\n\n")


# ── SFTP over ssh ────────────────────────────────────────────────────────────

_SAFE_PATH_RE = None  # paths are validated per-op below


def _check_path(path: str) -> str:
    if not path or "\x00" in path or path.startswith("-"):
        raise ValueError("invalid remote path")
    return path


async def _ssh(c: dict, remote_argv: str, input_bytes: bytes | None = None) -> tuple[int, str, str]:
    base = store._ssh_base_args(c)
    argv = [*base, store._target(c), "--", remote_argv]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE if input_bytes is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(input_bytes)
    return (
        proc.returncode,
        out.decode("utf-8", errors="replace"),
        err.decode("utf-8", errors="replace"),
    )


async def list_dir(conn_id: str, path: str) -> dict:
    c = store.get_connection(conn_id)
    path = _check_path(path or ".")
    code, out, err = await _ssh(c, f"ls -la --time-style=long-iso {shlex.quote(path)}")
    if code != 0:
        raise RuntimeError((err or out or "ls failed").strip()[:400])
    entries = []
    for line in out.splitlines()[1:]:  # skip total
        parts = line.split(maxsplit=7)
        if len(parts) < 8:
            continue
        mode, links, owner, group, size, date, name = (
            parts[0],
            parts[1],
            parts[2],
            parts[3],
            parts[4],
            f"{parts[5]} {parts[6]}",
            parts[7],
        )
        if name in (".", ".."):
            continue
        entries.append(
            {
                "name": name,
                "dir": mode.startswith("d"),
                "symlink": mode.startswith("l"),
                "size": size,
                "mtime": date,
                "owner": owner,
            }
        )
    return {"path": path, "entries": entries}


async def mkdir(conn_id: str, path: str) -> dict:
    c = store.get_connection(conn_id)
    code, out, err = await _ssh(c, f"mkdir -p {shlex.quote(_check_path(path))}")
    if code != 0:
        raise RuntimeError((err or "mkdir failed").strip()[:300])
    return {"created": path}


async def remove(conn_id: str, path: str, recursive: bool) -> dict:
    c = store.get_connection(conn_id)
    flag = "-rf" if recursive else "-f"
    code, out, err = await _ssh(c, f"rm {flag} {shlex.quote(_check_path(path))}")
    if code != 0:
        raise RuntimeError((err or "rm failed").strip()[:300])
    return {"removed": path}


async def rename(conn_id: str, src: str, dst: str) -> dict:
    c = store.get_connection(conn_id)
    code, out, err = await _ssh(
        c, f"mv {shlex.quote(_check_path(src))} {shlex.quote(_check_path(dst))}"
    )
    if code != 0:
        raise RuntimeError((err or "mv failed").strip()[:300])
    return {"renamed": {"from": src, "to": dst}}


async def download_stream(conn_id: str, path: str, writer):
    """Stream a remote file to the HTTP response via `ssh cat`."""
    c = store.get_connection(conn_id)
    base = store._ssh_base_args(c)
    argv = [*base, store._target(c), "--", f"cat {shlex.quote(_check_path(path))}"]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    assert proc.stdout is not None
    while True:
        chunk = await proc.stdout.read(64 * 1024)
        if not chunk:
            break
        await writer.write(chunk)
    await proc.wait()
    if proc.returncode != 0:
        err = (
            (await proc.stderr.read()).decode("utf-8", errors="replace")[:200]
            if proc.stderr
            else ""
        )
        raise RuntimeError(err or "remote cat failed")


async def upload_stream(conn_id: str, remote_path: str, reader) -> dict:
    """Stream the request body into a remote file via ssh `cat > path`."""
    c = store.get_connection(conn_id)
    base = store._ssh_base_args(c)
    quoted = shlex.quote(_check_path(remote_path))
    argv = [*base, store._target(c), "--", f"cat > {quoted}"]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdin is not None
    total = 0
    try:
        while True:
            chunk = await reader.read(64 * 1024)
            if not chunk:
                break
            proc.stdin.write(chunk)
            await proc.stdin.drain()
            total += len(chunk)
            if total > 512 * 1024 * 1024:
                proc.kill()
                raise ValueError("upload exceeds 512MB cap")
        proc.stdin.close()
    except (BrokenPipeError, ConnectionResetError):
        pass
    await proc.wait()
    if proc.returncode != 0:
        err = (
            (await proc.stderr.read()).decode("utf-8", errors="replace")[:200]
            if proc.stderr
            else ""
        )
        raise RuntimeError(err or "remote write failed")
    return {"path": remote_path, "bytes": total}
