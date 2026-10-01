"""Praxis domain simulator — the data seam behind Praxis Insight.

THE CONTRACT THIS MODULE STANDS IN FOR
======================================
PraxisCode's accepted specification defines a durable, semantically precise
domain model owned by the Rust daemon ``praxisd`` (the single authoritative
writer). Until that daemon ships its query surface, this module serves a
DETERMINISTIC simulation of the same model so the Kiro Crew dashboard can
exercise every unique capability:

* the 13-word lifecycle vocabulary, never collapsed (UNKNOWN is its own
  state, distinct from FAILED);
* approvals whose scope is EXACT (paths/resources/duration) and whose refusal
  consequence is named, because a refusal without a consequence statement is
  a decision made blind;
* Evidence with six-level provenance — what was OBSERVED versus what an
  agent INFERRED is a fact about trust, and the UI must never flatten it;
* Work as durable truth that OUTLIVES any conversation, run, or session.

SWAPPING IN THE REAL DAEMON
===========================
Replace the three ``load_*`` entry points with queries against praxisd
(ACP session tools, or the daemon's local IPC once it exposes one). The JSON
shapes returned here are the contract the UI is written against — keep them,
or version them deliberately. Every mutation handler below is already a
single-purpose method (decide_approval / advance_work), so the real backend
maps one-to-one.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ── The vocabulary: frozen, never collapsed ──────────────────────────────────

#: The thirteen lifecycle states from the accepted specification. The UI maps
#: each to its own visual treatment; nothing here may be merged, aliased, or
#: "simplified" — a state that cannot be named cannot be governed.
STATUS_WORDS: tuple[str, ...] = (
    "READY",
    "RUNNING",
    "WAITING",
    "WAITING_HUMAN",
    "BLOCKED",
    "PAUSED",
    "VERIFYING",
    "FAILED",
    "UNKNOWN",
    "RECOVERY_REQUIRED",
    "STALE",
    "ACCEPTED",
    "DELIVERED",
)

#: Evidence provenance levels, weakest to strongest authority. The level is a
#: property of HOW the fact is known, not of whether it is pleasant.
EVIDENCE_LEVELS: tuple[str, ...] = (
    "external_observation",
    "product_fact",
    "agent_inference",
    "hypothesis",
    "unknown",
    "verification_result",
)


@dataclass
class WorkItemSim:
    id: str
    title: str
    status: str = "READY"

    def to_json(self) -> dict:
        return {"id": self.id, "title": self.title, "status": self.status}


@dataclass
class WorkSim:
    id: str
    title: str
    goal: str
    status: str
    work_items: list[WorkItemSim] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "goal": self.goal,
            "status": self.status,
            "workItems": [wi.to_json() for wi in self.work_items],
        }


@dataclass
class ApprovalSim:
    id: str
    title: str
    #: EXACT scope: what the approval covers, itemized. An approval that does
    #: not name its scope is consent to everything.
    scope_paths: list[str]
    scope_resources: list[str]
    duration_minutes: int
    ask: str
    #: What happens on refusal — the operator decides with the consequence in
    #: view, not as a surprise afterwards.
    refusal_consequence: str
    decision: str | None = None  # None = pending; "accepted" | "rejected"

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "scope": {"paths": self.scope_paths, "resources": self.scope_resources},
            "durationMinutes": self.duration_minutes,
            "ask": self.ask,
            "refusalConsequence": self.refusal_consequence,
            "decision": self.decision,
        }


@dataclass
class AgentRunSim:
    id: str
    work_id: str
    agent: str
    status: str
    epochs: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "workId": self.work_id,
            "agent": self.agent,
            "status": self.status,
            "epochs": self.epochs,
        }


@dataclass
class EvidenceSim:
    id: str
    work_id: str
    title: str
    level: str

    def to_json(self) -> dict:
        return {"id": self.id, "workId": self.work_id, "title": self.title, "level": self.level}


@dataclass
class CandidateRevisionSim:
    """One revision in a candidate's lineage.

    The CANDIDATE identity is stable across rebases; the COMMIT it points at
    is not. Working State, RepoChange, CandidateRevision and Commit/PR/Branch
    are four different identities in the Praxis model and none may be collapsed
    into another.
    """

    id: str
    parent_id: str | None
    commit_sha: str
    note: str = ""

    def to_json(self) -> dict:
        return {"id": self.id, "parentId": self.parent_id, "commitSha": self.commit_sha, "note": self.note}


@dataclass
class RepoChangeSim:
    """A ChangeSet's projection into ONE repository."""

    repo: str
    base: str
    candidate_id: str
    revisions: list[CandidateRevisionSim] = field(default_factory=list)

    @property
    def head(self) -> CandidateRevisionSim:
        return self.revisions[-1]

    def to_json(self) -> dict:
        return {
            "repo": self.repo,
            "base": self.base,
            "candidateId": self.candidate_id,
            "headCommit": self.head.commit_sha,
            "revisions": [r.to_json() for r in self.revisions],
        }


