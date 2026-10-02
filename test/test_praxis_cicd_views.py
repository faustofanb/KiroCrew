"""CI/CD Studio view tests — the domain rails that cannot drift."""

from __future__ import annotations

import pytest

from kiro_crew.apps.builtins.praxis_cicd.backend import views


@pytest.fixture(scope="module")
def pipe():
    return views.pipeline()


def test_source_is_stamped_simulated(pipe):
    assert pipe["source"] == "simulated"


def test_thirteen_word_vocabulary_with_unknown_distinct(pipe):
    words = pipe["statusWords"]
    assert len(words) == 13 and len(set(words)) == 13
    assert "UNKNOWN" in words and "FAILED" in words


def test_six_evidence_levels(pipe):
    assert len(pipe["evidenceLevels"]) == 6


def test_delivery_stage_rails_and_e13_gate(pipe):
    assert pipe["deliveryStages"] == ["ACCEPTED", "TEST_QUALIFIED", "DELIVERED", "CLOSED"]
    gates = {g["id"] for g in pipe["hardGates"]}
    assert "E13-TEST-QUALIFICATION" in gates


def test_qualification_pending_without_real_test_evidence():
    # dl-302 has no test evidence → pending + explicit E13 note
    t = views.delivery_timeline("dl-302")
    assert t["qualificationPending"] is True
    assert "E13" in t["qualificationNote"]
    # dl-301 carries evidence → not pending
    t1 = views.delivery_timeline("dl-301")
    assert t1["qualificationPending"] is False


def test_unknown_is_never_a_failure_stage():
    t = views.adapter_view()
    for entry in t["timeline"]:
        if entry["status"] == "UNKNOWN":
            assert "not marked failed" in entry["note"]


def test_adapter_seam_surface():
    a = views.adapter_view()
    ops = [s["operation"] for s in a["seam"]]
    assert ops == ["observe", "apply", "failure-mode"]
    assert a["e11b5"]["chapter"] == "E11-B5"


def test_changeset_topology_is_atomic_unit():
    cs = views.changeset_view("cs-101")
    kinds = {n["kind"] for n in cs["topology"]["nodes"]}
    assert {"changeset", "repo"} <= kinds
    assert all(e["kind"] in ("repo-change", "worktree-of") for e in cs["topology"]["edges"])
