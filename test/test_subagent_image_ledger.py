"""A kept subagent conversation keeps its inline-image ledger across continuation.

A run's conversation has no session-map entry until it is continued, so the
ledger that dedups and budgets the pictures it inlined lives on the run's
provider handle and died with it: the continuation seeded the conversation from
``state.json`` and resumed a context window full of pictures with an empty
ledger. The run now persists the ledger into ``state.json`` at teardown -- and
the reaper does the same for a run it tears down -- and every seed site stores
it back under the seeded sid, refusing a ledger that names another conversation.
"""

from __future__ import annotations

import asyncio
from test.test_subagent_continuable import _manager, _mock_sessions
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kiro_crew import image_ledger
from kiro_crew.acp.client import AcpClient
from kiro_crew.image_ledger import SessionImageBudget, apply_image_budget, empty_ledger
from kiro_crew.providers.acp import AcpProvider
from kiro_crew.session_map import SessionMap
from kiro_crew.subagent import SubagentInfo, SubagentManager
from kiro_crew.subagent_manager.continuation import ContinuationCoordinator

SID = "sid-run"
DIGEST = "a" * 64


def _prompt(seed: int = 1, size: int = 120) -> list[dict]:
    data = ("A" * size)[:size]
    return [
        {"type": "text", "text": "look: [image: a.png]"},
        {
            "type": "image",
            "data": data if seed == 1 else ("B" * size),
            "mimeType": "image/png",
            image_ledger.IMAGE_BLOCK_SOURCE_KEY: {"path": "", "spans": [[6, 20]]},
        },
    ]


def _charged_ledger(sid: str = SID) -> dict:
    """A ledger that counts one picture, as a run that inlined one leaves it."""
    return apply_image_budget(_prompt(), empty_ledger(sid)).ledger


async def _settle(manager: SubagentManager, info: SubagentInfo) -> None:
    """Await the run's task if it is still registered (a trivial run may finish first)."""
    task = manager._tasks.get(info.id)
    if task is not None:
        await task
    for _ in range(20):
        if info.done:
            return
        await asyncio.sleep(0.01)


class TestSnapshot:
    @pytest.mark.asyncio
    async def test_the_budget_snapshot_is_the_ledger_or_nothing(self):
        budget = SessionImageBudget(lambda: "subagent:x", lambda: SID)
        assert budget.snapshot() is None, "counts nothing"
        await budget.apply(_prompt())
        budget.commit()
        budget.confirm()
        snap = budget.snapshot()
        assert snap and snap["sid"] == SID and snap["hashes"] and snap["b64_bytes"] == 120
        empty_sid = SessionImageBudget(lambda: "subagent:x", lambda: "")
        assert empty_sid.snapshot() is None

    @pytest.mark.asyncio
    async def test_a_snapshot_reads_an_unconfirmed_prompt_as_uncertain(self):
        """The owner is going away: no frame will confirm the written prompt."""
        budget = SessionImageBudget(lambda: "subagent:x", lambda: SID)
        await budget.apply(_prompt())
        budget.commit()  # written, never confirmed
        snap = budget.snapshot()
        assert snap["unconfirmed"] is None and snap["uncertain_bytes"] == 120
        assert snap["hashes"] == [] and snap["b64_bytes"] == 120

    @pytest.mark.asyncio
    async def test_both_client_shapes_expose_the_snapshot(self, tmp_path):
        client = AcpClient(work_dir=tmp_path, session_key="subagent:x")
        client._session_id = SID
        assert client.image_ledger_snapshot() is None
        await client._image_budget.apply(_prompt())
        client._image_budget.commit()
        client._image_budget.confirm()
        assert client.image_ledger_snapshot()["b64_bytes"] == 120
        provider = AcpProvider.__new__(AcpProvider)
        provider._client = client
        assert provider.image_ledger_snapshot()["b64_bytes"] == 120
        provider._client = object()  # a placeholder shape that never carried a ledger
        assert provider.image_ledger_snapshot() is None


