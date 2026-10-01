"""A failed run whose conversation a ``spawn_continue`` adopted is never re-spawned
by the dashboard's retry route.

The reported shape, built from the real run records: a ``spawn_run`` member
hit ``turn_limit:100`` and was left ``failed``; ``spawn_continue`` adopted its
conversation and the continuation finished the task. The failed card stays on
the panel, so ``Retry failed (N)`` keeps offering it, and ``POST
/api/spawn/{id}/retry`` re-spawns the ORIGINAL prompt -- original task text,
no conversation key, a new run id, the same worktree -- once per click, each
a second writer on work the continuation has already done.

Two halves of one fence, each pinned on both sides:

- the ROUTE refuses such a run with a typed 409 and starts nothing, and still
  re-spawns a failed run nobody continued;
- the MARK (``SubagentInfo.superseded_by``) is set on the original when a
  continuation is accepted, is NOT set when the continuation is refused, and
  is what ``continuation_of`` answers once the continuation itself has left the
  registry -- the registry scan behind it answers for a continuation that
  reached the registry without the mark.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web

from kiro_crew import subagent_persistence as sp
from kiro_crew.dashboard.handlers import messaging as handlers
from kiro_crew.execution_context import ExecutionContext, MemoryStoreRef
from kiro_crew.subagent import SubagentInfo, SubagentManager

# ``SubagentManager.spawn`` refuses while the host looks short of memory, which
# is the runner's state, not this file's input.
pytestmark = pytest.mark.usefixtures("healthy_host_memory")

# Subagent-registry isolation is the root conftest's autouse
# ``_isolate_subagents_dir``; every manager built here is closed at teardown.


@pytest.fixture(autouse=True)
def _close_subagent_managers(close_subagent_managers):
    """The body lives in ``conftest``."""


ORIGINAL = "orig0000deadbeef"
CONTINUATION = "cont0000deadbeef"
PARENT = "dashboard:main"
TASK = "implement the change in the worktree, run the verify target, commit"


def _mock_sessions(resumed: bool = True) -> MagicMock:
    """The SessionManager double ``test_subagent_continuable`` builds, trimmed to
    what a continuation's prelude and run read."""
    sessions = MagicMock()
    sessions.get_pid = MagicMock(return_value=None)
    provider = AsyncMock()
    provider.start = AsyncMock()
    provider.shutdown = AsyncMock()
    provider.context_usage_pct = lambda: 0.0
    provider.context_window_tokens = lambda: 100000
    provider.context_used_tokens = lambda: 0
    provider.session_id = "sid-123"
    provider.cwd = ""

    async def _empty_stream(*_args: object, **_kwargs: object):  # type: ignore[no-untyped-def]
        return
        yield  # noqa: unreachable -- makes this an async generator

    provider.stream = MagicMock(side_effect=lambda *a, **kw: _empty_stream())
    sessions.get_or_create = AsyncMock(return_value=(provider, True, resumed))
    sessions.release = MagicMock()
    sessions.reset = AsyncMock()
    sessions.record_success = MagicMock()
    sessions.get_agent = MagicMock(return_value="")
    sessions.get_agent_selection = MagicMock(
        side_effect=lambda key: ("template", sessions.get_agent(key))
    )
    sessions.mark_continuable = MagicMock()
    sessions.unmark_continuable = MagicMock()
    sessions.is_continuable = MagicMock(return_value=False)
    sessions.resumable_sid = MagicMock(return_value="sid-123")
    sessions.forget_conversation = MagicMock(return_value="sid-123")
    sessions.conversation_provider = MagicMock(return_value="acp")
    sessions.get_provider = MagicMock(return_value=None)
    return sessions


def _manager(sessions: MagicMock | None = None) -> SubagentManager:
    ctx = MagicMock()
    ctx.build_message = MagicMock(return_value=("built_message", None))
    ctx.hooks.on_tool_call = MagicMock()
    ctx.hooks.auto_approve_subagent_spawn = True
    return SubagentManager(sessions=sessions or _mock_sessions(), ctx_builder=ctx)


def _execution() -> ExecutionContext:
    return ExecutionContext(None, MemoryStoreRef("default"), "template", "kirocrew")


