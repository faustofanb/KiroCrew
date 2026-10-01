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
  changesets: {
    id: string
    title: string
    status: 'OPEN' | 'DIVERGED' | 'RECONCILED' | 'MERGED' | 'CLOSED'
    repos: {
      repo: string
      base: string
      candidateId: string
      headCommit: string
      revisions: { id: string; parentId: string | null; commitSha: string; note: string }[]
    }[]
    worktrees: string[]
    divergence: string | null
  }[]
  deliveries: {
    id: string
    changesetId: string
    status: 'ACCEPTED' | 'TEST_QUALIFIED' | 'DELIVERED' | 'CLOSED'
    hasTestEvidence: boolean
  }[]
}

type GitRepo = { name: string; branch: string; dirty: number }
type GitForkRepoState = {
  repo: string; branch: string; base: string
  ahead: number; behind: number; dirty: number; rebasing: boolean; conflict: boolean
}
type GitFork = {
  fork: { id: string; title: string; status: string; note: string; repos: { repo: string; worktree: string; branch: string; base: string }[] }
  repoStates: GitForkRepoState[]
}
type GitDiff = { repos: { repo: string; stat: string; patch: string }[] }

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

const CS_STYLE: Record<string, string> = {
  OPEN: 'text-accent border-accent',
  DIVERGED: 'text-danger border-danger border-dashed',
  RECONCILED: 'text-ok border-ok',
  MERGED: 'text-ok border-ok',
  CLOSED: 'text-muted border-border/60',
}

const DL_STYLE: Record<string, string> = {
  ACCEPTED: 'text-warn border-warn',
  TEST_QUALIFIED: 'text-info border-info',
  DELIVERED: 'text-ok border-ok border-2',
  CLOSED: 'text-muted border-border/60',
}

