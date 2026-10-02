"""HTTP routes for DBX — lifecycle + gateway reverse proxy at /dbx-app.

The proxy is the integration seam: the iframe loads ``/dbx-app/`` and every
asset, API call, SSE stream and Set-Cookie the dbx-web server emits already
carries the ``/dbx-app`` prefix (``DBX_PUBLIC_BASE_PATH``), so requests stay
on the gateway's origin — no naked-port exposure, no cross-origin cookie
trouble. Hop-by-hop headers are stripped on both legs.
"""

from __future__ import annotations

import asyncio
import json
import logging
from functools import wraps

import aiohttp
from aiohttp import web

from kiro_crew.apps.manager import is_app_enabled
from kiro_crew.dashboard.handlers.source_providers import is_owner_dashboard_request

from . import bridge, process

logger = logging.getLogger(__name__)

APP_NAME = "praxis-dbx"
_BASE = "/api/apps/praxis-dbx"
PROXY_PREFIX = "/dbx-app"

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
}


def _json(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def _guarded(handler):
    @wraps(handler)
    async def _wrapped(request: web.Request) -> web.StreamResponse:
        if not await _enabled():
            return _json({"error": "DBX is disabled", "code": "app_disabled"}, 403)
        if not is_owner_dashboard_request(request):
            logger.warning("refused praxis-dbx access: owner surface (path=%s)", request.path)
            return _json({"error": "dashboard owner required", "code": "forbidden"}, 403)
        return await handler(request)

    return _wrapped


async def _enabled() -> bool:
    return await asyncio.to_thread(is_app_enabled, APP_NAME)


async def _body(request: web.Request) -> dict:
    if request.can_read_body:
        try:
            data = await request.json()
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


# ── lifecycle ────────────────────────────────────────────────────────────────


@_guarded
async def _status(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(process.status))


@_guarded
async def _ensure(request: web.Request) -> web.Response:
    """Attach-or-launch — the page's first-load call."""
    try:
        return _json(await asyncio.to_thread(process.ensure_running))
    except Exception as exc:  # noqa: BLE001
        logs = (await asyncio.to_thread(process.logs))["logs"][-4000:]
        return _json({"error": str(exc), "code": "start_failed", "logs": logs}, 500)


@_guarded
async def _start(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(await asyncio.to_thread(process.start, body.get("autoRestart")))
    except FileNotFoundError as exc:
        return _json({"error": str(exc), "code": "no_binary"}, 404)
    except Exception as exc:  # noqa: BLE001
        return _json({"error": str(exc), "code": "start_failed"}, 409)


@_guarded
async def _stop(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(process.stop))


@_guarded
async def _restart(request: web.Request) -> web.Response:
    try:
        return _json(await asyncio.to_thread(process.restart))
    except Exception as exc:  # noqa: BLE001
        return _json({"error": str(exc), "code": "restart_failed"}, 409)


@_guarded
async def _logs(request: web.Request) -> web.Response:
    tail = int(request.query.get("tail", str(32 * 1024)))
    return _json(await asyncio.to_thread(process.logs, tail))


@_guarded
async def _auto_restart(request: web.Request) -> web.Response:
    body = await _body(request)
    return _json(await asyncio.to_thread(process.set_auto_restart, bool(body.get("enabled", True))))


# ── connection bridge (read-only) + AI prompt ───────────────────────────────


@_guarded
async def _connections(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(bridge.connections))


@_guarded
async def _ai(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(
            await asyncio.to_thread(
                bridge.ai_prompt, body.get("connection", ""), body.get("question", "")
            )
        )
    except ValueError as exc:
        return _json({"error": str(exc), "code": "bad_request"}, 400)


# ── reverse proxy ────────────────────────────────────────────────────────────


@_guarded
async def _proxy(request: web.Request) -> web.StreamResponse:
    """Stream one request to the local dbx-web under the same path prefix."""
    target = f"{process.DBX_BASE_URL}{request.rel_url.path}"
    if request.rel_url.query_string:
        target += f"?{request.rel_url.query_string}"
    upstream_body = await request.read() if request.body_exists else None
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    timeout = aiohttp.ClientTimeout(total=None, sock_read=900, connect=5)
    try:
        async with aiohttp.ClientSession(timeout=timeout, auto_decompress=False) as session:
            async with session.request(
                request.method,
                target,
                headers=headers,
                data=upstream_body,
                allow_redirects=False,
            ) as upstream:
                out_headers = [
                    (k, v) for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP
                ]
                resp = web.StreamResponse(status=upstream.status, headers=out_headers)
                await resp.prepare(request)
                async for chunk in upstream.content.iter_any():
                    await resp.write(chunk)
                await resp.write_eof()
                return resp
    except aiohttp.ClientConnectionError:
        return _json({"error": "dbx-web is not running", "code": "backend_down"}, 502)
    except asyncio.TimeoutError:
        return _json({"error": "dbx-web upstream timeout", "code": "upstream_timeout"}, 504)


def register_routes(app: web.Application) -> None:
    r = app.router
    r.add_get(f"{_BASE}/status", _status)
    r.add_post(f"{_BASE}/ensure", _ensure)
    r.add_post(f"{_BASE}/start", _start)
    r.add_post(f"{_BASE}/stop", _stop)
    r.add_post(f"{_BASE}/restart", _restart)
    r.add_get(f"{_BASE}/logs", _logs)
    r.add_post(f"{_BASE}/auto-restart", _auto_restart)
    r.add_get(f"{_BASE}/connections", _connections)
    r.add_post(f"{_BASE}/ai", _ai)
    # reverse proxy: every /dbx-app/* request lands on the local server as-is
    r.add_route("*", f"{PROXY_PREFIX}/{{tail:.*}}", _proxy)
    r.add_route("*", PROXY_PREFIX, _proxy)