class TestTeardownCapture:
    def _info(self, *, sharing: bool, reaped: bool = False) -> SubagentInfo:
        info = SubagentInfo(id="run1", task="t")
        info._session_sharing = sharing
        info.reaped = reaped
        return info

    def test_a_dedicated_run_reads_its_provider_through_the_session_manager(self):
        sessions = _mock_sessions()
        ledger = _charged_ledger()
        sessions.get_provider = MagicMock(
            return_value=SimpleNamespace(image_ledger_snapshot=lambda: ledger)
        )
        manager = _manager(sessions)
        assert manager._snapshot_image_ledger(self._info(sharing=False), "subagent:run1") == ledger
        sessions.get_provider.assert_called_once_with("subagent:run1")

    def test_a_shared_run_reads_the_handle_it_holds(self):
        manager = _manager()
        info = self._info(sharing=True)
        ledger = _charged_ledger()
        info._shared_provider = SimpleNamespace(image_ledger_snapshot=lambda: ledger)
        assert manager._snapshot_image_ledger(info, "subagent:run1") == ledger
        info._shared_provider = None
        assert manager._snapshot_image_ledger(info, "subagent:run1") is None

    def test_a_provider_without_a_ledger_or_a_failing_one_reads_as_nothing(self):
        sessions = _mock_sessions()
        sessions.get_provider = MagicMock(return_value=object())
        manager = _manager(sessions)
        assert manager._snapshot_image_ledger(self._info(sharing=False), "k") is None

        def boom():
            raise RuntimeError("gone")

        sessions.get_provider = MagicMock(return_value=SimpleNamespace(image_ledger_snapshot=boom))
        assert manager._snapshot_image_ledger(self._info(sharing=False), "k") is None

    @pytest.mark.asyncio
    async def test_persist_writes_the_field_and_skips_nothing(self):
        manager = _manager()
        info = self._info(sharing=False)
        ledger = _charged_ledger()
        with patch.object(manager, "_write_state_off_loop", AsyncMock(return_value=True)) as w:
            await manager._persist_image_ledger(info, ledger)
            w.assert_awaited_once_with(info, "image ledger", image_ledger=ledger)
            await manager._persist_image_ledger(info, None)
            assert w.await_count == 1, "nothing written for nothing"

    @pytest.mark.asyncio
    async def test_teardown_snapshots_before_the_release_and_persists_after(self):
        """Ordering: the provider is read before the first await takes it away,
        and the state write comes after the release so a cancellation at the
        write cannot skip the release."""
        sessions = _mock_sessions()
        ledger = _charged_ledger()
        order: list[str] = []
        sessions.get_provider = MagicMock(
            return_value=SimpleNamespace(
                image_ledger_snapshot=lambda: (order.append("snapshot"), ledger)[1]
            )
        )
        sessions.release = MagicMock(side_effect=lambda *a, **k: order.append("release"))
        manager = _manager(sessions)
        info = self._info(sharing=False)

        async def persist(info_, ledger_):
            order.append(f"persist:{ledger_ is ledger}")

        with (
            patch.object(manager, "_persist_image_ledger", persist),
            patch.object(
                manager,
                "_release_run_session",
                AsyncMock(side_effect=lambda *a, **k: sessions.release("subagent:run1")),
            ),
        ):
            await manager._teardown_run_session(info, "subagent:run1")
        assert order == ["snapshot", "release", "persist:True"]

    @pytest.mark.asyncio
    async def test_a_cancelled_release_still_persists_the_snapshot(self):
        sessions = _mock_sessions()
        ledger = _charged_ledger()
        sessions.get_provider = MagicMock(
            return_value=SimpleNamespace(image_ledger_snapshot=lambda: ledger)
        )
        manager = _manager(sessions)
        info = self._info(sharing=False)
        persisted: list[object] = []

        async def persist(info_, ledger_):
            persisted.append(ledger_)

        async def cancelled_release(*_a, **_k):
            raise asyncio.CancelledError()

        with (
            patch.object(manager, "_persist_image_ledger", persist),
            patch.object(manager, "_release_run_session", cancelled_release),
            pytest.raises(asyncio.CancelledError),
        ):
            await manager._teardown_run_session(info, "subagent:run1")
        assert persisted == [ledger]

    @pytest.mark.asyncio
    async def test_a_reaped_run_takes_no_snapshot_at_its_own_teardown(self):
        """The reaper tore the provider down and took the snapshot itself."""
        sessions = _mock_sessions()
        sessions.get_provider = MagicMock(side_effect=AssertionError("must not be read"))
        manager = _manager(sessions)
        info = self._info(sharing=False, reaped=True)
        persisted: list[object] = []

        async def persist(info_, ledger_):
            persisted.append(ledger_)

        with (
            patch.object(manager, "_persist_image_ledger", persist),
            patch.object(manager, "_release_run_session", AsyncMock()),
        ):
            await manager._teardown_run_session(info, "subagent:run1")
        assert persisted == [None]


