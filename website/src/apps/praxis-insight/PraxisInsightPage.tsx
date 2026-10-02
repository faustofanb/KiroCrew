/**
 * Praxis Insight — single-page hub with tabs for all Praxis capabilities.
 *
 * Tab: 域视图    Work board, approvals, evidence, UNKNOWN reconciliation
 * Tab: Git GUI    Fork-quality git client (commit graph, staging, blame)
 * Tab: Dev Tools  Embedded web UIs (DBX, any localhost service)
 * Tab: ChangeSet  Cross-repo change management + Delivery CI/CD
 */
import { useState } from 'react'
import EmbeddedToolsPage from './EmbeddedToolsPage'
import GitGuiPage from './GitGuiPage'

// Domain view types (from the original PraxisInsightPage)
type StatusWord = 'READY' | 'RUNNING' | 'WAITING' | 'WAITING_HUMAN' | 'BLOCKED' | 'PAUSED' | 'VERIFYING' | 'FAILED' | 'UNKNOWN' | 'RECOVERY_REQUIRED' | 'STALE' | 'ACCEPTED' | 'DELIVERED'

type Snapshot = {
  statusWords: StatusWord[]
  evidenceLevels: string[]
  works: { id: string; title: string; goal: string; status: StatusWord; workItems: { id: string; title: string; status: StatusWord }[] }[]
  approvals: { id: string; title: string; scope: { paths: string[]; resources: string[] }; durationMinutes: number; ask: string; refusalConsequence: string; decision: string | null }[]
  runs: { id: string; workId: string; agent: string; status: StatusWord; epochs: string[] }[]
  evidence: { id: string; workId: string; title: string; level: string }[]
  unknowns: { operationId: string; lastFact: string; reason: string; reconciliation: string; safeCommand: string }[]
  changesets: { id: string; title: string; status: string; repos: { repo: string; base: string; candidateId: string; headCommit: string; revisions: { id: string; commitSha: string }[] }[]; worktrees: string[]; divergence: string | null }[]
  deliveries: { id: string; changesetId: string; status: string; hasTestEvidence: boolean }[]
}

const STATUS_STYLE: Record<StatusWord, string> = {
  READY: 'text-muted border-border', RUNNING: 'text-accent border-accent', WAITING: 'text-muted border-border-strong',
  WAITING_HUMAN: 'text-warn border-warn', BLOCKED: 'text-text-strong border-border-strong', PAUSED: 'text-muted border-border/60',
  VERIFYING: 'text-info border-info', FAILED: 'text-danger border-danger', UNKNOWN: 'text-warn border-warn border-dashed',
  RECOVERY_REQUIRED: 'text-danger border-warn', STALE: 'text-muted border-border/60', ACCEPTED: 'text-ok border-ok', DELIVERED: 'text-ok border-ok border-2',
}

const EVIDENCE_STYLE: Record<string, string> = {
  external_observation: 'text-info border-info', product_fact: 'text-ok border-ok', agent_inference: 'text-aim border-aim',
  hypothesis: 'text-warn border-warn', unknown: 'text-warn border-warn border-dashed', verification_result: 'text-accent border-accent',
}

const EVIDENCE_ZH: Record<string, string> = {
  external_observation: '外部观测', product_fact: '产品事实', agent_inference: 'Agent 推断',
  hypothesis: '假设', unknown: '未知', verification_result: '验证结果',
}

const CS_STYLE: Record<string, string> = {
  OPEN: 'text-accent border-accent', DIVERGED: 'text-danger border-danger border-dashed', RECONCILED: 'text-ok border-ok', MERGED: 'text-ok border-ok', CLOSED: 'text-muted border-border/60',
}

const DL_STYLE: Record<string, string> = {
  ACCEPTED: 'text-warn border-warn', TEST_QUALIFIED: 'text-info border-info', DELIVERED: 'text-ok border-ok border-2', CLOSED: 'text-muted border-border/60',
}

const DL_ZH: Record<string, string> = {
  ACCEPTED: '已接受', TEST_QUALIFIED: 'TEST 已鉴证', DELIVERED: '已交付', CLOSED: '已关闭',
}

