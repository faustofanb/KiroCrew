"""Praxis Insight tests — the simulator's semantic guarantees.

These are the invariants from the PraxisCode specification that the UI leans
on; a simulator that quietly collapses them would put a wrong domain model in
front of the operator.
"""
from __future__ import annotations

import pytest

from kiro_crew.apps.builtins.praxis_insight.backend.simulator import (
    EVIDENCE_LEVELS,
    STATUS_WORDS,
    PraxisSimulator,
)


@pytest.fixture()
def sim() -> PraxisSimulator:
    return PraxisSimulator()


def test_thirteen_status_words_unique(sim):
    assert len(STATUS_WORDS) == 13
    assert len(set(STATUS_WORDS)) == 13
    assert "UNKNOWN" in STATUS_WORDS and "FAILED" in STATUS_WORDS


def test_six_evidence_levels_unique(sim):
    assert len(EVIDENCE_LEVELS) == 6
    assert len(set(EVIDENCE_LEVELS)) == 6


def test_unknown_is_never_reported_as_failed(sim):
    statuses = {w["status"] for w in sim.snapshot()["works"]}
    assert "UNKNOWN" in statuses
    assert "FAILED" not in statuses  # the seeded domain has an UNKNOWN work


def test_approval_decision_is_durable(sim):
    sim.decide_approval("ap-2041", "accepted")
    with pytest.raises(PermissionError):
        sim.decide_approval("ap-2041", "rejected")


def test_approval_rejection_blocks_work_with_consequence_stated(sim):
    sim.decide_approval("ap-2041", "rejected")
    work = next(w for w in sim.works if w.id == "w-012")
    assert work.status == "BLOCKED"
    approval = next(a for a in sim.approvals if a.id == "ap-2041")
    assert approval.refusal_consequence  # a refusal without a consequence is a blind decision


def test_lifecycle_advances_only_along_legal_edges(sim):
    sim.advance_work("w-012")  # WAITING_HUMAN -> RUNNING
    sim.advance_work("w-012")  # RUNNING -> VERIFYING
    sim.advance_work("w-012")  # VERIFYING -> ACCEPTED
    sim.advance_work("w-012")  # ACCEPTED -> DELIVERED
    with pytest.raises(PermissionError):
        sim.advance_work("w-012")  # DELIVERED is terminal


def test_unknown_advances_to_recovery_not_to_failed(sim):
    result = sim.advance_work("w-015")  # UNKNOWN
    assert result["work"]["status"] == "RECOVERY_REQUIRED"
    assert result["work"]["status"] != "FAILED"


def test_every_status_word_has_a_legal_next_or_is_terminal():
    from kiro_crew.apps.builtins.praxis_insight.backend import simulator as mod

    for word in STATUS_WORDS:
        assert word in mod._LIFECYCLE, f"{word} has no lifecycle entry"