const DL_ZH: Record<string, string> = {
  ACCEPTED: '已接受', TEST_QUALIFIED: 'TEST 已鉴证', DELIVERED: '已交付', CLOSED: '已关闭',
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

  const post = (path: string, body: object, tag: string, done: () => void) => {
    setBusy(tag)
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error ?? `HTTP ${r.status}`)))))
      .then(() => { done(); load() })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null))
  }

  const resolveDivergence = (id: string, decision: 'rebase' | 'accept' | 'reject') =>
    post(`/api/apps/praxis-insight/changesets/${id}/resolve-divergence`, { decision }, `${id}:${decision}`, () => {})
  const syncFork = (id: string) =>
    post(`/api/apps/praxis-insight/changesets/${id}/sync-fork`, {}, `${id}:sync`, () => {})
  const promote = (id: string, action: 'TEST' | 'PROD' | 'CLOSE') =>
    post(`/api/apps/praxis-insight/deliveries/${id}/promote`, { action }, `${id}:${action}`, () => {})

  // ── Fork 工作台（真实 git）──
  const [gitRoot, setGitRoot] = useState('')
  const [rootInput, setRootInput] = useState('')
  const [gitRepos, setGitRepos] = useState<GitRepo[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [baseBranch, setBaseBranch] = useState('main')
  const [forks, setForks] = useState<GitFork[] | null>(null)
  const [diffs, setDiffs] = useState<Record<string, GitDiff | 'loading'>>({})

  const gitRefresh = useCallback(() => {
    fetch('/api/apps/praxis-insight/git/forks')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setForks(d.forks); setGitRoot(d.root); if (!rootInput && d.root) setRootInput(d.root) })
      .catch(() => setForks([]))
  }, [rootInput])
  useEffect(() => { gitRefresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const gitPost = (path: string, body: object, tag: string) => {
    setBusy(tag)
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error ?? `HTTP ${r.status}`)))))
      .then(() => gitRefresh())
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null))
  }

  const saveRoot = () => {
    setBusy('root')
    fetch('/api/apps/praxis-insight/git/root', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: rootInput }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error ?? `HTTP ${r.status}`)))))
      .then(() => fetch('/api/apps/praxis-insight/git/repos').then((r) => r.json()))
      .then((d) => { setGitRepos(d.repos); setGitRoot(d.root); setError(null) })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null))
  }
  const scanRepos = () => {
    fetch('/api/apps/praxis-insight/git/repos')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setGitRepos(d.repos))
      .catch((e) => setError(String(e)))
  }
  const toggleRepo = (name: string) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n })
  }
  const createFork = () => {
    if (!selected.size) { setError('先勾选至少一个仓库'); return }
    gitPost('/api/apps/praxis-insight/git/forks', { repos: [...selected], base: baseBranch, title: `fork ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` }, 'create-fork')
  }
  const commitRepo = (fid: string, repo: string) => {
    const msg = window.prompt(`提交 ${repo} 的全部改动（fork worktree）`, 'wip')
    if (!msg) return
    gitPost(`/api/apps/praxis-insight/git/forks/${fid}/commit`, { repo, message: msg }, `${fid}:${repo}:commit`)
  }
  const loadDiff = (fid: string) => {
    setDiffs((d) => ({ ...d, [fid]: 'loading' }))
    fetch(`/api/apps/praxis-insight/git/forks/${fid}/diff`)
      .then((r) => r.json())
      .then((d) => setDiffs((prev) => ({ ...prev, [fid]: d })))
      .catch(() => setDiffs((prev) => {
        const n = { ...prev }
        delete n[fid]
        return n
      }))
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

      {/* 3.4 Fork 工作台（真实 git 操作） */}
      <section className="mb-6">
        <SectionTitle hint="真实 worktree / rebase / merge · 分歧自动检测 · 全程可丢弃">Fork 工作台 · 真实 Git</SectionTitle>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={rootInput}
            onChange={(e) => setRootInput(e.target.value)}
            placeholder="工作区根目录（其下每级一层 = 一个 git 仓库）"
            className="h-8 min-w-72 flex-1 rounded-md border border-border bg-bg px-2.5 font-mono text-[12px] text-text outline-none placeholder:text-muted"
          />
          <button disabled={busy !== null} className="h-8 rounded-md border border-border px-3 text-[12px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={saveRoot}>
            {busy === 'root' ? '…' : '设为根目录'}
          </button>
          {gitRoot && (
            <button className="h-8 rounded-md border border-border px-3 text-[12px] text-muted hover:bg-bg-hover" onClick={scanRepos}>扫描仓库</button>
          )}
        </div>

        {gitRepos && (
          <div className="mb-3 rounded-lg border border-border bg-card p-3">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {gitRepos.map((r) => (
                <button
                  key={r.name}
                  onClick={() => toggleRepo(r.name)}
                  className={`rounded-md border px-2 py-1 font-mono text-[11.5px] ${selected.has(r.name) ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-muted hover:bg-bg-hover'}`}
                >
                  {selected.has(r.name) ? '✓ ' : ''}{r.name}
                  <span className="ml-1 opacity-60">{r.branch}{r.dirty > 0 ? ` · ${r.dirty}脏` : ''}</span>
                </button>
              ))}
              {gitRepos.length === 0 && <span className="text-[12px] text-muted">根目录下没有 git 仓库</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-muted">基线分支</span>
              <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className="h-7 w-32 rounded border border-border bg-bg px-2 font-mono text-[11.5px] text-text outline-none" />
              <button disabled={busy !== null} className="ml-auto rounded-md bg-accent px-3 py-1 text-[12px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={createFork}>
                {busy === 'create-fork' ? '创建中…' : `创建 fork（${selected.size} 仓）`}
              </button>
            </div>
          </div>
        )}

        {forks && forks.length === 0 && gitRoot && <p className="text-[12.5px] text-muted">还没有 fork。勾选仓库创建一个——会在 .kirocrew-forks/ 下生成每仓一个受管 worktree。</p>}
        {forks?.map(({ fork: f, repoStates }) => (
          <div key={f.id} className={`mb-2.5 rounded-lg border p-3.5 ${f.status === 'DIVERGED' || f.status === 'CONFLICT' ? 'border-danger bg-danger-subtle' : f.status === 'MERGED' ? 'border-ok bg-card' : 'border-border bg-card'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] ${CS_STYLE[f.status] ?? 'text-muted border-border'}`}>{f.status}</span>
              <span className="text-[13.5px] font-medium text-text-strong">{f.id} · {f.title}</span>
              <span className="font-mono text-[10.5px] text-muted">base {f.repos[0]?.base} · 分支 {f.repos[0]?.branch}</span>
              <div className="ml-auto flex flex-wrap gap-1.5">
                {f.status === 'CONFLICT' ? (
                  <>
                    <button disabled={busy !== null} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => gitPost(`/api/apps/praxis-insight/git/forks/${f.id}/sync`, { op: 'abort' }, `${f.id}:abort`)}>中止 rebase</button>
                    <button disabled={busy !== null} className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => gitPost(`/api/apps/praxis-insight/git/forks/${f.id}/sync`, { op: 'continue' }, `${f.id}:cont`)}>已解决，继续 rebase</button>
                  </>
                ) : f.status !== 'MERGED' && f.status !== 'CLOSED' ? (
                  <>
                    <button disabled={busy !== null} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => gitPost(`/api/apps/praxis-insight/git/forks/${f.id}/sync`, {}, `${f.id}:sync`)} title="把基线分支 rebase 进各 worktree">同步 rebase</button>
                    <button disabled={busy !== null} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => loadDiff(f.id)}>查看 diff</button>
                    <button disabled={busy !== null} className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => { if (window.confirm(`把 ${f.id} 合并回基线分支？主检出需在基线上且干净。`)) gitPost(`/api/apps/praxis-insight/git/forks/${f.id}/merge`, {}, `${f.id}:merge`) }}>合并回基线</button>
                  </>
                ) : null}
                {f.status !== 'CLOSED' && (
                  <button disabled={busy !== null} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => { if (window.confirm('关闭并清理该 fork 的全部 worktree（未合并的分支会被删除）？')) gitPost(`/api/apps/praxis-insight/git/forks/${f.id}/close`, { deleteBranch: true }, `${f.id}:close`) }}>
                    {f.status === 'MERGED' ? '清理 worktree' : '关闭丢弃'}
                  </button>
                )}
              </div>
            </div>
            {f.note && <div className="mt-1 text-[11.5px] text-danger">{f.note}</div>}
            <div className="mt-2 space-y-1">
              {repoStates.map((st) => (
                <div key={st.repo} className="flex flex-wrap items-center gap-2 font-mono text-[11.5px]">
                  <span className="w-20 shrink-0 truncate text-text">{st.repo}</span>
                  <span className={st.behind > 0 ? 'text-danger' : 'text-muted'}>↓{st.behind}</span>
                  <span className={st.ahead > 0 ? 'text-accent' : 'text-muted'}>↑{st.ahead}</span>
                  {st.dirty > 0 && <span className="text-warn">{st.dirty} 脏文件</span>}
                  {st.rebasing && <span className="text-danger">rebase 进行中</span>}
                  <button disabled={busy !== null} className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => commitRepo(f.id, st.repo)}>提交全部</button>
                </div>
              ))}
            </div>
            {diffs[f.id] && (
              <div className="mt-2">
                {diffs[f.id] === 'loading' ? (
                  <div className="text-[11.5px] text-muted">diff 加载中…</div>
                ) : (
                  (diffs[f.id] as GitDiff).repos.map((d) => (
                    <div key={d.repo} className="mb-1.5">
                      {d.stat ? (
                        <>
                          <div className="font-mono text-[10.5px] text-muted">{d.repo} · {d.stat.split('\n').length} 文件</div>
                          <pre className="max-h-64 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[10.5px] leading-5">{d.patch}</pre>
                        </>
                      ) : (
                        <div className="font-mono text-[10.5px] text-muted">{d.repo} · 无差异</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </section>

      {/* 3.5 多仓变更管理：ChangeSet / 仿 fork */}
      <section className="mb-6">
        <SectionTitle hint="跨仓原子单元 · fork = 受管 worktree 集 · 分歧须显式裁决">多仓变更 · ChangeSet</SectionTitle>
        <div className="grid gap-3 xl:grid-cols-2">
          {snap.changesets.map((cs) => (
            <div key={cs.id} className={`rounded-lg border p-3.5 ${cs.status === 'DIVERGED' ? 'border-danger bg-danger-subtle' : 'border-border bg-card'}`}>
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] ${CS_STYLE[cs.status]}`}>{cs.status}</span>
                <span className="truncate text-[13.5px] font-medium text-text-strong">{cs.id} · {cs.title}</span>
                <button
                  disabled={busy !== null || cs.status === 'CLOSED'}
                  className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover disabled:opacity-40"
                  onClick={() => syncFork(cs.id)}
                  title="把上游基线拉进该变更的 fork worktree 集"
                >{busy === `${cs.id}:sync` ? '…' : '同步 fork'}</button>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-muted">
                {cs.worktrees.map((w) => <span key={w} className="mr-3">⎇ {w}</span>)}
              </div>
              <div className="mt-2 space-y-1">
                {cs.repos.map((rc) => (
                  <div key={rc.repo} className="flex items-center gap-2 font-mono text-[11.5px]">
                    <span className="w-24 shrink-0 truncate text-text">{rc.repo}</span>
                    <span className="text-muted">{rc.base}</span>
                    <span className="text-muted">→</span>
                    <span className="text-accent">{rc.candidateId}</span>
                    <span className="text-muted">@{rc.headCommit.slice(0, 7)}</span>
                    <span className="ml-auto text-[10px] text-muted">{rc.revisions.length} 修订</span>
                  </div>
                ))}
              </div>
              {cs.divergence && (
                <div className="mt-2.5 rounded border border-dashed border-danger bg-bg px-3 py-2">
                  <div className="text-[12px] text-danger">跨仓分歧：{cs.divergence}</div>
                  <div className="mt-2 flex justify-end gap-2">
                    <button disabled={busy !== null} className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => resolveDivergence(cs.id, 'reject')}>关闭不合并</button>
                    <button disabled={busy !== null} className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => resolveDivergence(cs.id, 'accept')}>采纳新基线</button>
                    <button disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-0.5 text-[11.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => resolveDivergence(cs.id, 'rebase')}>
                      {busy === `${cs.id}:rebase` ? '…' : 'rebase 对齐'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 3.6 CI/CD：Delivery 生命周期 */}
      <section className="mb-6">
        <SectionTitle hint="Delivery ≠ Deployment · PROD 需真实 TEST 证据 · 分歧未裁决不得交付">CI/CD · Delivery</SectionTitle>
        <div className="rounded-lg border border-border bg-card">
          {snap.deliveries.map((dl) => {
            const cs = snap.changesets.find((c) => c.id === dl.changesetId)
            return (
              <div key={dl.id} className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0">
                <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] ${DL_STYLE[dl.status]}`}>{dl.status}<span className="ml-1 font-sans text-[9px] opacity-70">{DL_ZH[dl.status]}</span></span>
                <span className="text-[13px] font-medium text-text-strong">{dl.id}</span>
                <span className="text-[11.5px] text-muted">← {dl.changesetId}{cs ? ` · ${cs.title}` : ''}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${dl.hasTestEvidence ? 'bg-ok-subtle text-ok' : 'bg-warn-subtle text-warn'}`}>
                  {dl.hasTestEvidence ? 'TEST 证据 ✓' : '缺 TEST 证据 · qualification pending'}
                </span>
                <div className="ml-auto flex gap-2">
                  {dl.status === 'ACCEPTED' && (
                    <button disabled={busy !== null} className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => promote(dl.id, 'TEST')} title="凭真实 TEST 证据鉴证；缺失则拒绝并保持 pending">
                      {busy === `${dl.id}:TEST` ? '…' : 'TEST 鉴证'}
                    </button>
                  )}
                  {dl.status === 'TEST_QUALIFIED' && (
                    <button disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-0.5 text-[11.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => promote(dl.id, 'PROD')}>
                      {busy === `${dl.id}:PROD` ? '…' : '交付 PROD'}
                    </button>
                  )}
                  {dl.status === 'DELIVERED' && (
                    <button disabled={busy !== null} className="rounded-md border border-border px-2.5 py-0.5 text-[11.5px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => promote(dl.id, 'CLOSE')}>
                      {busy === `${dl.id}:CLOSE` ? '…' : '关闭'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
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
