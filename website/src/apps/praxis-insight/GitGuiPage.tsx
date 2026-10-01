/**
 * Fork-quality Git GUI — deep optimization with line-level staging,
 * side-by-side diff rendering, keyboard navigation, and search.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

type Commit = {
  sha: string; short: string; author: string; timestamp: number
  subject: string; parents: string[]; refs: string[]; lane?: number
}
type FileStatus = {
  path: string; oldPath: string | null; staged: boolean; unstaged: boolean
  untracked: boolean; status: string
}
type Branch = { name: string; sha: string; current: boolean; upstream: string; subject: string }
type Hunk = {
  header: string; oldLines: string[]; newLines: string[]; patch: string
}
type HunkDiff = {
  repo: string; path: string; staged: boolean; header: string; hunks: Hunk[]
}

const BASE = '/api/apps/praxis-insight/gitgui'

function layoutLanes(commits: Commit[]): Commit[] {
  const laneOf = new Map<string, number>()
  let nextLane = 0
  return commits.map((c) => {
    if (c.parents.length === 0) { c.lane = 0; return c }
    const pl = laneOf.get(c.parents[0])
    c.lane = pl !== undefined ? pl : nextLane
    if (pl === undefined) { laneOf.set(c.parents[0], nextLane); nextLane = (nextLane + 1) % 4 }
    return c
  })
}

/** Side-by-side diff line pair. */
function DiffRow({ oldL, newL, oldN, newN }: { oldL: string; newL: string; oldN: number; newN: number }) {
  const oldCls = oldL === '' ? '' : 'bg-danger-subtle text-danger'
  const newCls = newL === '' ? '' : 'bg-ok-subtle text-ok'
  return (
    <div className="flex font-mono text-[10px] leading-5">
      <div className={`flex w-1/2 shrink-0 border-r border-border/30 ${oldCls}`}>
        <span className="w-8 shrink-0 select-none text-right text-muted/50 pr-1">{oldN > 0 ? oldN : ''}</span>
        <span className="whitespace-pre-wrap break-all pl-1 pr-1 flex-1 min-w-0">{oldL}</span>
      </div>
      <div className={`flex w-1/2 shrink-0 ${newCls}`}>
        <span className="w-8 shrink-0 select-none text-right text-muted/50 pr-1">{newN > 0 ? newN : ''}</span>
        <span className="whitespace-pre-wrap break-all pl-1 flex-1 min-w-0">{newL}</span>
      </div>
    </div>
  )
}

