"""HTTP routes for CI/CD Studio — owner-gated reads + lifecycle commands."""

from __future__ import annotations

import asyncio
import logging
from functools import wraps

from aiohttp import web

from kiro_crew.apps.manager import is_app_enabled
from kiro_crew.dashboard.handlers.source_providers import is_owner_dashboard_request

from . import views

logger = logging.getLogger(__name__)

APP_NAME = "praxis-cicd"
_BASE = "/api/apps/praxis-cicd"


def _json(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def _guarded(handler):
    @wraps(handler)
    async def _wrapped(request: web.Request) -> web.StreamResponse:
        if not await _enabled():
            return _json({"error": "CI/CD Studio is disabled", "code": "app_disabled"}, 403)
        if not is_owner_dashboard_request(request):
            logger.warning("refused praxis-cicd access: owner surface (path=%s)", request.path)
            return _json({"error": "dashboard owner required", "code": "forbidden"}, 403)
        return await handler(request)

    return _wrapped


async def _enabled() -> bool:
    return await asyncio.to_thread(is_app_enabled, APP_NAME)


async def _body(request: web.Request) -> dict:
    if request.can_read_body:
        try:
            import json

            data = await request.json()
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


@_guarded
async def _pipeline(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(views.pipeline))


@_guarded
async def _delivery_timeline(request: web.Request) -> web.Response:
    try:
        return _json(
            await asyncio.to_thread(views.delivery_timeline, request.match_info["delivery_id"])
        )
    except KeyError:
        return _json({"error": "no such delivery", "code": "not_found"}, 404)


@_guarded
async def _changeset(request: web.Request) -> web.Response:
    try:
        return _json(
            await asyncio.to_thread(views.changeset_view, request.match_info["changeset_id"])
        )
    except KeyError:
        return _json({"error": "no such changeset", "code": "not_found"}, 404)


@_guarded
async def _adapter(request: web.Request) -> web.Response:
    return _json(await asyncio.to_thread(views.adapter_view))


@_guarded
async def _advance(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(await asyncio.to_thread(views.advance_work, request.match_info["work_id"]))
    except KeyError:
        return _json({"error": "no such work", "code": "not_found"}, 404)
    except PermissionError as exc:
        return _json({"error": str(exc), "code": "terminal_state"}, 409)


@_guarded
async def _promote(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        return _json(
            await asyncio.to_thread(
                views.promote_delivery, request.match_info["delivery_id"], body.get("action", "")
            )
        )
    except KeyError:
        return _json({"error": "no such delivery", "code": "not_found"}, 404)
    except ValueError:
        return _json(
            {"error": "action must be 'TEST' | 'PROD' | 'CLOSE'", "code": "bad_request"}, 400
        )
    except PermissionError as exc:
        return _json({"error": str(exc), "code": "gate_refused"}, 409)


def register_routes(app: web.Application) -> None:
    r = app.router
    r.add_get(f"{_BASE}/pipeline", _pipeline)
    r.add_get(f"{_BASE}/deliveries/{{delivery_id}}/timeline", _delivery_timeline)
    r.add_get(f"{_BASE}/changesets/{{changeset_id}}", _changeset)
    r.add_get(f"{_BASE}/adapter", _adapter)
    r.add_post(f"{_BASE}/works/{{work_id}}/advance", _advance)
    r.add_post(f"{_BASE}/deliveries/{{delivery_id}}/promote", _promote)
