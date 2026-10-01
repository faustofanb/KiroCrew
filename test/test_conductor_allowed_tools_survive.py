"""A user's own ``allowedTools`` entries on a conductor spec survive its regeneration.

The conductor installers run on every ``rebuild_agent_config`` -- every gateway start
-- and an installer that rebuilt ``allowedTools`` from its grant tuple and wrote the
file without reading it would leave an entry the user approved on
``kirocrew-conductor.json`` (or the pipeline, security or ledger-alias spec) gone at
the next start, silently, while ``toolsSettings`` carried over. ``kirocrew.json``
keeps the user's list on an existing install; these tests pin that the four conductor
specs do too, the way that list does: the user's entries are kept, the shipped grants
are re-added, the governance ceiling still removes what it forbids, and nothing is
dropped without a log line naming it.

What tells a user's entry apart from Crew's own is the sidecar record of the grants
Crew shipped at its last write (``agent_state.get_shipped_grants``). Without it an
add-only merge would keep every grant an earlier release shipped and a later one
deliberately stopped shipping -- the goal conductor's core grant is named verbs where
an earlier release's was a bare ``@kirocrew-core``, and that narrowing has to reach
existing installs.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from kiro_crew import agent, agent_state
from kiro_crew.agent_files import (
    CONDUCTOR_AGENT_FILENAME,
    LEDGER_CONDUCTOR_AGENT_FILENAME,
    PIPELINE_CONDUCTOR_AGENT_FILENAME,
    SECURITY_CONDUCTOR_AGENT_FILENAME,
)
from kiro_crew.kiro_cli import SPEC_PERMISSIONS_MIN_VERSION

#: (spec name, filename, installer) for the three installers; the ledger alias shares
#: ``_conductor_spec`` with the goal conductor and gets its own test below.
_CONDUCTORS = [
    pytest.param(
        "kirocrew-conductor",
        CONDUCTOR_AGENT_FILENAME,
        "_install_conductor_agent",
        id="conductor",
    ),
    pytest.param(
        "kirocrew-pipeline-conductor",
        PIPELINE_CONDUCTOR_AGENT_FILENAME,
        "_install_pipeline_conductor_agent",
        id="pipeline",
    ),
    pytest.param(
        "kirocrew-security-conductor",
        SECURITY_CONDUCTOR_AGENT_FILENAME,
        "_install_security_conductor_agent",
        id="security",
    ),
]

#: Mounted on every conductor and auto-approved by none of them: the entry a user
#: approves ("stop asking me about reads") and expects to stay approved.
_USER_GRANT = "fs_read"


@pytest.fixture
def agents_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private agents directory, an ungoverned ceiling, and an accepting kiro-cli."""
    monkeypatch.setattr(agent, "kiro_agents_dir_path", lambda: tmp_path)
    monkeypatch.setattr(
        "kiro_crew.kiro_cli.installed_kiro_cli_version", lambda: SPEC_PERMISSIONS_MIN_VERSION
    )
    monkeypatch.setattr(
        agent,
        "build_agent_config",
        lambda: {
            "name": "kirocrew",
            "prompt": "file://x",
            "mcpServers": {
                "kirocrew-core": {"command": "/resolved/kirocrew", "args": ["mcp-core"]},
            },
            "tools": ["fs_write", "@kirocrew-core"],
            "allowedTools": ["@kirocrew-core"],
        },
    )
    monkeypatch.setattr(
        agent, "_kirocrew_mcp_invocation", lambda sub: ("/resolved/kirocrew", [sub])
    )
    monkeypatch.setattr(agent, "_may_auto_approve", lambda ref: True)
    return tmp_path


def _read(agents_dir: Path, filename: str) -> dict:
    return json.loads((agents_dir / filename).read_text(encoding="utf-8"))


