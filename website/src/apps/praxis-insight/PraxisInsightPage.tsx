/**
 * Praxis Insight — the PraxisCode domain model as a first-class dashboard page.
 *
 * Sections, each a unique Praxis capability:
 *  1. UNKNOWN banner — UNKNOWN is its own state with five reconciliation facts.
 *  2. Approval inbox — exact scope (paths/resources/duration) + refusal consequence.
 *  3. Work board — durable Work/WorkItem truth with the 13-word vocabulary.
 *  4. AgentRun/RunEpoch tracking.
 *  5. Evidence with six-level provenance, never flattened.
 */
import { useCallback, useEffect, useState } from 'react'

type StatusWord =
  | 'READY' | 'RUNNING' | 'WAITING' | 'WAITING_HUMAN' | 'BLOCKED' | 'PAUSED'
  | 'VERIFYING' | 'FAILED' | 'UNKNOWN' | 'RECOVERY_REQUIRED' | 'STALE'
  | 'ACCEPTED' | 'DELIVERED'

type Snapshot = {
  statusWords: StatusWord[]
  evidenceLevels: string[]
  works: {
    id: string
    title: string
    goal: string
    status: StatusWord
    workItems: { id: string; title: string; status: StatusWord }[]
  }[]
  approvals: {
    id: string
    title: string
    scope: { paths: string[]; resources: string[] }
    durationMinutes: number
    ask: string
    refusalConsequence: string
    decision: 'accepted' | 'rejected' | null
  }[]
  runs: { id: string; workId: string; agent: string; status: StatusWord; epochs: string[] }[]
  evidence: { id: string; workId: string; title: string; level: string }[]
  unknowns: {
    operationId: string
    lastFact: string
    reason: string
    reconciliation: string
    safeCommand: string
  }[]
}

/** One visual treatment per word. No two words share a color — a state that
 *  cannot be told apart at a glance gets collapsed in the operator's head. */
const STATUS_STYLE: Record<StatusWord, string> = {
  READY: 'text-muted border-border',
  RUNNING: 'text-accent border-accent',
  WAITING: 'text-muted border-border-strong',
  WAITING_HUMAN: 'text-warn border-warn',
  BLOCKED: 'text-text-strong border-border-strong',
  PAUSED: 'text-muted border-border/60',
  VERIFYING: 'text-info border-info',
  FAILED: 'text-danger border-danger',
  UNKNOWN: 'text-warn border-warn border-dashed',
  RECOVERY_REQUIRED: 'text-danger border-warn',
  STALE: 'text-muted border-border/60',
  ACCEPTED: 'text-ok border-ok',
  DELIVERED: 'text-ok border-ok border-2',
}

const STATUS_ZH: Record<StatusWord, string> = {
  READY: '就绪', RUNNING: '运行中', WAITING: '等待', WAITING_HUMAN: '等待人工',
  BLOCKED: '阻塞', PAUSED: '暂停', VERIFYING: '验证中', FAILED: '失败',
  UNKNOWN: '未知', RECOVERY_REQUIRED: '需恢复', STALE: '过期',
  ACCEPTED: '已接受', DELIVERED: '已交付',
}

const EVIDENCE_STYLE: Record<string, string> = {
  external_observation: 'text-info border-info',
  product_fact: 'text-ok border-ok',
  agent_inference: 'text-aim border-aim',
  hypothesis: 'text-warn border-warn',
  unknown: 'text-warn border-warn border-dashed',
  verification_result: 'text-accent border-accent',
}

const EVIDENCE_ZH: Record<string, string> = {
  external_observation: '外部观测', product_fact: '产品事实', agent_inference: 'Agent 推断',
  hypothesis: '假设', unknown: '未知', verification_result: '验证结果',
}

