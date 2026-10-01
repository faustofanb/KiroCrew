# Praxis 域语义技能

## 何时使用
当涉及 Work/WorkItem/审批/Evidence/ChangeSet/Delivery/状态转换时。

## 13 状态词（不可合并）

```
READY → RUNNING → VERIFYING → ACCEPTED → DELIVERED
                ↘ WAITING → RUNNING
                ↘ WAITING_HUMAN → RUNNING
                ↘ BLOCKED → RECOVERY_REQUIRED → READY
                ↘ PAUSED → RUNNING
                ↘ FAILED → RECOVERY_REQUIRED
                ↘ UNKNOWN → RECOVERY_REQUIRED
                ↘ STALE → RECOVERY_REQUIRED
```

- **UNKNOWN ≠ FAILED**：UNKNOWN 是对账中的独立状态，不标记为失败
- 状态词必须保留英文原文+中文注解，不可缩写

## Evidence 六级来源

| 级别 | 含义 | 信任度 |
|---|---|---|
| 外部观测 (external_observation) | 系统外部直接观测到的 | 最高 |
| 产品事实 (product_fact) | 产品自身持久化的 | 高 |
| Agent 推断 (agent_inference) | AI 推理得出的 | 中 |
| 假设 (hypothesis) | 待验证的 | 低 |
| 未知 (unknown) | 来源不明 | 最低 |
| 验证结果 (verification_result) | 已验证的 | 与验证方法同等级 |

## 审批语义

- 每张审批卡包含：**精确路径**、**资源**、**租约时长**、**拒绝后果**
- 审批通过与作用域绑定，不是全仓授权
- 拒绝必须有后果说明

## 身份不折叠

```
Work ≠ WorkItem ≠ Assignment ≠ AgentRun ≠ RunEpoch
Repository ≠ RepositoryInstance ≠ Worktree
Working State ≠ RepoChange ≠ CandidateRevision ≠ Commit/PR/Branch
Artifact ≠ Evidence ≠ Verification
Delivery ≠ Deployment
```

## ChangeSet（跨仓变更）

- ChangeSet 是跨仓库的原子语义单元
- 其 fork = 受管 worktree 集（每仓一个，非 GitHub fork）
- 分歧 (DIVERGED) 必须显式裁决（rebase/accept/reject），不可静默合并

## Delivery（CI/CD）

- `ACCEPTED → TEST_QUALIFIED → DELIVERED → CLOSED`
- PROD 需要真实 TEST 证据，缺失则保持 qualification pending
- 分歧未裁决的 ChangeSet 不得交付