@dataclass
class ChangeSetSim:
    """A cross-repository change as ONE atomic semantic unit.

    Its fork is a managed WORKTREE SET (one per repository), not a social
    GitHub fork: an isolated execution environment owned by the change. A
    ChangeSet whose repos have drifted apart is DIVERGED, and divergence is
    adjudicated EXPLICITLY — never silently rebased away.
    """

    id: str
    title: str
    status: str  # OPEN | DIVERGED | RECONCILED | MERGED | CLOSED
    repos: list[RepoChangeSim] = field(default_factory=list)
    worktrees: list[str] = field(default_factory=list)
    divergence: str | None = None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "repos": [rc.to_json() for rc in self.repos],
            "worktrees": self.worktrees,
            "divergence": self.divergence,
        }


@dataclass
class DeliverySim:
    """The delivery lifecycle of a ChangeSet.

    Delivery is NOT deployment, ACCEPTED is not DELIVERED, and DELIVERED is
    not Closed. PROD promotion requires REAL TEST evidence; without it the
    delivery must STAY qualification-pending (E13 hard gate).
    """

    id: str
    changeset_id: str
    status: str  # ACCEPTED | TEST_QUALIFIED | DELIVERED | CLOSED
    has_test_evidence: bool

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "changesetId": self.changeset_id,
            "status": self.status,
            "hasTestEvidence": self.has_test_evidence,
        }


@dataclass
class UnknownSim:
    operation_id: str
    last_fact: str
    reason: str
    reconciliation: str
    safe_command: str

    def to_json(self) -> dict:
        return {
            "operationId": self.operation_id,
            "lastFact": self.last_fact,
            "reason": self.reason,
            "reconciliation": self.reconciliation,
            "safeCommand": self.safe_command,
        }


#: The single lifecycle edge set. Advances are legal moves only; an illegal
#: advance is refused (and surfaced), not silently clamped.
_LIFECYCLE: dict[str, str | None] = {
    "READY": "RUNNING",
    "RUNNING": "VERIFYING",
    "WAITING": "RUNNING",
    "WAITING_HUMAN": "RUNNING",
    "BLOCKED": "RECOVERY_REQUIRED",
    "PAUSED": "RUNNING",
    "VERIFYING": "ACCEPTED",
    "FAILED": "RECOVERY_REQUIRED",
    "UNKNOWN": "RECOVERY_REQUIRED",
    "RECOVERY_REQUIRED": "READY",
    "STALE": "RECOVERY_REQUIRED",
    "ACCEPTED": "DELIVERED",
    "DELIVERED": None,
}