function StatusChip({ status }: { status: StatusWord }) {
  return (
    <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] tracking-wide ${STATUS_STYLE[status]}`}>
      {status}
      <span className="ml-1 font-sans text-[9px] opacity-70">{STATUS_ZH[status]}</span>
    </span>
  )
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5 flex items-baseline gap-2">
      <h2 className="text-[15px] font-semibold text-text-strong">{children}</h2>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  )
}

export default function PraxisInsightPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch('/api/apps/praxis-insight/state')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setSnap(d); setError(null) })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => { load() }, [load])

  const decide = (id: string, decision: 'accepted' | 'rejected') => {
    setBusy(`${id}:${decision}`)
    fetch(`/api/apps/praxis-insight/approvals/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error ?? `HTTP ${r.status}`)))))
      .then(() => load())
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null))
  }

  const advance = (id: string) => {
    setBusy(`${id}:advance`)
    fetch(`/api/apps/praxis-insight/works/${id}/advance`, { method: 'POST' })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error ?? `HTTP ${r.status}`)))))
      .then(() => load())
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null))
  }

  if (error && !snap) {
    return (
      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-4">
        <div className="rounded-md border border-danger bg-danger-subtle p-4 text-sm text-danger">
          Praxis Insight 加载失败：{error}
          <button className="ml-3 underline" onClick={load}>重试</button>
        </div>
      </div>
    )
  }
  if (!snap) {
    return <div className="flex-1 px-6 pt-4 text-sm text-muted">Praxis Insight 加载中…</div>
  }

  const pending = snap.approvals.filter((a) => a.decision === null)
  const decided = snap.approvals.filter((a) => a.decision !== null)

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-10">
      <div className="flex items-baseline gap-3 pt-4 pb-5">
        <h1 className="text-xl font-semibold text-text-strong">Praxis Insight</h1>
        <span className="text-[12px] text-muted">PraxisCode 域语义驾驶舱 · Work 是真值，对话只是交互面</span>
        <button className="ml-auto rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-bg-hover" onClick={load}>刷新</button>
      </div>
      {error && (
        <div className="mb-4 rounded-md border border-warn bg-warn-subtle px-3 py-2 text-[12px] text-warn">{error}</div>
      )}

      {/* 1. UNKNOWN banner — the capability generic chat UIs flatten away */}
      {snap.unknowns.map((u) => (
        <div key={u.operationId} className="mb-6 rounded-lg border border-dashed border-warn bg-warn-subtle p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded border border-warn bg-bg px-1.5 py-0.5 font-mono text-[10px] text-warn">UNKNOWN · {u.operationId}</span>
            <span className="text-[11px] text-muted">未知不是失败 —— 对账期间保持独立状态</span>
          </div>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
            <dt className="text-muted">最后事实</dt><dd>{u.lastFact}</dd>
            <dt className="text-muted">不确定原因</dt><dd>{u.reason}</dd>
            <dt className="text-muted">对账状态</dt><dd>{u.reconciliation}</dd>
            <dt className="text-muted">安全命令</dt><dd className="text-text-strong">{u.safeCommand}</dd>
          </dl>
        </div>
      ))}

      {/* 2. Approval inbox */}
      <section className="mb-6">
        <SectionTitle hint="精确范围 · 拒绝有后果">需要我 · 审批收件箱</SectionTitle>
        {pending.length === 0 && <p className="text-[12.5px] text-muted">没有待审批事项。</p>}
        {pending.map((a) => (
          <div key={a.id} className="mb-2.5 rounded-lg border border-warn bg-card p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-medium text-text-strong">{a.id} · {a.title}</span>
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">租约 {a.durationMinutes} 分钟</span>
            </div>
            <div className="mt-1.5 font-mono text-[11.5px] text-muted">
              {a.scope.paths.map((p) => <div key={p}>· {p}</div>)}
              {a.scope.resources.map((r) => <div key={r}>· 🔑 {r}</div>)}
            </div>
            <p className="mt-1.5 text-[12.5px]">{a.ask}</p>
            <p className="mt-0.5 text-[12px] text-muted">拒绝后果：{a.refusalConsequence}</p>
            <div className="mt-2.5 flex justify-end gap-2">
              <button
                disabled={busy !== null}
                className="rounded-md border border-border px-3 py-1 text-[12px] text-muted hover:bg-bg-hover disabled:opacity-40"
                onClick={() => decide(a.id, 'rejected')}
              >{busy === `${a.id}:rejected` ? '…' : '拒绝'}</button>
              <button
                disabled={busy !== null}
                className="rounded-md bg-accent text-accent-fg px-3 py-1 text-[12px] hover:opacity-90 disabled:opacity-40"
                onClick={() => decide(a.id, 'accepted')}
              >{busy === `${a.id}:accepted` ? '…' : '同意'}</button>
            </div>
          </div>
        ))}
        {decided.map((a) => (
          <div key={a.id} className="mb-1.5 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[12.5px] text-muted">
            <span>{a.id} · {a.title}</span>
            <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] ${a.decision === 'accepted' ? 'bg-ok-subtle text-ok' : 'bg-danger-subtle text-danger'}`}>
              {a.decision === 'accepted' ? '已接受' : '已拒绝'}
            </span>
          </div>
        ))}
      </section>

      {/* 3. Work board */}
      <section className="mb-6">
        <SectionTitle hint="13 状态词 · 生命周期只走合法边">Work 看板</SectionTitle>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {snap.works.map((w) => (
            <div key={w.id} className="rounded-lg border border-border bg-card p-3.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-text-strong">{w.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted">{w.goal}</div>
                </div>
                <StatusChip status={w.status} />
              </div>
              <ul className="mt-2.5 space-y-1">
                {w.workItems.map((wi) => (
                  <li key={wi.id} className="flex items-center gap-2 text-[12px]">
                    <StatusChip status={wi.status} />
                    <span className="truncate text-muted">{wi.title}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2.5 flex justify-end">
                <button
                  disabled={busy !== null || w.status === 'DELIVERED'}
                  className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40"
                  onClick={() => advance(w.id)}
                  title="沿合法生命周期边推进"
                >{busy === `${w.id}:advance` ? '…' : '推进 →'}</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* 4. AgentRun / RunEpoch */}
        <section>
          <SectionTitle hint="Run 可消失，Epoch 有界可追">AgentRun / RunEpoch</SectionTitle>
          <div className="rounded-lg border border-border bg-card">
            {snap.runs.map((r) => (
              <div key={r.id} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
                <StatusChip status={r.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px]">{r.id} · {r.agent}</div>
                  <div className="text-[10.5px] text-muted">epochs: {r.epochs.join(' · ')}</div>
                </div>
                <span className="font-mono text-[10px] text-muted">{r.workId}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 5. Evidence with six-level provenance */}
        <section>
          <SectionTitle hint="观测 ≠ 推断：来源即信任等级">Evidence · 六级来源</SectionTitle>
          <div className="rounded-lg border border-border bg-card">
            {snap.evidence.map((e) => (
              <div key={e.id} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
                <span className={`inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[10px] ${EVIDENCE_STYLE[e.level] ?? 'text-muted border-border'}`}>
                  {EVIDENCE_ZH[e.level] ?? e.level}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.title}</span>
                <span className="font-mono text-[10px] text-muted">{e.workId}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
