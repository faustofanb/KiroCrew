"""SSH routes — connections, keys, streaming exec (SSE), SFTP, PTY websocket.

Owner-gated like the other Praxis surfaces. The PTY bridge allocates a local
pty, runs ``ssh -tt`` against the stored connection, and relays bytes both
ways between that pty and the browser's xterm; resize messages set the
kernel window size on the pty (ssh propagates it to the remote).
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import struct
import termios
from functools import wraps

import aiohttp
from aiohttp import web, WSMsgType

from kiro_crew.apps.manager import is_app_enabled
from kiro_crew.dashboard.handlers.source_providers import is_owner_dashboard_request

from . import keys, remote, store

logger = logging.getLogger(__name__)

APP_NAME = "praxis-ssh"
_BASE = "/api/apps/praxis-ssh"


def _json(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def _guarded(handler):
    @wraps(handler)
    async def _wrapped(request: web.Request) -> web.StreamResponse:
        if not await _enabled():
            return _json({"error": "SSH is disabled", "code": "app_disabled"}, 403)
        if not is_owner_dashboard_request(request):
            logger.warning("refused praxis-ssh access: owner surface (path=%s)", request.path)
            return _json({"error": "dashboard owner required", "code": "forbidden"}, 403)
        return await handler(request)

    return _wrapped


async def _enabled() -> bool:
    return await asyncio.to_thread(is_app_enabled, APP_NAME)


def _err(exc: Exception) -> web.Response:
    if isinstance(exc, KeyError):
        return _json({"error": "no such connection/op", "code": "not_found"}, 404)
    if isinstance(exc, (ValueError,)):
        return _json({"error": str(exc), "code": "bad_request"}, 400)
    return _json({"error": str(exc), "code": "error"}, 500)


async def _body(request: web.Request) -> dict:
    if request.can_read_body:
        try:
            data = await request.json()
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


# ── connections ──────────────────────────────────────────────────────────────


@_guarded
async def _conn_list(request: web.Request) -> web.Response:
    return _json(store.list_connections())


@_guarded
async def _conn_create(request: web.Request) -> web.Response:
    try:
        return _json(await asyncio.to_thread(store.create_connection, await _body(request)))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _conn_update(request: web.Request) -> web.Response:
    try:
        return _json(
            await asyncio.to_thread(
                store.update_connection, request.match_info["conn_id"], await _body(request)
            )
        )
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _conn_delete(request: web.Request) -> web.Response:
    try:
        return _json(
            await asyncio.to_thread(store.delete_connection, request.match_info["conn_id"])
        )
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _conn_test(request: web.Request) -> web.Response:
    try:
        return _json(await asyncio.to_thread(store.test_connection, request.match_info["conn_id"]))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


# ── keys / agent / known_hosts ───────────────────────────────────────────────


@_guarded
async def _keys(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(keys.list_keys))


@_guarded
async def _agent(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(keys.agent_status))


@_guarded
async def _known_hosts(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(keys.known_hosts))


# ── exec ─────────────────────────────────────────────────────────────────────


@_guarded
async def _exec_start(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(await remote.start_exec(body.get("connectionId", ""), body.get("command", "")))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _exec_stream(request: web.Request) -> web.Response:
    try:
        op = remote.get_op(request.match_info["op_id"])
    except KeyError:
        return _json({"error": "no such operation", "code": "not_found"}, 404)
    resp = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )
    await resp.prepare(request)
    await remote.stream_op(op, resp)
    return resp


@_guarded
async def _history(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(remote.history))


# ── sftp ─────────────────────────────────────────────────────────────────────


@_guarded
async def _sftp_list(request: web.Request) -> web.Response:
    try:
        return _json(
            await remote.list_dir(
                request.query.get("connectionId", ""), request.query.get("path", ".")
            )
        )
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _sftp_mkdir(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(await remote.mkdir(body.get("connectionId", ""), body.get("path", "")))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _sftp_remove(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(
            await remote.remove(
                body.get("connectionId", ""), body.get("path", ""), bool(body.get("recursive"))
            )
        )
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _sftp_rename(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(
            await remote.rename(
                body.get("connectionId", ""), body.get("from", ""), body.get("to", "")
            )
        )
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


@_guarded
async def _sftp_download(request: web.Request) -> web.Response:
    """Stream a remote file back; the browser's download progress is the progress."""
    q = request.query
    try:
        store.get_connection(q.get("connectionId", ""))
    except KeyError:
        return _json({"error": "no such connection", "code": "not_found"}, 404)
    name = os.path.basename(q.get("path") or "file")
    resp = web.StreamResponse(
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Disposition": f'attachment; filename="{name}"',
        }
    )
    await resp.prepare(request)
    try:
        await remote.download_stream(q.get("connectionId", ""), q.get("path", ""), resp)
    except Exception as exc:  # noqa: BLE001
        logger.warning("sftp download failed: %s", type(exc).__name__)
    await resp.write_eof()
    return resp