def _edit_allowed(agents_dir: Path, filename: str, mutate) -> None:
    """Edit the spec's ``allowedTools`` on disk the way a user does: by hand."""
    path = agents_dir / filename
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data["allowedTools"])
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _dropped_line(caplog: pytest.LogCaptureFixture, filename: str) -> str:
    lines = [
        record.getMessage()
        for record in caplog.records
        if record.levelno >= logging.WARNING and filename in record.getMessage()
    ]
    assert len(lines) == 1, f"expected ONE line naming the drop, got {lines!r}"
    return lines[0]


@pytest.mark.parametrize(("name", "filename", "installer"), _CONDUCTORS)
class TestUserGrantsSurviveRegeneration:
    def test_a_user_added_grant_survives_and_the_shipped_grants_stay(
        self, agents_dir: Path, name: str, filename: str, installer: str
    ) -> None:
        """The reporter's case: approve a tool, restart, it is still approved."""
        install = getattr(agent, installer)
        install()
        shipped = _read(agents_dir, filename)["allowedTools"]
        assert _USER_GRANT in _read(agents_dir, filename)["tools"]
        assert _USER_GRANT not in shipped

        _edit_allowed(agents_dir, filename, lambda lst: lst.append(_USER_GRANT))
        install()

        # Shipped grants first, in their shipped order; the user's entry after them.
        assert _read(agents_dir, filename)["allowedTools"] == [*shipped, _USER_GRANT]

    def test_the_user_entry_is_still_there_after_a_second_regeneration(
        self, agents_dir: Path, name: str, filename: str, installer: str
    ) -> None:
        """Surviving one start is not the bar; every start is."""
        install = getattr(agent, installer)
        install()
        _edit_allowed(agents_dir, filename, lambda lst: lst.append(_USER_GRANT))
        install()
        install()
        assert _USER_GRANT in _read(agents_dir, filename)["allowedTools"]

    def test_a_shipped_grant_the_user_removed_comes_back(
        self, agents_dir: Path, name: str, filename: str, installer: str
    ) -> None:
        """The list is the shipped grants PLUS the user's, like ``kirocrew.json``'s
        managed refs: narrowing a conductor is the governance ceiling's job."""
        install = getattr(agent, installer)
        install()
        shipped = _read(agents_dir, filename)["allowedTools"]
        assert "report" in shipped

        _edit_allowed(agents_dir, filename, lambda lst: lst.remove("report"))
        install()

        assert _read(agents_dir, filename)["allowedTools"] == shipped

    def test_a_ceiling_forbidden_user_grant_is_removed_and_named(
        self,
        agents_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
        name: str,
        filename: str,
        installer: str,
    ) -> None:
        """``allowedTools`` never reaches the PreToolUse gate, so a preserved entry
        passes the same ceiling the shipped grants do; the tool stays MOUNTED."""
        install = getattr(agent, installer)
        install()
        _edit_allowed(agents_dir, filename, lambda lst: lst.append("execute_bash"))
        monkeypatch.setattr(agent, "_may_auto_approve", lambda ref: ref != "execute_bash")

        with caplog.at_level(logging.WARNING):
            install()

        data = _read(agents_dir, filename)
        assert "execute_bash" in data["tools"]
        assert "execute_bash" not in data["allowedTools"]
        assert "execute_bash" in _dropped_line(caplog, filename)

    def test_a_grant_a_release_stopped_shipping_is_dropped(
        self,
        agents_dir: Path,
        caplog: pytest.LogCaptureFixture,
        name: str,
        filename: str,
        installer: str,
    ) -> None:
        """The narrowing shape: an earlier release shipped a bare ``@kirocrew-core``;
        this one ships named verbs. The old grant is Crew's, not the user's, and goes
        -- while the user's own entry beside it stays."""
        install = getattr(agent, installer)
        install()
        shipped = _read(agents_dir, filename)["allowedTools"]
        assert "@kirocrew-core" not in shipped
        # As the earlier release left things: its record names the wide grant, and
        # the file carries it, next to an entry the user added.
        agent_state.set_shipped_grants(name, [*shipped, "@kirocrew-core"])
        _edit_allowed(agents_dir, filename, lambda lst: lst.extend(["@kirocrew-core", _USER_GRANT]))

        with caplog.at_level(logging.WARNING):
            install()

        after = _read(agents_dir, filename)["allowedTools"]
        assert "@kirocrew-core" not in after
        assert after == [*shipped, _USER_GRANT]
        assert "@kirocrew-core" in _dropped_line(caplog, filename)
        assert agent_state.get_shipped_grants(name) == tuple(shipped)

    def test_without_a_record_nothing_on_disk_is_claimed_for_the_user(
        self,
        agents_dir: Path,
        caplog: pytest.LogCaptureFixture,
        name: str,
        filename: str,
        installer: str,
    ) -> None:
        """A spec written by a release before the record: every entry on it may be
        that release's own, so none is kept -- once, with a line saying so. The
        record is then written, and the next start keeps what the user re-adds."""
        install = getattr(agent, installer)
        install()
        agent_state.set_shipped_grants(name, None)
        _edit_allowed(agents_dir, filename, lambda lst: lst.append(_USER_GRANT))

        with caplog.at_level(logging.WARNING):
            install()

        assert _USER_GRANT not in _read(agents_dir, filename)["allowedTools"]
        line = _dropped_line(caplog, filename)
        assert _USER_GRANT in line
        assert "no record" in line
        assert agent_state.get_shipped_grants(name) is not None

        _edit_allowed(agents_dir, filename, lambda lst: lst.append(_USER_GRANT))
        install()
        assert _USER_GRANT in _read(agents_dir, filename)["allowedTools"]

    def test_nothing_is_logged_when_nothing_is_dropped(
        self,
        agents_dir: Path,
        caplog: pytest.LogCaptureFixture,
        name: str,
        filename: str,
        installer: str,
    ) -> None:
        install = getattr(agent, installer)
        install()
        _edit_allowed(agents_dir, filename, lambda lst: lst.append(_USER_GRANT))
        with caplog.at_level(logging.WARNING):
            install()
        assert not [
            r for r in caplog.records if r.levelno >= logging.WARNING and filename in r.getMessage()
        ]

    def test_the_record_holds_the_shipped_grants_and_not_the_users(
        self, agents_dir: Path, name: str, filename: str, installer: str
    ) -> None:
        """Recording the user's entry as Crew's would drop it at the next start."""
        install = getattr(agent, installer)
        install()
        shipped = _read(agents_dir, filename)["allowedTools"]
        _edit_allowed(agents_dir, filename, lambda lst: lst.append(_USER_GRANT))
        install()
        assert agent_state.get_shipped_grants(name) == tuple(shipped)

    def test_a_clean_install_resets_the_list(
        self, agents_dir: Path, name: str, filename: str, installer: str
    ) -> None:
        """``kirocrew setup --agent-only --clean`` is the explicit reset, and it resets
        the conductor specs as it resets ``kirocrew.json``."""
        install = getattr(agent, installer)
        install()
        shipped = _read(agents_dir, filename)["allowedTools"]
        _edit_allowed(agents_dir, filename, lambda lst: lst.append(_USER_GRANT))
        install(clean=True)
        assert _read(agents_dir, filename)["allowedTools"] == shipped
        assert agent_state.get_shipped_grants(name) == tuple(shipped)

    def test_a_malformed_list_on_disk_preserves_only_its_string_entries(
        self, agents_dir: Path, name: str, filename: str, installer: str
    ) -> None:
        """A hand-edited ``allowedTools: [1, "fs_read"]`` keeps the ref and drops the
        number: a non-string is not a tool ref and would crash the ceiling predicate."""
        install = getattr(agent, installer)
        install()
        _edit_allowed(agents_dir, filename, lambda lst: lst.extend([1, _USER_GRANT]))
        install()
        after = _read(agents_dir, filename)["allowedTools"]
        assert _USER_GRANT in after
        assert all(isinstance(ref, str) for ref in after)

    def test_kas_permissions_follow_the_merged_list(
        self, agents_dir: Path, name: str, filename: str, installer: str
    ) -> None:
        """The KAS block is derived from the list that is written, user entry included,
        so an approval that survives on kiro-cli survives on KAS too."""
        install = getattr(agent, installer)
        install()
        user_grant = "@kirocrew-core/knowledge_list_sources"
        assert user_grant not in _read(agents_dir, filename)["allowedTools"]
        _edit_allowed(agents_dir, filename, lambda lst: lst.append(user_grant))
        install()
        rules = _read(agents_dir, filename)["permissions"]["rules"]
        matches = [m for rule in rules for m in (rule.get("match") or [])]
        assert "kirocrew-core/knowledge_list_sources" in matches