def _turn_limited_original(cwd: str) -> SubagentInfo:
    """The failed member exactly as ``_run_inner``'s turn-limit arm leaves it,
    with the run folder and the ``turn_limit`` tombstone it writes."""
    sp.create_agent_folder(ORIGINAL, task=TASK, parent_session=PARENT, max_turns=100)
    info = SubagentInfo(
        id=ORIGINAL,
        task=TASK,
        parent_session_key=PARENT,
        max_turns=100,
        cwd=cwd,
        execution_context=_execution(),
    )
    info._raw_task = TASK
    info.result = "_Partial output._"
    info.error = "turn_limit:100"
    info.done = True
    SubagentManager._write_tombstone(info, "turn_limit")
    return info


def _finished_continuation() -> SubagentInfo:
    """The ``spawn_continue`` run on the original's conversation, finished and
    delivered -- the record the reporter's resumed run left behind."""
    sp.create_agent_folder(CONTINUATION, task="carry on", parent_session=PARENT)
    sp.write_result_chunk(CONTINUATION, "verify is green, committed")
    sp.mark_delivered(CONTINUATION, elapsed=900.0, credits=0.0)
    info = SubagentInfo(
        id=CONTINUATION,
        task="carry on",
        parent_session_key=PARENT,
        keep=True,
        conversation_key=f"subagent:{ORIGINAL}",
        execution_context=_execution(),
    )
    info.result = "verify is green, committed"
    info.done = True
    return info


