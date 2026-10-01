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


# ── ChangeSet / 多仓变更管理（仿 fork）── ────────────────────────────────────

def test_changeset_divergence_requires_explicit_adjudication(sim):
    with pytest.raises(PermissionError):
        sim.promote_delivery("dl-302", "TEST")  # diverged cs-102 blocks promotion
    result = sim.resolve_divergence("cs-102", "rebase")
    assert result["changeset"]["status"] == "RECONCILED"
    assert result["changeset"]["divergence"] is None


def test_fork_sync_preserves_candidate_identity_while_commit_moves(sim):
    before = {rc.repo: rc.candidate_id for rc in sim.changesets[0].repos}
    heads_before = {rc.repo: rc.head.commit_sha for rc in sim.changesets[0].repos}
    sim.sync_fork("cs-101")
    after = {rc.repo: rc.candidate_id for rc in sim.changesets[0].repos}
    heads_after = {rc.repo: rc.head.commit_sha for rc in sim.changesets[0].repos}
    # Candidate identity is stable across a fork sync; the commit is not.
    assert before == after
    assert heads_before != heads_after


def test_rebase_adjudication_adds_revision_under_same_candidate(sim):
    stale = next(rc for rc in sim.changesets[1].repos if rc.candidate_id == "cr-10")
    n_before = len(stale.revisions)
    sim.resolve_divergence("cs-102", "rebase")
    assert len(stale.revisions) == n_before + 1
    assert stale.candidate_id == "cr-10"
    assert stale.revisions[-1].parent_id == "r-10.1"


def test_non_diverged_changeset_cannot_be_adjudicated(sim):
    with pytest.raises(PermissionError):
        sim.resolve_divergence("cs-101", "rebase")


# ── Delivery / CI-CD（E13 硬门）── ──────────────────────────────────────────

def test_prod_requires_real_test_evidence(sim):
    sim.resolve_divergence("cs-102", "rebase")  # unblock cs-102 first
    with pytest.raises(PermissionError, match="no real TEST evidence"):
        sim.promote_delivery("dl-302", "TEST")
    assert next(d for d in sim.deliveries if d.id == "dl-302").status == "ACCEPTED"  # stays pending


def test_delivery_lifecycle_is_ordered(sim):
    # Cannot skip: PROD directly from ACCEPTED is refused even WITH evidence.
    with pytest.raises(PermissionError, match="TEST_QUALIFIED"):
        sim.promote_delivery("dl-301", "PROD")
    assert sim.promote_delivery("dl-301", "TEST")["delivery"]["status"] == "TEST_QUALIFIED"
    assert sim.promote_delivery("dl-301", "PROD")["delivery"]["status"] == "DELIVERED"
    assert sim.promote_delivery("dl-301", "CLOSE")["delivery"]["status"] == "CLOSED"
    with pytest.raises(PermissionError):  # terminal
        sim.promote_delivery("dl-301", "CLOSE")


def test_delivery_is_not_deployment_and_not_every_accept_ships(sim):
    # ACCEPTED != DELIVERED != CLOSED are distinct states; a fresh delivery sits at ACCEPTED
    statuses = {d.status for d in sim.deliveries}
    assert "ACCEPTED" in statuses
    assert "DELIVERED" not in statuses and "CLOSED" not in statuses
