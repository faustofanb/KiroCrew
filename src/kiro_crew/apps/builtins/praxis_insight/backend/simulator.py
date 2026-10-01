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
            "evidence": [e.to_json() for e in self.evidence],
            "unknowns": [u.to_json() for u in self.unknowns],
        }

    # ── Mutations (each maps one-to-one onto a future praxisd command) ──────

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