@_guarded
async def _sftp_upload(request: web.Request) -> web.Response:
    """Raw-body upload streamed into `cat > path` on the remote."""
    q = request.query
    try:
        out = await remote.upload_stream(
            q.get("connectionId", ""), q.get("path", ""), request.content
        )
        return _json(out)
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


# ── interactive terminal (websocket PTY) ─────────────────────────────────────


@_guarded
async def _terminal_ws(request: web.Request) -> web.Response:
    conn_id = request.match_info["conn_id"]
    try:
        c = store.get_connection(conn_id)
    except KeyError:
        return _json({"error": "no such connection", "code": "not_found"}, 404)

    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=1 << 20)
    await ws.prepare(request)

    master_fd, slave_fd = os.openpty()
    argv = [
        *store._ssh_base_args(c),
        "-tt",
        store._target(c),
    ]
    env = {**os.environ, "TERM": "xterm-256color"}
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        start_new_session=True,
    )
    os.close(slave_fd)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    os.set_blocking(master_fd, False)

    loop = asyncio.get_running_loop()
    closed = asyncio.Event()

    def _on_pty_readable() -> None:
        try:
            data = os.read(master_fd, 65536)
        except (BlockingIOError, OSError):
            return
        if not data:
            closed.set()
            return
        asyncio.ensure_future(ws.send_bytes(data))

    loop.add_reader(master_fd, _on_pty_readable)

    async def _watch_proc() -> None:
        await proc.wait()
        closed.set()

    watcher = asyncio.ensure_future(_watch_proc())

    try:
        while not closed.is_set():
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=1000)
            except asyncio.TimeoutError:
                continue
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                if isinstance(data, dict) and "resize" in data:
                    cols = max(2, min(int(data["resize"][0]), 500))
                    rows = max(2, min(int(data["resize"][1]), 300))
                    fcntl.ioctl(
                        master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0)
                    )
            elif msg.type == WSMsgType.BINARY:
                try:
                    os.write(master_fd, msg.data)
                except OSError:
                    closed.set()
            elif msg.type in (
                WSMsgType.CLOSE,
                WSMsgType.CLOSING,
                WSMsgType.CLOSED,
                WSMsgType.ERROR,
            ):
                closed.set()
    finally:
        loop.remove_reader(master_fd)
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass
        watcher.cancel()
        with contextlib.suppress(Exception):
            await ws.close()
    return ws


def register_routes(app: web.Application) -> None:
    r = app.router
    C = f"{_BASE}/connections"
    r.add_get(C, _conn_list)
    r.add_post(C, _conn_create)
    r.add_put(f"{C}/{{conn_id}}", _conn_update)
    r.add_delete(f"{C}/{{conn_id}}", _conn_delete)
    r.add_post(f"{C}/{{conn_id}}/test", _conn_test)
    r.add_get(f"{_BASE}/keys", _keys)
    r.add_get(f"{_BASE}/agent", _agent)
    r.add_get(f"{_BASE}/known-hosts", _known_hosts)
    r.add_post(f"{_BASE}/exec", _exec_start)
    r.add_get(f"{_BASE}/exec/{{op_id}}/stream", _exec_stream)
    r.add_get(f"{_BASE}/history", _history)
    r.add_get(f"{_BASE}/sftp/list", _sftp_list)
    r.add_post(f"{_BASE}/sftp/mkdir", _sftp_mkdir)
    r.add_post(f"{_BASE}/sftp/remove", _sftp_remove)
    r.add_post(f"{_BASE}/sftp/rename", _sftp_rename)
    r.add_get(f"{_BASE}/sftp/download", _sftp_download)
    r.add_post(f"{_BASE}/sftp/upload", _sftp_upload)
    r.add_get(f"{_BASE}/terminal/{{conn_id}}", _terminal_ws)
