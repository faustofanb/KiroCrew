"""HTTP routes for Praxis Insight, served in-process by the gateway.

Mounted at ``/api/apps/praxis-insight/`` using the single-argument
``register_routes(app)`` convention every builtin follows.

Surface:
``GET  /state``                      full domain snapshot (works/approvals/
                                    runs/evidence/unknowns + vocabularies)
``POST /approvals/{id}/decide``      body {"decision": "accepted"|"rejected"}
``POST /works/{id}/advance``         advance one Work along the legal lifecycle

Guards: enabled check (a disabled app answers 403 ``app_disabled``), then
dashboard-owner check — the approval inbox is a governance surface, and a
governance surface an app token can drive is not governance.
"""
from __future__ import annotations

import logging
from functools import wraps

from aiohttp import web

from kiro_crew.apps.manager import is_app_enabled
from kiro_crew.dashboard.handlers.source_providers import (
    is_owner_dashboard_request,
)

from .simulator import PraxisSimulator

logger = logging.getLogger(__name__)

APP_NAME = "praxis-insight"
_BASE = "/api/apps/praxis-insight"

#: One simulator per gateway process. The real daemon replaces this with a
#: client; until then the deterministic state is the point — the UI's behavior
#: is reproducible across reloads.
_SIM = PraxisSimulator()


def _json(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def _guarded(handler):
    @wraps(handler)
    async def _wrapped(request: web.Request) -> web.StreamResponse:
        if not await _enabled():
            return _json({"error": "praxis-insight is disabled", "code": "app_disabled"}, 403)
        if not is_owner_dashboard_request(request):
            logger.warning("refused praxis-insight access: owner surface (path=%s)", request.path)
            return _json({"error": "dashboard owner required", "code": "forbidden"}, 403)
        return await handler(request)

    return _wrapped


async def _enabled() -> bool:
    import asyncio

    return await asyncio.to_thread(is_app_enabled, APP_NAME)


@_guarded
async def _handle_state(request: web.Request) -> web.Response:
    return _json(_SIM.snapshot())


@_guarded
async def _handle_decide(request: web.Request) -> web.Response:
    approval_id = request.match_info["approval_id"]
    body = await request.json() if request.can_read_body else {}
    decision = body.get("decision")
    try:
        result = _SIM.decide_approval(approval_id, decision)
    except ValueError:
        return _json({"error": "decision must be 'accepted' or 'rejected'", "code": "bad_request"}, 400)
    except KeyError:
        return _json({"error": f"no approval {approval_id}", "code": "not_found"}, 404)
    except PermissionError as exc:
        return _json({"error": str(exc), "code": "already_decided"}, 409)
    return _json(result)


@_guarded
async def _handle_resolve_divergence(request: web.Request) -> web.Response:
    changeset_id = request.match_info["changeset_id"]
    body = await request.json() if request.can_read_body else {}
    decision = body.get("decision")
    try:
        result = _SIM.resolve_divergence(changeset_id, decision)
    except ValueError:
        return _json({"error": "decision must be 'rebase' | 'accept' | 'reject'", "code": "bad_request"}, 400)
    except KeyError:
        return _json({"error": f"no changeset {changeset_id}", "code": "not_found"}, 404)
    except PermissionError as exc:
        return _json({"error": str(exc), "code": "not_diverged"}, 409)
    return _json(result)


@_guarded
async def _handle_sync_fork(request: web.Request) -> web.Response:
    changeset_id = request.match_info["changeset_id"]
    try:
        result = _SIM.sync_fork(changeset_id)
    except KeyError:
        return _json({"error": f"no changeset {changeset_id}", "code": "not_found"}, 404)
    except PermissionError as exc:
        return _json({"error": str(exc), "code": "closed"}, 409)
    return _json(result)


@_guarded
async def _handle_promote(request: web.Request) -> web.Response:
    delivery_id = request.match_info["delivery_id"]
    body = await request.json() if request.can_read_body else {}
    action = body.get("action")
    try:
        result = _SIM.promote_delivery(delivery_id, action)
    except ValueError:
        return _json({"error": "action must be 'TEST' | 'PROD' | 'CLOSE'", "code": "bad_request"}, 400)
    except KeyError:
        return _json({"error": f"no delivery {delivery_id}", "code": "not_found"}, 404)
    except PermissionError as exc:
        return _json({"error": str(exc), "code": "gate_refused"}, 409)
    return _json(result)


@_guarded
async def _handle_advance(request: web.Request) -> web.Response:
    work_id = request.match_info["work_id"]
    try:
        result = _SIM.advance_work(work_id)
    except KeyError:
        return _json({"error": f"no work {work_id}", "code": "not_found"}, 404)
    except PermissionError as exc:
        return _json({"error": str(exc), "code": "terminal_state"}, 409)
    return _json(result)


def register_routes(app: web.Application) -> None:
    """Register on the gateway's aiohttp Application (single-arg convention)."""
    r = app.router
    r.add_get(f"{_BASE}/state", _handle_state)
    r.add_post(f"{_BASE}/approvals/{{approval_id}}/decide", _handle_decide)
    r.add_post(f"{_BASE}/works/{{work_id}}/advance", _handle_advance)
    r.add_post(f"{_BASE}/changesets/{{changeset_id}}/resolve-divergence", _handle_resolve_divergence)
    r.add_post(f"{_BASE}/changesets/{{changeset_id}}/sync-fork", _handle_sync_fork)
    r.add_post(f"{_BASE}/deliveries/{{delivery_id}}/promote", _handle_promote)