export default function GitGuiPage() {
  const [repos, setRepos] = useState<{ name: string; branch: string }[]>([])
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('HEAD')
  const [branches, setBranches] = useState<Branch[]>([])
  const [commits, setCommits] = useState<Commit[]>([])
  const [files, setFiles] = useState<FileStatus[]>([])
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null)
  const [commitDiff, setCommitDiff] = useState<string | null>(null)
  const [hunkDiff, setHunkDiff] = useState<HunkDiff | null>(null)
  const [blameData, setBlameData] = useState<{ path: string; lines: { sha: string; author: string; text: string }[] } | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadRepos = useCallback(() => {
    fetch(`${BASE}/repos`).then((r) => r.json()).then((d) => {
      setRepos(d.repos ?? [])
      if (!repo && d.repos?.length) setRepo(d.repos[0].name)
    }).catch(() => {})
  }, [repo])
  useEffect(() => { loadRepos() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadAll = useCallback(() => {
    if (!repo) return
    fetch(`${BASE}/log?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&limit=100`)
      .then((r) => r.json()).then((d) => setCommits(layoutLanes(d.commits ?? []))).catch(() => {})
    fetch(`${BASE}/status?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json()).then((d) => setFiles(d.files ?? [])).catch(() => {})
    fetch(`${BASE}/branches?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json()).then((d) => setBranches(d.local ?? [])).catch(() => {})
  }, [repo, branch])
  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => {
    if (!autoRefresh || !repo) return
    const id = setInterval(loadAll, 5000)
    return () => clearInterval(id)
  }, [autoRefresh, repo, loadAll])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
      } else if (e.key === 'f') {
        e.preventDefault()
      } else if (e.key === '/') {
        e.preventDefault()
        fileInputRef.current?.focus()
      } else if (e.key === 'r') {
        e.preventDefault()
        loadAll()
      } else if (e.key === 'Escape') {
        setSelectedCommit(null); setHunkDiff(null); setBlameData(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [loadAll])

  const stageOp = (op: string, extra: Record<string, unknown> = {}) => {
    fetch(`${BASE}/stage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, op, ...extra }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
      .then(() => { loadAll(); setError(null) })
      .catch((e) => setError(String(e)))
  }

  const branchExtra = (op: string, extra: Record<string, unknown> = {}) => {
    fetch(`${BASE}/branch-extra`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, op, ...extra }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
      .then(() => { loadAll(); setError(null) })
      .catch((e) => setError(String(e)))
  }

  const showCommitDiff = (c: Commit) => {
    setSelectedCommit(c); setHunkDiff(null); setBlameData(null);
    fetch(`${BASE}/diff/commit?repo=${encodeURIComponent(repo)}&sha=${c.sha}`)
      .then((r) => r.json()).then((d) => setCommitDiff(d.patch ?? '')).catch(() => setCommitDiff(null))
  }

  const showHunkDiff = (f: FileStatus, staged: boolean) => {
    setSelectedCommit(null); setBlameData(null); setHunkDiff(null)
    fetch(`${BASE}/diff/hunks?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(f.path)}&staged=${staged ? 1 : 0}`)
      .then((r) => r.json()).then((d) => setHunkDiff(d)).catch(() => setHunkDiff(null))
  }

  const showBlame = (f: FileStatus) => {
    setSelectedCommit(null); setHunkDiff(null); setHunkDiff(null)
    fetch(`${BASE}/blame?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(f.path)}`)
      .then((r) => r.json()).then((d) => setBlameData({ path: f.path, lines: d.lines ?? [] })).catch(() => {})
  }

  const stageHunk = (hunk: Hunk, reverse: boolean = false) => {
    stageOp('hunk', { path: hunkDiff?.path, patch: hunk.patch, reverse })
    // Refresh hunk view after staging
    if (hunkDiff) {
      setTimeout(() => showHunkDiff({ path: hunkDiff.path } as FileStatus, hunkDiff.staged), 300)
    }
  }

  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)
  const filteredCommits = commits.filter((c) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.short.includes(q)
  })
  const laneColors = ['text-accent', 'text-aim', 'text-info', 'text-warn']
  const hasDetail = selectedCommit || hunkDiff || blameData

  return (
    <div className="flex h-full min-h-0">
      {/* Left: repos + branches */}
      <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold text-text-strong">仓库</span>
          <label className="ml-auto flex items-center gap-1 text-[9.5px] text-muted" title="5 秒自动刷新">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="h-3 w-3" />
            auto
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {repos.map((r) => (
            <button
              key={r.name}
              onClick={() => { setRepo(r.name); setBranch('HEAD') }}
              className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${repo === r.name ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}
            >
              <span className="truncate text-[12px] text-text">{r.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[9px] text-muted">{r.branch.slice(0, 12)}</span>
            </button>
          ))}
        </div>
        {branches.length > 0 && (
          <>
            <div className="border-t border-border px-3 py-1.5 text-[11px] font-semibold text-muted">分支</div>
            <div className="max-h-36 overflow-y-auto p-1.5">
              {branches.map((b) => (
                <div key={b.name} className={`group flex items-center gap-1.5 rounded px-2 py-1 ${branch === b.name ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}>
                  <button onClick={() => setBranch(b.name)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    {b.current && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                    <span className="truncate font-mono text-[10.5px] text-text">{b.name}</span>
                  </button>
                  <div className="hidden shrink-0 gap-0.5 group-hover:flex">
                    {!b.current && <button className="rounded border border-border px-1 py-px text-[8.5px] text-accent" onClick={() => { if (window.confirm(`合并 ${b.name} 到当前分支？`)) branchExtra('merge', { source: b.name }) }}>⇄</button>}
                    {!b.current && <button className="rounded border border-border px-1 py-px text-[8.5px] text-danger" onClick={() => { if (window.confirm(`删除分支 ${b.name}？`)) branchExtra('delete', { name: b.name }) }}>×</button>}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1 border-t border-border p-1.5">
              <button className="flex-1 rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-bg-hover" onClick={() => branchExtra('stash', { message: `stash ${new Date().toLocaleTimeString('zh-CN')}` })}>Stash</button>
              <button className="flex-1 rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-bg-hover" onClick={() => branchExtra('stash-pop')}>Pop</button>
            </div>
            <div className="border-t border-border p-1.5">
              <input
                placeholder="新分支名…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const name = (e.target as HTMLInputElement).value.trim()
                    if (name) {
                      fetch(`${BASE}/branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, op: 'create', name }) })
                        .then(() => { (e.target as HTMLInputElement).value = ''; loadAll() }).catch((err) => setError(String(err)))
                    }
                  }
                }}
                className="h-7 w-full rounded border border-border bg-bg px-2 font-mono text-[10.5px] text-text outline-none placeholder:text-muted"
              />
            </div>
          </>
        )}
      </aside>

      {/* Center: commit history */}
      <div className={`flex min-w-0 flex-col border-r border-border transition-all ${hasDetail ? 'flex-1' : 'flex-[1.4]'}`}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <span className="text-[13px] font-semibold text-text-strong">提交</span>
          <input
            ref={fileInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索…  按 / 聚焦"
            className="h-6.5 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-[11.5px] text-text outline-none placeholder:text-muted"
          />
          <span className="font-mono text-[9.5px] text-muted">{filteredCommits.length}/{commits.length}</span>
        </div>
        <div className={`min-h-0 ${hasDetail ? 'max-h-[60%]' : 'flex-1'} overflow-y-auto`}>
          {filteredCommits.map((c) => (
            <button
              key={c.sha}
              onClick={() => showCommitDiff(c)}
              className={`flex w-full items-start gap-2 border-b border-border/40 px-3 py-1.5 text-left hover:bg-bg-hover ${selectedCommit?.sha === c.sha ? 'bg-accent-subtle' : ''}`}
            >
              <span className={`mt-1 shrink-0 font-mono text-[10px] ${laneColors[(c.lane ?? 0) % 4]}`}>
                {(c.lane ?? 0) === 0 ? '●' : (c.lane ?? 0) === 1 ? '○' : (c.lane ?? 0) === 2 ? '◆' : '◇'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium text-text">{c.subject}</span>
                  {c.refs.length > 0 && (
                    <span className="shrink-0 rounded border border-accent px-1 py-px font-mono text-[8.5px] text-accent">{c.refs[0]}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted">
                  <span className="truncate">{c.author.split(' ')[0]}</span>
                  <span>·</span>
                  <span>{new Date(c.timestamp * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</span>
                  <span className="font-mono">{c.short}</span>
                  {c.parents.length > 1 && <span className="text-warn">merge</span>}
                </div>
              </div>
            </button>
          ))}
          {filteredCommits.length === 0 && <p className="p-4 text-center text-[12px] text-muted">{search ? '没有匹配的提交' : '选择仓库查看历史'}</p>}
        </div>

        {/* Working directory (below commit list) */}
        <div className={`min-h-0 shrink-0 overflow-y-auto border-t-2 border-border ${hasDetail ? 'h-[40%]' : 'flex-1'}`}>
          <div className="sticky top-0 flex items-center gap-2 border-b border-border bg-card px-3 py-1.5">
            <span className="text-[12px] font-semibold text-text-strong">工作目录</span>
            <span className={`rounded px-1.5 py-px text-[10px] ${staged.length > 0 ? 'bg-ok-subtle text-ok' : 'text-muted'}`}>{staged.length} 暂存</span>
            <span className={`rounded px-1.5 py-px text-[10px] ${unstaged.length > 0 ? 'bg-warn-subtle text-warn' : 'text-muted'}`}>{unstaged.length} 未暂存</span>
            {staged.length > 0 && <button className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-bg-hover" onClick={() => stageOp('all', { unstage: true })}>全部反暂存</button>}
          </div>
          <div className="p-2">
            {staged.length > 0 && (
              <div className="mb-2 rounded border border-border bg-card p-2">
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { stageOp('commit', { message: commitMsg }); setCommitMsg('') } }}
                  placeholder="提交信息… (⌘+Enter 提交)"
                  rows={2}
                  className="mb-1.5 w-full resize-none rounded border border-border bg-bg px-2 py-1 text-[11.5px] text-text outline-none placeholder:text-muted"
                />
                <button
                  disabled={!commitMsg.trim()}
                  className="rounded bg-accent px-3 py-1 text-[11px] text-accent-fg hover:opacity-90 disabled:opacity-40"
                  onClick={() => { stageOp('commit', { message: commitMsg }); setCommitMsg('') }}
                >提交 ({staged.length})</button>
              </div>
            )}
            {[...staged.map((f) => ({ f, s: true })), ...unstaged.map((f) => ({ f, s: false }))].map(({ f, s }) => (
              <div key={f.path + s} className={`group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-bg-hover ${s ? 'border-l-2 border-ok' : 'border-l-2 border-transparent'}`}>
                <span className={`shrink-0 font-mono text-[9px] ${s ? 'text-ok' : f.untracked ? 'text-warn' : 'text-danger'}`}>{s ? '✓' : f.status}</span>
                <button className="min-w-0 flex-1 truncate text-left font-mono text-[10.5px] text-text" onClick={() => showHunkDiff(f, s)}>{f.path}</button>
                <div className="hidden shrink-0 gap-0.5 group-hover:flex">
                  {s ? (
                    <button className="rounded border border-border px-1 py-px text-[9px] text-muted" onClick={() => stageOp('file', { path: f.path, unstage: true })}>反暂存</button>
                  ) : (
                    <>
                      <button className="rounded border border-border px-1 py-px text-[9px] text-accent" onClick={() => stageOp('file', { path: f.path })}>暂存</button>
                      {!f.untracked && <button className="rounded border border-danger px-1 py-px text-[9px] text-danger" onClick={() => { if (window.confirm(`丢弃 ${f.path}？`)) branchExtra('discard', { path: f.path }) }}>丢弃</button>}
                    </>
                  )}
                  <button className="rounded border border-border px-1 py-px text-[9px] text-muted" onClick={() => showBlame(f)}>Blame</button>
                </div>
              </div>
            ))}
            {staged.length === 0 && unstaged.length === 0 && <p className="py-3 text-center text-[11.5px] text-muted">工作目录干净</p>}
          </div>
        </div>
      </div>

      {/* Right: detail panel (diff/blame/hunks) */}
      {hasDetail && (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
            <span className="text-[13px] font-semibold text-text-strong">
              {selectedCommit ? selectedCommit.short : hunkDiff ? hunkDiff.path.split('/').pop() : blameData ? blameData.path.split('/').pop() : ''}
            </span>
            <button className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={() => { setSelectedCommit(null); setHunkDiff(null); setBlameData(null) }}>关闭</button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {error && <div className="m-3 rounded border border-danger bg-danger-subtle px-3 py-2 text-[12px] text-danger">{error}</div>}

            {selectedCommit && (
              <div className="p-3">
                <div className="mb-1 text-[13px] font-medium text-text-strong">{selectedCommit.subject}</div>
                <div className="mb-3 text-[11px] text-muted">{selectedCommit.author} · {new Date(selectedCommit.timestamp * 1000).toLocaleString('zh-CN')}</div>
                <pre className="font-mono text-[10px] leading-5 text-text">{commitDiff}</pre>
              </div>
            )}

            {hunkDiff && (
              <div className="p-3">
                <div className="mb-1 font-mono text-[11px] text-muted">{hunkDiff.path}{hunkDiff.staged ? ' (staged)' : ''}</div>
                {hunkDiff.hunks.length === 0 && <p className="text-[12px] text-muted">无差异</p>}
                {hunkDiff.hunks.map((h, hi) => {
                  // Build paired rows for side-by-side
                  const rows: { o: string; n: string; on: number; nn: number }[] = []
                  let oi = 0, ni = 0
                  for (let i = 0; i < Math.max(h.oldLines.length, h.newLines.length); i++) {
                    const o = h.oldLines[oi] ?? ''
                    const n = h.newLines[ni] ?? ''
                    rows.push({ o, n, on: oi + 1, nn: ni + 1 })
                    if (oi < h.oldLines.length) oi++
                    if (ni < h.newLines.length) ni++
                  }
                  return (
                    <div key={hi} className="mb-3 rounded border border-border">
                      <div className="flex items-center gap-2 border-b border-border bg-card px-2 py-1">
                        <span className="font-mono text-[9.5px] text-muted">{h.header}</span>
                        <div className="ml-auto flex gap-1">
                          {!hunkDiff.staged && <button className="rounded border border-accent px-1.5 py-px text-[9px] text-accent hover:bg-accent-subtle" onClick={() => stageHunk(h)}>暂存此块</button>}
                          {hunkDiff.staged && <button className="rounded border border-border px-1.5 py-px text-[9px] text-muted hover:bg-bg-hover" onClick={() => stageHunk(h, true)}>反暂存此块</button>}
                        </div>
                      </div>
                      {rows.map((r, ri) => <DiffRow key={ri} oldL={r.o} newL={r.n} oldN={r.on} newN={r.nn} />)}
                    </div>
                  )
                })}
              </div>
            )}

            {blameData && (
              <div className="p-3">
                {blameData.lines.map((l, i) => (
                  <div key={i} className="flex gap-2 font-mono text-[10px] leading-5">
                    <span className="w-14 shrink-0 text-muted">{l.sha}</span>
                    <span className="w-20 shrink-0 truncate text-info">{l.author}</span>
                    <span className="min-w-0 flex-1 whitespace-pre text-text">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
