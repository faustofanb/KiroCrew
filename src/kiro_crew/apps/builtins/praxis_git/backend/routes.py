"""HTTP routes for Git Studio — mounted at ``/api/apps/praxis-git``.

Same guard posture as Praxis Insight: the app must be enabled and the
request must be an owner-dashboard request. Git Studio mutates real
repositories; a surface an app token can drive is not a Git client. Every
sync handler wraps its git work in ``asyncio.to_thread`` — the event loop
never touches a blocking subprocess call here.

Network ops (fetch/pull/push) are asyncio subprocesses streamed over SSE.
"""

from __future__ import annotations

import asyncio
import json
import logging
from functools import wraps

from aiohttp import web

from kiro_crew.apps.manager import is_app_enabled
from kiro_crew.dashboard.handlers.source_providers import is_owner_dashboard_request

from . import diffing, git_adapter as ga, graph, network, operations, repos

logger = logging.getLogger(__name__)

APP_NAME = "praxis-git"
_BASE = "/api/apps/praxis-git"


def _json(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def _guarded(handler):
    @wraps(handler)
    async def _wrapped(request: web.Request) -> web.StreamResponse:
        if not await _enabled():
            return _json({"error": "Git Studio is disabled", "code": "app_disabled"}, 403)
        if not is_owner_dashboard_request(request):
            logger.warning("refused praxis-git access: owner surface (path=%s)", request.path)
            return _json({"error": "dashboard owner required", "code": "forbidden"}, 403)
        return await handler(request)

    return _wrapped


async def _enabled() -> bool:
    return await asyncio.to_thread(is_app_enabled, APP_NAME)


def _error_response(exc: Exception) -> web.Response:
    status, code = ga.classify_error(exc)
    body = {"error": str(exc), "code": code}
    hint = getattr(exc, "hint", "")
    if hint:
        body["hint"] = hint
    return _json(body, int(status))


async def _run_off_loop(fn, args, kw):
    try:
        return _json(await asyncio.to_thread(fn, *args, **kw))
    except Exception as exc:  # noqa: BLE001 — surfaced as structured JSON
        return _error_response(exc)


async def _body(request: web.Request) -> dict:
    if request.can_read_body:
        try:
            data = await request.json()
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


# ── repos ────────────────────────────────────────────────────────────────────


@_guarded
async def _repos_list(request: web.Request) -> web.Response:
    return await _run_off_loop(repos.list_repos, (), {})


@_guarded
async def _repos_add(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(repos.add_repo, (body.get("path", ""),), {})


@_guarded
async def _repos_remove(request: web.Request) -> web.Response:
    return await _run_off_loop(repos.remove_repo, (request.match_info["repo_id"],), {})


@_guarded
async def _repo_status(request: web.Request) -> web.Response:
    return await _run_off_loop(repos.repo_status, (request.match_info["repo_id"],), {})


# ── graph ────────────────────────────────────────────────────────────────────


@_guarded
async def _graph(request: web.Request) -> web.Response:
    q = request.query

    def run():
        return graph.graph_page(
            request.match_info["repo_id"],
            q.get("branch", "HEAD"),
            q.get("firstParent") == "1",
            q.get("session") or None,
            int(q.get("offset", "0")),
            int(q.get("limit", str(graph.DEFAULT_PAGE))),
            int(q.get("cap", str(graph.DEFAULT_CAP))),
            q.get("refresh") == "1",
        )

    return await _run_off_loop(run, (), {})


# ── diff ─────────────────────────────────────────────────────────────────────


@_guarded
async def _diff_worktree(request: web.Request) -> web.Response:
    q = request.query
    return await _run_off_loop(
        diffing.diff_worktree,
        (request.match_info["repo_id"],),
        {
            "path": q.get("path") or None,
            "staged": q.get("staged") == "1",
            "context": int(q.get("context", "3")),
            "ignore_ws": q.get("ignoreWs", "none"),
            "word_diff": q.get("wordDiff") == "1",
            "stat_only": q.get("stat") == "1",
        },
    )


@_guarded
async def _diff_revision(request: web.Request) -> web.Response:
    q = request.query
    return await _run_off_loop(
        diffing.diff_revision,
        (request.match_info["repo_id"], q.get("rev", "HEAD")),
        {
            "path": q.get("path") or None,
            "context": int(q.get("context", "3")),
            "ignore_ws": q.get("ignoreWs", "none"),
            "word_diff": q.get("wordDiff") == "1",
        },
    )


# ── staging / commit ─────────────────────────────────────────────────────────


@_guarded
async def _stage(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]
    op = body.get("op", "")

    def run():
        if op == "file":
            paths = [str(p) for p in body.get("paths", [])]
            if body.get("unstage"):
                return operations.unstage_paths(repo_id, paths)
            return operations.stage_paths(repo_id, paths)
        if op == "all":
            if body.get("unstage"):
                return operations.unstage_all(repo_id)
            return operations.stage_all(repo_id, not body.get("skipUntracked", False))
        if op == "lines":
            # staging: apply --cached on the unstaged diff;
            # unstaging: reverse-apply --cached on the staged diff
            staged = bool(body.get("staged"))
            reverse = bool(body.get("reverse", staged))
            return diffing.apply_partial(
                repo_id,
                body.get("path", ""),
                body.get("selections", []),
                staged=staged,
                reverse=reverse,
                cached=not reverse,
            )
        raise ValueError(f"unknown op {op!r}")

    return await _run_off_loop(run, (), {})


@_guarded
async def _discard(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(
        operations.discard_paths,
        (
            request.match_info["repo_id"],
            [str(p) for p in body.get("paths", [])],
            bool(body.get("stagedToo")),
        ),
        {},
    )


@_guarded
async def _commit(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(
        operations.commit,
        (request.match_info["repo_id"], body.get("message", "")),
        {"amend": bool(body.get("amend")), "signoff": bool(body.get("signoff"))},
    )


# ── branches / tags ──────────────────────────────────────────────────────────


@_guarded
async def _branches(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.list_branches, (request.match_info["repo_id"],), {})


@_guarded
async def _branch_op(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]
    op = body.get("op", "")

    def run():
        if op == "create":
            return operations.create_branch(
                repo_id,
                body.get("name", ""),
                body.get("ref", "HEAD"),
                bool(body.get("checkout", True)),
            )
        if op == "checkout":
            return operations.checkout(repo_id, body.get("ref", "HEAD"), body.get("create"))
        if op == "delete":
            return operations.delete_branch(repo_id, body.get("name", ""), bool(body.get("force")))
        if op == "rename":
            return operations.rename_branch(repo_id, body.get("old", ""), body.get("new", ""))
        if op == "upstream":
            return operations.set_upstream(
                repo_id, body.get("branch", ""), body.get("upstream", "")
            )
        raise ValueError(f"unknown op {op!r}")

    return await _run_off_loop(run, (), {})


@_guarded
async def _tags(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.list_tags, (request.match_info["repo_id"],), {})


@_guarded
async def _tag_op(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]

    def run():
        op = body.get("op", "")
        if op == "create":
            return operations.create_tag(
                repo_id, body.get("name", ""), body.get("ref", "HEAD"), body.get("message", "")
            )
        if op == "delete":
            return operations.delete_tag(repo_id, body.get("name", ""))
        raise ValueError(f"unknown op {op!r}")

    return await _run_off_loop(run, (), {})


# ── merge / conflicts ────────────────────────────────────────────────────────


@_guarded
async def _merge(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(
        operations.merge,
        (request.match_info["repo_id"], body.get("source", "")),
        {"no_ff": bool(body.get("noFF", True)), "message": body.get("message", "")},
    )


@_guarded
async def _merge_abort(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.merge_abort, (request.match_info["repo_id"],), {})


@_guarded
async def _merge_continue(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(
        operations.merge_continue,
        (request.match_info["repo_id"],),
        {"message": body.get("message", "")},
    )


@_guarded
async def _conflicts(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.conflict_state, (request.match_info["repo_id"],), {})


@_guarded
async def _conflict_file(request: web.Request) -> web.Response:
    return await _run_off_loop(
        operations.conflict_versions,
        (request.match_info["repo_id"], request.query.get("path", "")),
        {},
    )


@_guarded
async def _conflict_resolve(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]

    def run():
        if "side" in body:
            return operations.resolve_conflict_take(repo_id, body.get("path", ""), body["side"])
        return operations.resolve_conflict_file(
            repo_id, body.get("path", ""), body.get("content", "")
        )

    return await _run_off_loop(run, (), {})


# ── rebase ───────────────────────────────────────────────────────────────────


@_guarded
async def _rebase_status(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.rebase_status, (request.match_info["repo_id"],), {})


@_guarded
async def _rebase_op(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]
    op = body.get("op", "")

    def run():
        if op == "start":
            return operations.rebase_start(
                repo_id, body.get("upstream", ""), body.get("onto"), body.get("branch")
            )
        if op == "start-interactive":
            return operations.rebase_start_interactive(
                repo_id, body.get("upstream", ""), [str(l) for l in body.get("todo", [])]
            )
        if op == "continue":
            return operations.rebase_continue(repo_id)
        if op == "skip":
            return operations.rebase_skip(repo_id)
        if op == "abort":
            return operations.rebase_abort(repo_id)
        if op == "reword":
            return operations.rebase_reword_stopped(repo_id, body.get("message", ""))
        raise ValueError(f"unknown op {op!r}")

    return await _run_off_loop(run, (), {})


@_guarded
async def _rebase_todo_preview(request: web.Request) -> web.Response:
    return await _run_off_loop(
        operations.rebase_todo_preview,
        (request.match_info["repo_id"], request.query.get("upstream", "HEAD")),
        {},
    )


# ── stash ────────────────────────────────────────────────────────────────────


@_guarded
async def _stash(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.stash_list, (request.match_info["repo_id"],), {})


@_guarded
async def _stash_op(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]

    def run():
        op = body.get("op", "")
        idx = int(body.get("index", 0))
        if op == "push":
            return operations.stash_push(
                repo_id,
                body.get("message", ""),
                bool(body.get("includeUntracked")),
                bool(body.get("stagedOnly")),
            )
        if op == "apply":
            return operations.stash_apply(repo_id, idx, drop=False)
        if op == "pop":
            return operations.stash_apply(repo_id, idx, drop=True)
        if op == "drop":
            return operations.stash_drop(repo_id, idx)
        if op == "branch":
            return operations.stash_branch(repo_id, idx, body.get("name", ""))
        raise ValueError(f"unknown op {op!r}")

    return await _run_off_loop(run, (), {})


@_guarded
async def _stash_diff(request: web.Request) -> web.Response:
    return await _run_off_loop(
        operations.stash_diff, (request.match_info["repo_id"], int(request.match_info["index"])), {}
    )


# ── cherry-pick / revert / reset ─────────────────────────────────────────────


@_guarded
async def _cherry_pick(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(
        operations.cherry_pick,
        (request.match_info["repo_id"], [str(s) for s in body.get("shas", [])]),
        {"no_commit": bool(body.get("noCommit"))},
    )


@_guarded
async def _revert(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(
        operations.revert,
        (request.match_info["repo_id"], [str(s) for s in body.get("shas", [])]),
        {"no_commit": bool(body.get("noCommit"))},
    )


@_guarded
async def _sequencer(request: web.Request) -> web.Response:
    body = await _body(request)
    op = body.get("op", "")
    kind = body.get("kind", "cherry-pick")
    fn = operations.sequencer_continue if op == "continue" else operations.sequencer_abort
    return await _run_off_loop(fn, (request.match_info["repo_id"], kind), {})


@_guarded
async def _reset(request: web.Request) -> web.Response:
    body = await _body(request)
    return await _run_off_loop(
        operations.reset,
        (request.match_info["repo_id"], body.get("ref", "HEAD"), body.get("mode", "mixed")),
        {},
    )


# ── remotes / worktrees / submodules ─────────────────────────────────────────


@_guarded
async def _remotes(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.list_remotes, (request.match_info["repo_id"],), {})


@_guarded
async def _remote_op(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]

    def run():
        op = body.get("op", "")
        if op == "add":
            return operations.add_remote(repo_id, body.get("name", ""), body.get("url", ""))
        if op == "remove":
            return operations.remove_remote(repo_id, body.get("name", ""))
        if op == "set-url":
            return operations.set_remote_url(
                repo_id, body.get("name", ""), body.get("url", ""), bool(body.get("push"))
            )
        if op == "prune":
            return operations.prune_remote(repo_id, body.get("name", "origin"))
        raise ValueError(f"unknown op {op!r}")

    return await _run_off_loop(run, (), {})


@_guarded
async def _worktrees(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.worktree_list, (request.match_info["repo_id"],), {})


@_guarded
async def _worktree_op(request: web.Request) -> web.Response:
    body = await _body(request)
    repo_id = request.match_info["repo_id"]

    def run():
        op = body.get("op", "")
        if op == "add":
            return operations.worktree_add(
                repo_id, body.get("path", ""), body.get("branch"), body.get("ref", "HEAD")
            )
        if op == "remove":
            return operations.worktree_remove(
                repo_id, body.get("path", ""), bool(body.get("force"))
            )
        raise ValueError(f"unknown op {op!r}")

    return await _run_off_loop(run, (), {})


@_guarded
async def _submodules(request: web.Request) -> web.Response:
    return await _run_off_loop(operations.submodule_status, (request.match_info["repo_id"],), {})


# ── blame / history / content / search ───────────────────────────────────────


@_guarded
async def _blame(request: web.Request) -> web.Response:
    q = request.query
    return await _run_off_loop(
        diffing.blame, (request.match_info["repo_id"], q.get("path", ""), q.get("ref", "HEAD")), {}
    )


@_guarded
async def _history(request: web.Request) -> web.Response:
    q = request.query
    return await _run_off_loop(
        diffing.file_history,
        (request.match_info["repo_id"], q.get("path", "")),
        {"limit": int(q.get("limit", "200")), "follow": q.get("follow", "1") != "0"},
    )


@_guarded
async def _content(request: web.Request) -> web.Response:
    q = request.query
    return await _run_off_loop(
        diffing.file_content,
        (request.match_info["repo_id"], q.get("ref", "HEAD"), q.get("path", "")),
        {},
    )


@_guarded
async def _search(request: web.Request) -> web.Response:
    q = request.query

    def run():
        return operations.search_commits(
            request.match_info["repo_id"],
            q.get("q", ""),
            q.get("mode", "all"),
            int(q.get("limit", "100")),
            q.get("branch", "HEAD"),
            q.get("path") or None,
        )

    return await _run_off_loop(run, (), {})


# ── network (fetch / pull / push over SSE) ───────────────────────────────────


@_guarded
async def _network_start(request: web.Request) -> web.Response:
    kind = request.match_info["kind"]
    if kind not in ("fetch", "pull", "push"):
        return _json({"error": f"unknown op {kind!r}", "code": "bad_request"}, 400)
    body = await _body(request)
    try:
        return _json(await network.start_op(request.match_info["repo_id"], kind, body))
    except Exception as exc:  # noqa: BLE001
        return _error_response(exc)


@_guarded
async def _network_stream(request: web.Request) -> web.Response:
    try:
        op = network.get_op(request.match_info["op_id"])
    except KeyError:
        return _json({"error": "no such operation", "code": "not_found"}, 404)
    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
    await resp.prepare(request)
    await network.stream_events(op, resp)
    return resp


@_guarded
async def _network_cancel(request: web.Request) -> web.Response:
    return _json(await network.cancel_op(request.match_info["op_id"]))


def register_routes(app: web.Application) -> None:
    """Register on the gateway's aiohttp Application (single-arg convention)."""
    r = app.router
    R = f"{_BASE}/repos"
    r.add_get(R, _repos_list)
    r.add_post(R, _repos_add)
    r.add_delete(f"{R}/{{repo_id}}", _repos_remove)
    r.add_get(f"{R}/{{repo_id}}/status", _repo_status)
    r.add_get(f"{R}/{{repo_id}}/graph", _graph)
    r.add_get(f"{R}/{{repo_id}}/diff", _diff_worktree)
    r.add_get(f"{R}/{{repo_id}}/diff/rev", _diff_revision)
    r.add_post(f"{R}/{{repo_id}}/stage", _stage)
    r.add_post(f"{R}/{{repo_id}}/discard", _discard)
    r.add_post(f"{R}/{{repo_id}}/commit", _commit)
    r.add_get(f"{R}/{{repo_id}}/branches", _branches)
    r.add_post(f"{R}/{{repo_id}}/branches", _branch_op)
    r.add_get(f"{R}/{{repo_id}}/tags", _tags)
    r.add_post(f"{R}/{{repo_id}}/tags", _tag_op)
    r.add_post(f"{R}/{{repo_id}}/merge", _merge)
    r.add_post(f"{R}/{{repo_id}}/merge/abort", _merge_abort)
    r.add_post(f"{R}/{{repo_id}}/merge/continue", _merge_continue)
    r.add_get(f"{R}/{{repo_id}}/conflicts", _conflicts)
    r.add_get(f"{R}/{{repo_id}}/conflicts/file", _conflict_file)
    r.add_post(f"{R}/{{repo_id}}/conflicts/resolve", _conflict_resolve)
    r.add_get(f"{R}/{{repo_id}}/rebase", _rebase_status)
    r.add_post(f"{R}/{{repo_id}}/rebase", _rebase_op)
    r.add_get(f"{R}/{{repo_id}}/rebase/todo-preview", _rebase_todo_preview)
    r.add_get(f"{R}/{{repo_id}}/stash", _stash)
    r.add_post(f"{R}/{{repo_id}}/stash", _stash_op)
    r.add_get(f"{R}/{{repo_id}}/stash/{{index}}/diff", _stash_diff)
    r.add_post(f"{R}/{{repo_id}}/cherry-pick", _cherry_pick)
    r.add_post(f"{R}/{{repo_id}}/revert", _revert)
    r.add_post(f"{R}/{{repo_id}}/sequencer", _sequencer)
    r.add_post(f"{R}/{{repo_id}}/reset", _reset)
    r.add_get(f"{R}/{{repo_id}}/remotes", _remotes)
    r.add_post(f"{R}/{{repo_id}}/remotes", _remote_op)
    r.add_get(f"{R}/{{repo_id}}/worktrees", _worktrees)
    r.add_post(f"{R}/{{repo_id}}/worktrees", _worktree_op)
    r.add_get(f"{R}/{{repo_id}}/submodules", _submodules)
    r.add_get(f"{R}/{{repo_id}}/blame", _blame)
    r.add_get(f"{R}/{{repo_id}}/history", _history)
    r.add_get(f"{R}/{{repo_id}}/content", _content)
    r.add_get(f"{R}/{{repo_id}}/search", _search)
    r.add_post(f"{R}/{{repo_id}}/network/{{kind}}", _network_start)
    r.add_get(f"{_BASE}/network/{{op_id}}/stream", _network_stream)
    r.add_post(f"{_BASE}/network/{{op_id}}/cancel", _network_cancel)