class TestLedgerAliasPreservesUnderItsOwnName:
    def test_the_alias_keeps_its_own_user_entries(self, agents_dir: Path) -> None:
        """The alias emits the goal conductor's spec under the old name, so a user's
        entry on the alias file is kept on the alias file, keyed by the alias."""
        agent._install_ledger_conductor_agent()
        shipped = _read(agents_dir, LEDGER_CONDUCTOR_AGENT_FILENAME)["allowedTools"]
        _edit_allowed(
            agents_dir, LEDGER_CONDUCTOR_AGENT_FILENAME, lambda lst: lst.append(_USER_GRANT)
        )
        agent._install_ledger_conductor_agent()
        assert _read(agents_dir, LEDGER_CONDUCTOR_AGENT_FILENAME)["allowedTools"] == [
            *shipped,
            _USER_GRANT,
        ]
        assert agent_state.get_shipped_grants("kirocrew-ledger-conductor") == tuple(shipped)
        # The goal conductor's own file was never written, and its record is untouched.
        assert not (agents_dir / CONDUCTOR_AGENT_FILENAME).exists()
        assert agent_state.get_shipped_grants("kirocrew-conductor") is None


class TestShippedGrantsRecord:
    def test_unset_reads_none(self) -> None:
        assert agent_state.get_shipped_grants("kirocrew-nobody") is None

    def test_round_trips_and_clears(self) -> None:
        agent_state.set_shipped_grants("kirocrew-x", ["session", "@kirocrew-core/wait"])
        assert agent_state.get_shipped_grants("kirocrew-x") == ("session", "@kirocrew-core/wait")
        agent_state.set_shipped_grants("kirocrew-x", None)
        assert agent_state.get_shipped_grants("kirocrew-x") is None

    def test_an_empty_record_is_a_record(self) -> None:
        """Nothing shipped is a statement, not an absence: every entry on disk is then
        the user's."""
        agent_state.set_shipped_grants("kirocrew-x", [])
        assert agent_state.get_shipped_grants("kirocrew-x") == ()

    def test_a_malformed_record_reads_as_absent(self) -> None:
        """A record that is not a list of strings cannot vouch for anything, and the
        reader degrades it to "no record" rather than raising through an install."""
        agent_state.set_model_managed("kirocrew-x", True)
        path = agent_state._state_path()
        data = json.loads(path.read_text(encoding="utf-8"))
        data["kirocrew-x"]["shipped_grants"] = ["session", 7]
        path.write_text(json.dumps(data), encoding="utf-8")
        assert agent_state.get_shipped_grants("kirocrew-x") is None
        data["kirocrew-x"]["shipped_grants"] = "session"
        path.write_text(json.dumps(data), encoding="utf-8")
        assert agent_state.get_shipped_grants("kirocrew-x") is None

    def test_clearing_the_last_key_removes_the_entry(self) -> None:
        agent_state.set_shipped_grants("kirocrew-x", ["session"])
        agent_state.set_shipped_grants("kirocrew-x", None)
        data = json.loads(agent_state._state_path().read_text(encoding="utf-8"))
        assert "kirocrew-x" not in data