class _Req:
    """The request the retry route reads: ``app["state"]``, the route id, and
    the owner-identity fields the spawn helpers probe (dashboard owner, no app
    claim) -- the same reads ``test_handlers_messaging_coverage``'s double
    answers."""

    def __init__(self, state: Any, agent_id: str) -> None:
        self.app = {"state": state}
        self.match_info = {"agent_id": agent_id}
        self.headers: dict[str, str] = {}
        self.remote = "127.0.0.1"
        self._extra: dict[str, Any] = {"app": "", "user": "owner"}

    def __contains__(self, key: str) -> bool:
        return key in self._extra

    def __getitem__(self, key: str) -> Any:
        return self._extra[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self._extra.get(key, default)


def _retry(manager: SubagentManager, agent_id: str) -> web.Response:
    state = MagicMock()
    state.subagents = manager
    return asyncio.run(handlers.api_spawn_retry(_Req(state, agent_id)))


def _payload(resp: web.Response) -> dict[str, Any]:
    body = resp.body
    assert isinstance(body, (bytes, bytearray))
    return json.loads(body)


def _recording_spawn(manager: SubagentManager, started: list[dict[str, Any]]) -> None:
    """Replace both spawn entries with recorders: the route must not even ASK
    for a run, so no run is launched behind the assertion."""

    async def spawn_async(task: str, **kwargs: Any) -> SubagentInfo:
        started.append({"task": task, **kwargs})
        return SubagentInfo(id="fresh0000deadbeef", task=task)

    def spawn(task: str, **kwargs: Any) -> SubagentInfo:
        started.append({"task": task, **kwargs})
        return SubagentInfo(id="fresh0000deadbeef", task=task)

    manager.spawn_async = spawn_async  # type: ignore[method-assign]
    manager.spawn = spawn  # type: ignore[method-assign]


def _run_folders() -> set[str]:
    return {p.name for p in sp._subagents_dir().iterdir() if p.is_dir()}


class TestRetryRouteAfterAContinuation:
    def test_a_failed_run_whose_conversation_was_continued_is_refused_and_nothing_starts(
        self, tmp_path
    ) -> None:
        manager = _manager()
        original = _turn_limited_original(str(tmp_path))
        continuation = _finished_continuation()
        manager._agents[ORIGINAL] = original
        manager._agents[CONTINUATION] = continuation
        folders_before = _run_folders()
        assert folders_before == {ORIGINAL, CONTINUATION}
        assert original.outcome == "failed"
        started: list[dict[str, Any]] = []
        _recording_spawn(manager, started)

        resp = _retry(manager, ORIGINAL)

        assert resp.status == 409, _payload(resp)
        body = _payload(resp)
        assert body["code"] == "superseded_by_continuation"
        assert body["continued_by"] == CONTINUATION
        assert CONTINUATION in body["error"]
        # Relaunched NOTHING: no spawn was asked for and no run folder appeared.
        assert started == []
        assert _run_folders() == folders_before

    def test_a_failed_run_nobody_continued_is_still_retried(self, tmp_path) -> None:
        """The other half of the fence: the refusal is exactly as wide as adoption."""
        manager = _manager()
        original = _turn_limited_original(str(tmp_path))
        manager._agents[ORIGINAL] = original
        started: list[dict[str, Any]] = []
        _recording_spawn(manager, started)

        resp = _retry(manager, ORIGINAL)

        assert resp.status == 200, _payload(resp)
        assert _payload(resp) == {
            "id": "fresh0000deadbeef",
            "retried_from": ORIGINAL,
            "status": "spawned",
        }
        assert [s["task"] for s in started] == [TASK]
        assert started[0]["cwd"] == str(tmp_path)
        assert "conversation_key" not in started[0]

    def test_the_mark_outlives_the_continuation_in_the_registry(self, tmp_path) -> None:
        """A continuation dismissed from the panel (popped from ``_agents``) still
        counts: the mark sits on the original's own record."""
        manager = _manager()
        original = _turn_limited_original(str(tmp_path))
        original.superseded_by = CONTINUATION
        manager._agents[ORIGINAL] = original
        started: list[dict[str, Any]] = []
        _recording_spawn(manager, started)

        resp = _retry(manager, ORIGINAL)

        assert resp.status == 409
        assert _payload(resp)["continued_by"] == CONTINUATION
        assert started == []


class TestAdoptionMark:
    @pytest.mark.asyncio
    async def test_an_accepted_continuation_marks_the_original_superseded(self) -> None:
        await asyncio.to_thread(sp.create_agent_folder, ORIGINAL, memory_mode="persistent")
        await asyncio.to_thread(sp.write_run_agent, ORIGINAL, "")
        manager = _manager(_mock_sessions(resumed=True))
        original = SubagentInfo(id=ORIGINAL, task=TASK, done=True, error="turn_limit:100")
        manager._agents[ORIGINAL] = original
        with (
            patch("kiro_crew.subagent.Stats"),
            patch("kiro_crew.subagent.sel"),
            patch.object(manager, "_promote_conversation", return_value=object()),
        ):
            child = manager.continue_conversation(ORIGINAL, "carry on")
            assert child is not None and not child.error, child.error
            await manager._tasks[child.id]
        assert child.conversation_key == f"subagent:{ORIGINAL}"
        assert original.superseded_by == child.id
        assert manager.continuation_of(ORIGINAL) == child.id
        # The mark is the original's; the continuation's own record is unmarked
        # and nothing has continued IT.
        assert manager.continuation_of(child.id) == ""

    def test_a_refused_continuation_leaves_the_original_retryable(self) -> None:
        sp.create_agent_folder(ORIGINAL, memory_mode="persistent")
        manager = _manager()
        original = SubagentInfo(id=ORIGINAL, task=TASK, done=True, error="turn_limit:100")
        manager._agents[ORIGINAL] = original
        refusal = SubagentInfo(
            id="refused00deadbeef",
            task="carry on",
            done=True,
            error="spawn refused: task store unavailable (locked)",
        )
        with (
            patch("kiro_crew.subagent.sel"),
            patch.object(manager, "_promote_conversation", return_value=object()),
            patch.object(manager, "spawn", return_value=refusal),
        ):
            child = manager.continue_conversation(ORIGINAL, "carry on")
        assert child is refusal
        assert original.superseded_by == ""
        assert manager.continuation_of(ORIGINAL) == ""

    def test_the_registry_scan_answers_for_an_unmarked_continuation(self) -> None:
        """A continuation that reached the registry without passing the mark --
        a durable row re-dispatched under its original params -- is the same
        evidence read from the other side, live, finished or still queued."""
        manager = _manager()
        manager._agents[ORIGINAL] = SubagentInfo(
            id=ORIGINAL, task=TASK, done=True, error="turn_limit:100"
        )
        manager._agents[CONTINUATION] = SubagentInfo(
            id=CONTINUATION, task="carry on", conversation_key=f"subagent:{ORIGINAL}"
        )
        assert manager.continuation_of(ORIGINAL) == CONTINUATION
        del manager._agents[CONTINUATION]
        assert manager.continuation_of(ORIGINAL) == ""
        # A resume entry names a resident run, never a continuation; an
        # unstarted entry carrying the key does.
        manager._queue.append({"_resume_id": ORIGINAL, "_preassigned_id": ORIGINAL})
        assert manager.continuation_of(ORIGINAL) == ""
        manager._queue.append(
            {"task": "carry on", "conversation_key": f"subagent:{ORIGINAL}", "_preassigned_id": "q"}
        )
        assert manager.continuation_of(ORIGINAL) == "q"
        assert manager.continuation_of("nobody00deadbeef") == ""
