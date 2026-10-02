"""CI/CD Studio views — Praxis Delivery semantics over the domain snapshot.

Data source TODAY is the deterministic simulator; every payload carries
``source: "simulated"`` and the UI stamps it. When praxisd exposes lifecycle
queries over ACP the same functions switch their reader — the source field
is the seam.

Domain rails this module enforces (they come from PraxisCode, not taste):
UNKNOWN is never FAILED (it renders neutral and says why), Delivery ≠
Deployment, TEST capability is not Production capability (E13: without real
MES TEST evidence the qualification stays pending), and every lifecycle step
carries its Evidence provenance chain (6 levels).
"""

from __future__ import annotations

from kiro_crew.apps.builtins.praxis_insight.backend.simulator import (
    EVIDENCE_LEVELS,
    PraxisSimulator,
)

#: delivery lifecycle rails, in order
DELIVERY_STAGES = ["ACCEPTED", "TEST_QUALIFIED", "DELIVERED", "CLOSED"]

#: E11-B5 DeploymentAdapter seam surface
ADAPTER_SEAM = [
    {
        "operation": "observe",
        "contract": "idempotent read of deployment world-state; never mutates",
        "failureMode": "observation gap → UNKNOWN (reconciliation cursor advances, no FAILED)",
    },
    {
        "operation": "apply",
        "contract": "mutating effect executed exactly once per accepted ChangeSet revision",
        "failureMode": "partial apply → RECOVERY_REQUIRED with journal replay from the durable Operation log",
    },
    {
        "operation": "failure-mode",
        "contract": "declared per adapter: crash window, retry policy, reconciliation command",
        "failureMode": "undeclared failure-mode is a specification defect, surfaced as divergence warning",
    },
]

_SIM = PraxisSimulator()


def _stage_index(status: str) -> int:
    try:
        return DELIVERY_STAGES.index(status)
    except ValueError:
        return 0


def pipeline() -> dict:
    snap = _SIM.snapshot()
    works_by_stage: dict[str, list[dict]] = {}
    for w in snap["works"]:
        works_by_stage.setdefault(w["status"], []).append(w)
    return {
        "source": "simulated",
        "statusWords": snap["statusWords"],
        "evidenceLevels": list(EVIDENCE_LEVELS),
        "unknownIsNotFailed": True,
        "deliveryStages": DELIVERY_STAGES,
        "worksByStage": works_by_stage,
        "works": snap["works"],
        "runs": snap["runs"],
        "changesets": snap["changesets"],
        "deliveries": snap["deliveries"],
        "unknowns": snap["unknowns"],
        "evidence": snap.get("evidence", []),
        "hardGates": [
            {
                "id": "E13-TEST-QUALIFICATION",
                "statement": "TEST capability does not imply Production capability; without real MES TEST evidence the qualification stays pending",
            },
            {
                "id": "E13-PILOT",
                "statement": "Pilot must not be proven with Production mutations",
            },
            {
                "id": "E06-MUTATING-EFFECTS",
                "statement": "no real mutating git/DB/SSH/deploy effect handlers before E06 Human acceptance",
            },
        ],
    }


def delivery_timeline(delivery_id: str) -> dict:
    snap = _SIM.snapshot()
    d = next((x for x in snap["deliveries"] if x["id"] == delivery_id), None)
    if d is None:
        raise KeyError(delivery_id)
    cs = next((c for c in snap["changesets"] if c["id"] == d["changesetId"]), None)
    idx = _stage_index(d["status"])
    stages = []
    for i, stage in enumerate(DELIVERY_STAGES):
        stages.append(
            {
                "stage": stage,
                "reached": i <= idx,
                "current": i == idx,
                "gate": _stage_gate(stage, d),
            }
        )
    qualification_pending = not d.get("hasTestEvidence") and d["status"] in (
        "ACCEPTED",
        "TEST_QUALIFIED",
    )
    return {
        "source": "simulated",
        "delivery": d,
        "changeset": cs,
        "stages": stages,
        "qualificationPending": qualification_pending,
        "qualificationNote": (
            "E13 hard gate: no real MES TEST evidence — qualification stays pending; TEST capability is not Production capability"
            if qualification_pending
            else ""
        ),
        "evidenceChain": [e for e in snap.get("evidence", [])],
    }


def _stage_gate(stage: str, d: dict) -> dict:
    if stage == "TEST_QUALIFIED":
        return {
            "id": "E13-TEST",
            "state": "satisfied" if d.get("hasTestEvidence") else "pending",
            "requires": "real MES TEST evidence",
        }
    if stage == "DELIVERED":
        return {
            "id": "E13-PROD",
            "state": "satisfied" if d.get("hasTestEvidence") else "blocked",
            "requires": "TEST qualification with real evidence before Production",
        }
    return {"id": None, "state": "open", "requires": ""}


def changeset_view(changeset_id: str) -> dict:
    snap = _SIM.snapshot()
    cs = next((c for c in snap["changesets"] if c["id"] == changeset_id), None)
    if cs is None:
        raise KeyError(changeset_id)
    delivery = next((d for d in snap["deliveries"] if d["changesetId"] == changeset_id), None)
    return {
        "source": "simulated",
        "changeset": cs,
        "delivery": delivery,
        "divergenceWarning": cs.get("divergence") or None,
        "topology": {
            "nodes": [
                {"id": cs["id"], "kind": "changeset", "label": cs["title"]},
                *[{"id": r["repo"], "kind": "repo", "label": r["repo"]} for r in cs["repos"]],
                *[
                    {"id": wt, "kind": "worktree", "label": wt.rsplit("/", 1)[-1]}
                    for wt in cs.get("worktrees", [])
                ],
            ],
            "edges": [
                *[{"from": cs["id"], "to": r["repo"], "kind": "repo-change"} for r in cs["repos"]],
                *[
                    {"from": wt, "to": cs["id"], "kind": "worktree-of"}
                    for wt in cs.get("worktrees", [])
                ],
            ],
        },
    }


def adapter_view() -> dict:
    snap = _SIM.snapshot()
    # failure/restart timeline reconstruction from runs + unknowns: each
    # UNKNOWN run is a crash-window candidate with its reconciliation state
    timeline = []
    for r in snap["runs"]:
        if r["status"] in ("UNKNOWN", "RECOVERY_REQUIRED", "STALE"):
            u = next(
                (
                    x
                    for x in snap["unknowns"]
                    if x.get("operationId", "").startswith(r["id"].rsplit("-", 1)[-1])
                ),
                None,
            )
            timeline.append(
                {
                    "runId": r["id"],
                    "status": r["status"],
                    "note": "UNKNOWN ≠ FAILED — awaiting reconciliation, not marked failed",
                    "lastFact": (u or {}).get("lastFact", ""),
                    "reconciliation": (u or {}).get("reconciliation", ""),
                    "safeCommand": (u or {}).get("safeCommand", ""),
                }
            )
    return {
        "source": "simulated",
        "seam": ADAPTER_SEAM,
        "e11b5": {
            "chapter": "E11-B5",
            "statement": "DeploymentAdapter seam: observe / apply / failure-mode as the boundary Praxis owns; failure and restart timelines are RECONSTRUCTED from the durable Operation log, never assumed",
        },
        "timeline": timeline,
    }


def advance_work(work_id: str) -> dict:
    return _SIM.advance_work(work_id)


def promote_delivery(delivery_id: str, action: str) -> dict:
    return _SIM.promote_delivery(delivery_id, action)