function StatusChip({ status }: { status: StatusWord }) {
  return <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] ${STATUS_STYLE[status]}`}>{status}</span>
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return <div className="mb-2 flex items-baseline gap-2"><h2 className="text-[15px] font-semibold text-text-strong">{children}</h2>{hint && <span className="text-[11px] text-muted">{hint}</span>}</div>
}

function DomainTab() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    fetch('/api/apps/praxis-insight/state').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { setSnap(d); setError(null) }).catch(e => setError(String(e)))
  }
  useState(() => load())

  const decide = (id: string, decision: string) => {
    setBusy(`${id}:${decision}`)
    fetch(`/api/apps/praxis-insight/approvals/${id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) })
      .then(() => load()).catch(e => setError(String(e))).finally(() => setBusy(null))
  }
  const advance = (id: string) => {
    setBusy(`${id}:adv`)
    fetch(`/api/apps/praxis-insight/works/${id}/advance`, { method: 'POST' })
      .then(() => load()).catch(e => setError(String(e))).finally(() => setBusy(null))
  }

  if (!snap) return <div className="p-6 text-sm text-muted">{error ?? '加载中…'}</div>
  const pending = snap.approvals.filter(a => a.decision === null)

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-10">
      {error && <div className="mb-4 rounded border border-danger bg-danger-subtle px-3 py-2 text-[12px] text-danger">{error}</div>}

      {snap.unknowns.map(u => (
        <div key={u.operationId} className="mb-6 rounded-lg border border-dashed border-warn bg-warn-subtle p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded border border-warn bg-bg px-1.5 py-0.5 font-mono text-[10px] text-warn">UNKNOWN · {u.operationId}</span>
            <span className="text-[11px] text-muted">未知不是失败</span>
          </div>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
            <dt className="text-muted">最后事实</dt><dd>{u.lastFact}</dd>
            <dt className="text-muted">不确定原因</dt><dd>{u.reason}</dd>
            <dt className="text-muted">对账状态</dt><dd>{u.reconciliation}</dd>
            <dt className="text-muted">安全命令</dt><dd>{u.safeCommand}</dd>
          </dl>
        </div>
      ))}

      <section className="mb-6">
        <SectionTitle hint="精确范围 · 拒绝有后果">需要我 · 审批收件箱</SectionTitle>
        {pending.length === 0 && <p className="text-[12.5px] text-muted">没有待审批事项。</p>}
        {pending.map(a => (
          <div key={a.id} className="mb-2.5 rounded-lg border border-warn bg-card p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-medium text-text-strong">{a.id} · {a.title}</span>
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">租约 {a.durationMinutes} 分钟</span>
            </div>
            <div className="mt-1.5 font-mono text-[11.5px] text-muted">{a.scope.paths.map(p => <div key={p}>· {p}</div>)}</div>
            <p className="mt-1.5 text-[12.5px]">{a.ask}</p>
            <p className="mt-0.5 text-[12px] text-muted">拒绝后果：{a.refusalConsequence}</p>
            <div className="mt-2.5 flex justify-end gap-2">
              <button disabled={busy !== null} className="rounded-md border border-border px-3 py-1 text-[12px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => decide(a.id, 'rejected')}>拒绝</button>
              <button disabled={busy !== null} className="rounded-md bg-accent px-3 py-1 text-[12px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => decide(a.id, 'accepted')}>同意</button>
            </div>
          </div>
        ))}
      </section>

      <section className="mb-6">
        <SectionTitle hint="13 状态词">Work 看板</SectionTitle>
        <div className="grid gap-3 xl:grid-cols-3">
          {snap.works.map(w => (
            <div key={w.id} className="rounded-lg border border-border bg-card p-3.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-medium text-text-strong">{w.title}</div></div>
                <StatusChip status={w.status} />
              </div>
              <ul className="mt-2 space-y-1">
                {w.workItems.map(wi => (
                  <li key={wi.id} className="flex items-center gap-2 text-[12px]"><StatusChip status={wi.status} /><span className="truncate text-muted">{wi.title}</span></li>
                ))}
              </ul>
              <div className="mt-2.5 flex justify-end">
                <button disabled={busy !== null || w.status === 'DELIVERED'} className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => advance(w.id)}>推进 →</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section>
          <SectionTitle hint="Run 可消失 Epoch 可追">AgentRun / RunEpoch</SectionTitle>
          <div className="rounded-lg border border-border bg-card">
            {snap.runs.map(r => (
              <div key={r.id} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
                <StatusChip status={r.status} />
                <div className="min-w-0 flex-1"><div className="truncate text-[12.5px]">{r.id} · {r.agent}</div></div>
              </div>
            ))}
          </div>
        </section>
        <section>
          <SectionTitle hint="来源即信任等级">Evidence · 六级来源</SectionTitle>
          <div className="rounded-lg border border-border bg-card">
            {snap.evidence.map(e => (
              <div key={e.id} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
                <span className={`inline-flex h-5 items-center rounded border px-1.5 text-[10px] ${EVIDENCE_STYLE[e.level] ?? 'text-muted border-border'}`}>{EVIDENCE_ZH[e.level] ?? e.level}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.title}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function ChangeSetTab() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => { fetch('/api/apps/praxis-insight/state').then(r => r.json()).then(setSnap).catch(e => setError(String(e))) }
  useState(() => load())

  const post = (path: string, body: object, tag: string) => {
    setBusy(tag)
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(new Error(b.error))))
      .then(() => load()).catch(e => setError(String(e))).finally(() => setBusy(null))
  }

  if (!snap) return <div className="p-6 text-sm text-muted">{error ?? '加载中…'}</div>

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-10">
      {error && <div className="mb-4 rounded border border-danger bg-danger-subtle px-3 py-2 text-[12px] text-danger">{error}</div>}
      <section className="mb-6">
        <SectionTitle hint="跨仓原子单元 · fork = 受管 worktree 集">多仓变更 · ChangeSet</SectionTitle>
        <div className="grid gap-3 xl:grid-cols-2">
          {snap.changesets.map(cs => (
            <div key={cs.id} className={`rounded-lg border p-3.5 ${cs.status === 'DIVERGED' ? 'border-danger bg-danger-subtle' : 'border-border bg-card'}`}>
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] ${CS_STYLE[cs.status]}`}>{cs.status}</span>
                <span className="truncate text-[13.5px] font-medium text-text-strong">{cs.id} · {cs.title}</span>
                <button disabled={busy !== null || cs.status === 'CLOSED'} className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => post(`/api/apps/praxis-insight/changesets/${cs.id}/sync-fork`, {}, `${cs.id}:sync`)}>同步 fork</button>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-muted">{cs.worktrees.map(w => <span key={w} className="mr-3">⎇ {w}</span>)}</div>
              <div className="mt-2 space-y-1">
                {cs.repos.map(rc => (
                  <div key={rc.repo} className="flex items-center gap-2 font-mono text-[11.5px]">
                    <span className="w-24 shrink-0 truncate text-text">{rc.repo}</span>
                    <span className="text-muted">{rc.base}</span><span className="text-muted">→</span>
                    <span className="text-accent">{rc.candidateId}</span>
                  </div>
                ))}
              </div>
              {cs.divergence && (
                <div className="mt-2.5 rounded border border-dashed border-danger bg-bg px-3 py-2">
                  <div className="text-[12px] text-danger">跨仓分歧：{cs.divergence}</div>
                  <div className="mt-2 flex justify-end gap-2">
                    <button disabled={busy !== null} className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => post(`/api/apps/praxis-insight/changesets/${cs.id}/resolve-divergence`, { decision: 'reject' }, `${cs.id}:rej`)}>关闭不合并</button>
                    <button disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-0.5 text-[11.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => post(`/api/apps/praxis-insight/changesets/${cs.id}/resolve-divergence`, { decision: 'rebase' }, `${cs.id}:rb`)}>rebase 对齐</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="mb-6">
        <SectionTitle hint="PROD 需真实 TEST 证据">CI/CD · Delivery</SectionTitle>
        <div className="rounded-lg border border-border bg-card">
          {snap.deliveries.map(dl => (
            <div key={dl.id} className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0">
              <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] ${DL_STYLE[dl.status]}`}>{dl.status}<span className="ml-1 font-sans text-[9px] opacity-70">{DL_ZH[dl.status]}</span></span>
              <span className="text-[13px] font-medium text-text-strong">{dl.id}</span>
              <span className="text-[11.5px] text-muted">← {dl.changesetId}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${dl.hasTestEvidence ? 'bg-ok-subtle text-ok' : 'bg-warn-subtle text-warn'}`}>{dl.hasTestEvidence ? 'TEST 证据 ✓' : '缺 TEST 证据'}</span>
              <div className="ml-auto flex gap-2">
                {dl.status === 'ACCEPTED' && <button disabled={busy !== null} className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => post(`/api/apps/praxis-insight/deliveries/${dl.id}/promote`, { action: 'TEST' }, `${dl.id}:T`)}>TEST 鉴证</button>}
                {dl.status === 'TEST_QUALIFIED' && <button disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-0.5 text-[11.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => post(`/api/apps/praxis-insight/deliveries/${dl.id}/promote`, { action: 'PROD' }, `${dl.id}:P`)}>交付 PROD</button>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

type Tab = 'domain' | 'git' | 'tools' | 'changeset'
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'domain', label: '域视图', icon: '☰' },
  { id: 'git', label: 'Git GUI', icon: '⎇' },
  { id: 'changeset', label: '变更/交付', icon: '⇄' },
  { id: 'tools', label: 'Dev Tools', icon: ' Apps' },
]

export default function PraxisInsightPage() {
  const [tab, setTab] = useState<Tab>('domain')
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0 border-b border-border bg-card px-3">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex h-full items-center gap-1.5 border-b-2 px-4 text-[13px] font-medium transition-colors ${tab === t.id ? 'border-accent text-text-strong' : 'border-transparent text-muted hover:text-text'}`}>
            <span className="text-[11px]">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'domain' && <DomainTab />}
        {tab === 'git' && <GitGuiPage />}
        {tab === 'changeset' && <ChangeSetTab />}
        {tab === 'tools' && <EmbeddedToolsPage />}
      </div>
    </div>
  )
}