class TestRestoreOnContinuation:
    def test_the_restore_binds_to_the_seeded_sid_and_refuses_the_rest(self, tmp_path):
        sm = SessionMap()
        sm.set("subagent:r", SID)
        image_ledger.set_image_ledger_store(sm)
        try:
            restore = ContinuationCoordinator._restore_image_ledger
            assert restore("subagent:r", SID, None) is False, "no field: nothing stored"
            assert restore("subagent:r", SID, "junk") is False
            assert restore("subagent:r", SID, {"sid": SID}) is False, "empty: nothing to carry"
            other = _charged_ledger("sid-other")
            assert restore("subagent:r", SID, other) is False, "another conversation's ledger"
            assert sm.get_image_ledger("subagent:r") == {}
            # The run's own ledger, with a prompt it never confirmed.
            own = _charged_ledger()
            own["unconfirmed"] = {"hashes": ["b" * 64], "recent": [], "pending_text": 0, "b": 50}
            own["b64_bytes"] += 50
            assert restore("subagent:r", SID, own) is True
            landed = sm.get_image_ledger("subagent:r")
            assert landed["sid"] == SID and landed["hashes"] == own["hashes"]
            assert landed["uncertain_bytes"] == 50 and landed["unconfirmed"] is None
            assert landed["b64_bytes"] == 170
        finally:
            image_ledger.set_image_ledger_store(None)

    @pytest.mark.asyncio
    async def test_continue_restores_the_persisted_ledger_after_seeding(self):
        """Two successive continuations: the first seeds and restores from the
        run's record; the second finds the entry resumable and stores nothing
        over the ledger the first conversation has been building since."""
        from kiro_crew.subagent_persistence import create_agent_folder, write_run_agent

        await asyncio.to_thread(create_agent_folder, "ledgerrun")
        await asyncio.to_thread(write_run_agent, "ledgerrun", "")
        sessions = _mock_sessions(resumed=True)
        seeded = {"done": False}
        sessions.resumable_sid = MagicMock(
            side_effect=lambda key: "sid-from-state" if seeded["done"] else None
        )
        sessions.seed_conversation = MagicMock(
            side_effect=lambda *a, **k: seeded.__setitem__("done", True)
        )
        manager = _manager(sessions)
        ledger = _charged_ledger("sid-from-state")
        state = {
            "session_id": "sid-from-state",
            "provider": "acp",
            "cwd": "/tmp/x",
            "image_ledger": ledger,
        }
        stored: list[tuple] = []
        with (
            patch("kiro_crew.subagent.Stats"),
            patch("kiro_crew.subagent.sel"),
            patch("kiro_crew.subagent.read_state", return_value=state),
            patch.object(manager, "_promote_conversation", return_value=object()),
            patch(
                "kiro_crew.subagent_manager.continuation.store_image_ledger",
                side_effect=lambda key, led: (stored.append((key, led)), True)[1],
            ),
        ):
            info = manager.continue_conversation("ledgerrun", "follow-up")
            assert info is not None and not info.error, info.error
            await _settle(manager, info)
            # Second continuation: the entry is resumable now, no seed, no store.
            info2 = manager.continue_conversation("ledgerrun", "again")
            assert info2 is not None and not info2.error, info2.error
            await _settle(manager, info2)
        sessions.seed_conversation.assert_called_once()
        assert len(stored) == 1
        key, landed = stored[0]
        assert key == "subagent:ledgerrun" and landed["sid"] == "sid-from-state"
        assert landed["hashes"] == ledger["hashes"] and landed["b64_bytes"] == 120

    @pytest.mark.asyncio
    async def test_the_startup_sweep_restores_what_the_scan_read(self):
        sessions = _mock_sessions()
        sessions.resumable_sid = MagicMock(return_value=None)
        manager = _manager(sessions)
        ledger = _charged_ledger("sid-k")
        found = [
            ("k1", "subagent:k1", "sid-k", "acp", "", 1.0, ledger),
            ("k2", "subagent:k2", "sid-k2", "acp", "", 2.0, None),
            ("k3", "subagent:k3", "sid-k3", "acp", "", 3.0),  # an older six-field record
        ]
        stored: list[tuple] = []
        with (
            patch.object(manager, "_scan_keep_states", return_value=found),
            patch(
                "kiro_crew.subagent_manager.continuation.store_image_ledger",
                side_effect=lambda key, led: (stored.append((key, led)), True)[1],
            ),
        ):
            # resumable_sid: first read None (seed), then the seeded sid (keep).
            sessions.resumable_sid = MagicMock(
                side_effect=lambda key: None if key not in seeded else key.split(":")[1]
            )
            seeded: set[str] = set()
            sessions.seed_conversation = MagicMock(
                side_effect=lambda key, sid, **kw: seeded.add(key)
            )
            await manager._rebuild_conversation_registry()
        assert sessions.seed_conversation.call_count == 3
        assert [k for k, _ in stored] == ["subagent:k1"]
        assert stored[0][1]["sid"] == "sid-k" and stored[0][1]["hashes"] == ledger["hashes"]