class PraxisSimulator:
    """Deterministic in-memory Praxis domain. One instance per gateway."""

    def __init__(self) -> None:
        self.works = [
            WorkSim(
                id="w-012",
                title="审批作用域精确绑定",
                goal="审批从全仓授权收紧为精确范围授权，每张审批卡列出路径/资源/时长与拒绝后果。",
                status="WAITING_HUMAN",
                work_items=[
                    WorkItemSim("wi-1", "梳理 approval scope 数据模型", "ACCEPTED"),
                    WorkItemSim("wi-2", "ApprovalLease ≠ ResourceLease 语义对齐", "ACCEPTED"),
                    WorkItemSim("wi-3", "审批卡信息结构与渲染", "VERIFYING"),
                    WorkItemSim("wi-4", "负路径测试：拒绝后果展示", "RUNNING"),
                ],
            ),
            WorkSim(
                id="w-015",
                title="密钥告警误报修复",
                goal="区分「密钥缺失」与「未装载」，UNKNOWN 期间不得标记为失败。",
                status="UNKNOWN",
                work_items=[
                    WorkItemSim("wi-5", "复现误报路径", "ACCEPTED"),
                    WorkItemSim("wi-6", "告警分类拆分", "STALE"),
                ],
            ),
            WorkSim(
                id="w-021",
                title="E09 证据归档",
                goal="证据链归档与索引更新，六级来源可辨。",
                status="DELIVERED",
                work_items=[WorkItemSim("wi-7", "证据 74–87 编目", "ACCEPTED")],
            ),
        ]
        self.approvals = [
            ApprovalSim(
                id="ap-2041",
                title="写操作授权 · git commit（worktree）",
                scope_paths=[
                    "backend/20260929-01-审批作用域精确绑定",
                    "rust/praxis-approval/src/scope.rs",
                ],
                scope_resources=["praxisd 配置快照（只读）"],
                duration_minutes=30,
                ask="授权 Agent 在上述范围内执行 git commit。",
                refusal_consequence="拒绝后本对话的变更提交停留在暂存区，不影响其他 Work。",
            ),
            ApprovalSim(
                id="ap-2044",
                title="读取授权 · 工作区文件",
                scope_paths=["engineering/control/current.yaml"],
                scope_resources=[],
                duration_minutes=10,
                ask="授权读取配置快照以对齐审批作用域语义。",
                refusal_consequence="拒绝后 Agent 以脱敏摘要继续，结论置信度下降。",
            ),
        ]
        self.runs = [
            AgentRunSim("r-3301", "w-012", "GLM-5.3 · worker-1", "WAITING_HUMAN", ["epoch-a1", "epoch-a2"]),
            AgentRunSim("r-3298", "w-015", "GLM-5.3 · worker-2", "UNKNOWN", ["epoch-b1"]),
            AgentRunSim("r-3290", "w-015", "worker-3", "RUNNING", ["epoch-c1", "epoch-c2"]),
            AgentRunSim("r-3265", "w-021", "worker-1", "DELIVERED", ["epoch-d1"]),
        ]
        self.changesets = [
            ChangeSetSim(
                id="cs-101",
                title="跨仓审批卡改造",
                status="OPEN",
                repos=[
                    RepoChangeSim(
                        repo="praxiscode",
                        base="main",
                        candidate_id="cr-7",
                        revisions=[
                            CandidateRevisionSim("r-7.1", None, "abc1234", "初稿"),
                            CandidateRevisionSim("r-7.2", "r-7.1", "9f01e2d", "语义对齐后 rebase"),
                        ],
                    ),
                    RepoChangeSim(
                        repo="praxis-web",
                        base="main",
                        candidate_id="cr-8",
                        revisions=[CandidateRevisionSim("r-8.1", None, "77c0ffe", "审批卡渲染")],
                    ),
                ],
                worktrees=[".worktrees/cs-101/praxiscode", ".worktrees/cs-101/praxis-web"],
            ),
            ChangeSetSim(
                id="cs-102",
                title="API 契约同步",
                status="DIVERGED",
                repos=[
                    RepoChangeSim(
                        repo="praxiscode",
                        base="main",
                        candidate_id="cr-9",
                        revisions=[
                            CandidateRevisionSim("r-9.1", None, "3ab99de", "契约更新"),
                            CandidateRevisionSim("r-9.2", "r-9.1", "5d2c8aa", "已 rebase 到新契约"),
                        ],
                    ),
                    RepoChangeSim(
                        repo="praxis-web",
                        base="main",
                        candidate_id="cr-10",
                        revisions=[CandidateRevisionSim("r-10.1", None, "0ld444b", "仍基于旧契约基线")],
                    ),
                ],
                worktrees=[".worktrees/cs-102/praxiscode", ".worktrees/cs-102/praxis-web"],
                divergence="praxiscode 候选已 rebase 到新契约，praxis-web 候选仍基于旧基线——跨仓一致性破坏，须显式裁决，不得静默合并。",
            ),
        ]
        self.deliveries = [
            DeliverySim(id="dl-301", changeset_id="cs-101", status="ACCEPTED", has_test_evidence=True),
            DeliverySim(id="dl-302", changeset_id="cs-102", status="ACCEPTED", has_test_evidence=False),
        ]
        self.evidence = [
            EvidenceSim("ev-1", "w-012", "E06-B2 审批契约章节", "product_fact"),
            EvidenceSim("ev-2", "w-012", "作用域降级影响面清单", "agent_inference"),
            EvidenceSim("ev-3", "w-015", "keyring 平台差异记录", "external_observation"),
            EvidenceSim("ev-4", "w-015", "丢失事件原因", "unknown"),
            EvidenceSim("ev-5", "w-021", "索引完整性检查", "verification_result"),
            EvidenceSim("ev-6", "w-012", "存量审批可自动收敛假设", "hypothesis"),
        ]
        self.unknowns = [
            UnknownSim(
                operation_id="op-8831",
                last_fact="deployment probe 返回 504，此后无后续事件",
                reason="daemon 重启窗口内事件丢失，无 reconciliation 记录",
                reconciliation="等待对账游标推进（已重试 3/5）",
                safe_command="查看 Operation 时间线 · 保持 UNKNOWN，不标记为失败",
            )
        ]

    # ── Reads (the shape the UI is written against) ──────────────────────────

    def snapshot(self) -> dict:
        return {
            "statusWords": list(STATUS_WORDS),
            "evidenceLevels": list(EVIDENCE_LEVELS),
            "works": [w.to_json() for w in self.works],
            "approvals": [a.to_json() for a in self.approvals],
            "runs": [r.to_json() for r in self.runs],
            "changesets": [c.to_json() for c in self.changesets],
            "deliveries": [d.to_json() for d in self.deliveries],
            "evidence": [e.to_json() for e in self.evidence],
            "unknowns": [u.to_json() for u in self.unknowns],
        }

    # ── Mutations (each maps one-to-one onto a future praxisd command) ──────

    def resolve_divergence(self, changeset_id: str, decision: str) -> dict:
        """Adjudicate a DIVERGED ChangeSet explicitly.

        ``rebase`` re-seats the stale repos onto the advanced candidate's base
        (a NEW revision under the SAME candidate id — identity is stable, the
        commit is not); ``accept`` adopts the advanced state as-is; ``reject``
        closes the ChangeSet without merging. A non-diverged ChangeSet has
        nothing to adjudicate and is refused.
        """
        if decision not in ("rebase", "accept", "reject"):
            raise ValueError("decision must be 'rebase' | 'accept' | 'reject'")
        cs = next((c for c in self.changesets if c.id == changeset_id), None)
        if cs is None:
            raise KeyError(changeset_id)
        if cs.status != "DIVERGED" or not cs.divergence:
            raise PermissionError(f"changeset {changeset_id} is not diverged")
        if decision == "reject":
            cs.status = "CLOSED"
        else:
            if decision == "rebase":
                advanced = max(cs.repos, key=lambda rc: len(rc.revisions))
                for rc in cs.repos:
                    if rc is advanced:
                        continue
                    parent = rc.head.id
                    rc.revisions.append(
                        CandidateRevisionSim(
                            id=f"{rc.candidate_id}.sync",
                            parent_id=parent,
                            commit_sha=f"syn{rc.head.commit_sha[-4:]}",
                            note=f"rebase 到 {advanced.candidate_id} 的新基线",
                        )
                    )
            cs.status = "RECONCILED"
        cs.divergence = None
        return {"changeset": cs.to_json()}

    def sync_fork(self, changeset_id: str) -> dict:
        """Pull upstream base into the ChangeSet's worktree set.

        The fork syncs; the CANDIDATE identity does not move. Each repo gains
        one revision under its existing candidate id.
        """
        cs = next((c for c in self.changesets if c.id == changeset_id), None)
        if cs is None:
            raise KeyError(changeset_id)
        if cs.status == "CLOSED":
            raise PermissionError(f"changeset {changeset_id} is closed")
        for rc in cs.repos:
            rc.revisions.append(
                CandidateRevisionSim(
                    id=f"{rc.candidate_id}.f{len(rc.revisions) + 1}",
                    parent_id=rc.head.id,
                    commit_sha=f"f{len(rc.revisions) + 1:04d}{rc.head.commit_sha[-3:]}",
                    note="fork 同步上游基线",
                )
            )
        return {"changeset": cs.to_json()}

    def promote_delivery(self, delivery_id: str, action: str) -> dict:
        """Advance a delivery along ACCEPTED -> TEST_QUALIFIED -> DELIVERED -> CLOSED.

        The E13 hard gate, enforced structurally: TEST promotion requires REAL
        test evidence — without it the delivery must STAY qualification
        pending (a PermissionError, never a silent skip); PROD promotion
        requires TEST_QUALIFIED; and a delivery whose ChangeSet is DIVERGED
        cannot promote at all, because cross-repo consistency is a
        precondition of shipping, not a nice-to-have.
        """
        if action not in ("TEST", "PROD", "CLOSE"):
            raise ValueError("action must be 'TEST' | 'PROD' | 'CLOSE'")
        dl = next((d for d in self.deliveries if d.id == delivery_id), None)
        if dl is None:
            raise KeyError(delivery_id)
        cs = next(c for c in self.changesets if c.id == dl.changeset_id)
        if action == "CLOSE":
            if dl.status != "DELIVERED":
                raise PermissionError(f"delivery {delivery_id} is {dl.status}; only DELIVERED closes")
            dl.status = "CLOSED"
            return {"delivery": dl.to_json()}
        if cs.status == "DIVERGED":
            raise PermissionError(
                f"changeset {cs.id} is diverged; adjudicate the divergence before promoting"
            )
        if action == "TEST":
            if dl.status != "ACCEPTED":
                raise PermissionError(f"delivery {delivery_id} is {dl.status}, not ACCEPTED")
            if not dl.has_test_evidence:
                raise PermissionError(
                    f"delivery {delivery_id} has no real TEST evidence; qualification stays pending"
                )
            dl.status = "TEST_QUALIFIED"
        else:  # PROD
            if dl.status != "TEST_QUALIFIED":
                raise PermissionError(f"delivery {delivery_id} is {dl.status}; PROD needs TEST_QUALIFIED")
            dl.status = "DELIVERED"
        return {"delivery": dl.to_json()}

    def decide_approval(self, approval_id: str, decision: str) -> dict:
        if decision not in ("accepted", "rejected"):
            raise ValueError("decision must be 'accepted' or 'rejected'")
        approval = next((a for a in self.approvals if a.id == approval_id), None)
        if approval is None:
            raise KeyError(approval_id)
        if approval.decision is not None:
            # Decisions are durable: a decided approval is not re-decidable.
            raise PermissionError(f"approval {approval_id} already {approval.decision}")
        approval.decision = decision
        # An accepted approval unblocks the human-gated work it belongs to;
        # a rejection leaves that work waiting — with the consequence stated.
        if approval.id == "ap-2041":
            work = next(w for w in self.works if w.id == "w-012")
            work.status = "RUNNING" if decision == "accepted" else "BLOCKED"
        return {"approval": approval.to_json()}

    def advance_work(self, work_id: str) -> dict:
        work = next((w for w in self.works if w.id == work_id), None)
        if work is None:
            raise KeyError(work_id)
        nxt = _LIFECYCLE.get(work.status)
        if nxt is None:
            raise PermissionError(f"work {work_id} is DELIVERED; nothing follows it")
        work.status = nxt
        return {"work": work.to_json()}
