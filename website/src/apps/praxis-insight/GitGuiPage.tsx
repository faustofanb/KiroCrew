/**
 * Fork-quality Git GUI — visual git client with commit graph, staging,
 * side-by-side diffs, branch management, and blame view.
 *
 * Layout:
 *   Left: repo list + branch selector
 *   Center: commit history with visual lane graph
 *   Right: working directory changes (stage/unstage) OR commit detail (diff)
 */
import { useCallback, useEffect, useState } from 'react'

type Commit = {
  sha: string; short: string; author: string; timestamp: number
  subject: string; parents: string[]; refs: string[]
  lane?: number
}
type FileStatus = {
  path: string; oldPath: string | null; staged: boolean; unstaged: boolean
  untracked: boolean; status: string
}
type Branch = { name: string; sha: string; current: boolean; upstream: string; subject: string }

const BASE = '/api/apps/praxis-insight/gitgui'

/** Compute lane positions for the commit graph (simplified zig-zag). */
function layoutLanes(commits: Commit[]): Commit[] {
  const laneOf = new Map<string, number>()
  let nextLane = 0
  return commits.map((c) => {
    if (c.parents.length === 0) {
      c.lane = 0
      return c
    }
    const parentLane = laneOf.get(c.parents[0])
    if (parentLane !== undefined) {
      c.lane = parentLane
    } else {
      c.lane = nextLane
      laneOf.set(c.parents[0], nextLane)
      nextLane = (nextLane + 1) % 4
    }
    return c
  })
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
  const [fileDiff, setFileDiff] = useState<{ path: string; staged: boolean; patch: string } | null>(null)
  const [blameData, setBlameData] = useState<{ path: string; lines: { sha: string; author: string; text: string }[] } | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadRepos = useCallback(() => {
    fetch(`${BASE}/repos`).then((r) => r.json()).then((d) => {
      setRepos(d.repos ?? [])
      if (!repo && d.repos?.length) setRepo(d.repos[0].name)
    }).catch(() => {})
  }, [repo])
  useEffect(() => { loadRepos() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadAll = useCallback(() => {
    if (!repo) return
    fetch(`${BASE}/log?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&limit=80`)
      .then((r) => r.json()).then((d) => setCommits(layoutLanes(d.commits ?? []))).catch((e) => setError(String(e)))
    fetch(`${BASE}/status?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json()).then((d) => setFiles(d.files ?? [])).catch(() => {})
    fetch(`${BASE}/branches?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json()).then((d) => setBranches(d.local ?? [])).catch(() => {})
  }, [repo, branch])
  useEffect(() => { loadAll() }, [loadAll])

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
    setSelectedCommit(c); setFileDiff(null); setBlameData(null)
    fetch(`${BASE}/diff/commit?repo=${encodeURIComponent(repo)}&sha=${c.sha}`)
      .then((r) => r.json()).then((d) => setCommitDiff(d.patch ?? '')).catch(() => setCommitDiff(null))
  }
  const showFileDiff = (f: FileStatus, staged: boolean) => {
    setSelectedCommit(null); setBlameData(null)
    fetch(`${BASE}/diff/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(f.path)}&staged=${staged ? 1 : 0}`)
      .then((r) => r.json()).then((d) => setFileDiff({ path: f.path, staged, patch: d.patch ?? '' })).catch(() => {})
  }
  const showBlame = (f: FileStatus) => {
    setSelectedCommit(null); setFileDiff(null)
    fetch(`${BASE}/blame?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(f.path)}`)
      .then((r) => r.json()).then((d) => setBlameData({ path: f.path, lines: d.lines ?? [] })).catch(() => {})
  }

  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)
  const laneColors = ['text-accent', 'text-aim', 'text-info', 'text-warn']

  return (
    <div className="flex h-full min-h-0">
      {/* Left: repos + branches */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-[13px] font-semibold text-text-strong">仓库</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {repos.map((r) => (
            <button
              key={r.name}
              onClick={() => { setRepo(r.name); setBranch('HEAD') }}
              className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${repo === r.name ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}
            >
              <span className="truncate text-[12.5px] text-text">{r.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted">{r.branch}</span>
            </button>
          ))}
        </div>
        {branches.length > 0 && (
          <>
            <div className="border-t border-border px-3 py-2 text-[12px] font-semibold text-muted">分支</div>
            <div className="max-h-44 overflow-y-auto p-1.5">
              {branches.map((b) => (
                <div key={b.name} className={`group flex items-center gap-1.5 rounded px-2 py-1 ${branch === b.name ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}>
                  <button onClick={() => setBranch(b.name)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    {b.current && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                    <span className="truncate font-mono text-[11px] text-text">{b.name}</span>
                  </button>
                  <div className="hidden shrink-0 gap-0.5 group-hover:flex">
                    {!b.current && <button className="rounded border border-border px-1 py-px text-[9px] text-accent" onClick={() => { if (window.confirm(`合并 ${b.name} 到当前分支？`)) branchExtra('merge', { source: b.name }) }} title="合并到当前分支">⇄</button>}
                    {!b.current && <button className="rounded border border-border px-1 py-px text-[9px] text-danger" onClick={() => { if (window.confirm(`删除分支 ${b.name}？`)) branchExtra('delete', { name: b.name }) }}>×</button>}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1 border-t border-border p-2">
              <button className="flex-1 rounded border border-border px-2 py-1 text-[10.5px] text-muted hover:bg-bg-hover" onClick={() => branchExtra('stash', { message: `stash ${new Date().toLocaleTimeString('zh-CN')}` })}>Stash</button>
              <button className="flex-1 rounded border border-border px-2 py-1 text-[10.5px] text-muted hover:bg-bg-hover" onClick={() => branchExtra('stash-pop')}>Pop</button>
            </div>
            <div className="border-t border-border p-2">
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
                className="h-7 w-full rounded border border-border bg-bg px-2 font-mono text-[11px] text-text outline-none placeholder:text-muted"
              />
            </div>
          </>
        )}
      </aside>

      {/* Center: commit history with graph */}
      <div className="flex min-w-0 flex-[1.2] flex-col border-r border-border">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <span className="text-[13px] font-semibold text-text-strong">提交历史</span>
          <span className="font-mono text-[10px] text-muted">{branch} · {commits.length} commits</span>
          <button className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={loadAll}>刷新</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {commits.map((c) => (
            <button
              key={c.sha}
              onClick={() => showCommitDiff(c)}
              className={`flex w-full items-start gap-2 border-b border-border/40 px-3 py-2 text-left hover:bg-bg-hover ${selectedCommit?.sha === c.sha ? 'bg-accent-subtle' : ''}`}
            >
              {/* Lane graph dot */}
              <span className={`mt-1.5 shrink-0 font-mono text-[10px] ${laneColors[(c.lane ?? 0) % 4]}`}>
                {(c.lane ?? 0) === 0 ? '●' : (c.lane ?? 0) === 1 ? '○' : (c.lane ?? 0) === 2 ? '◆' : '◇'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-text">{c.subject}</span>
                  {c.refs.length > 0 && (
                    <span className="shrink-0 rounded border border-accent px-1 py-px font-mono text-[9px] text-accent">{c.refs[0]}</span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-muted">
                  <span>{c.author}</span>
                  <span>·</span>
                  <span>{new Date(c.timestamp * 1000).toLocaleDateString('zh-CN')}</span>
                  <span className="font-mono">{c.short}</span>
                  {c.parents.length > 1 && <span className="text-warn">merge</span>}
                </div>
              </div>
            </button>
          ))}
          {commits.length === 0 && <p className="p-4 text-center text-[12px] text-muted">选择仓库查看历史</p>}
        </div>
      </div>

      {/* Right: working directory / diff / blame */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <span className="text-[13px] font-semibold text-text-strong">
            {selectedCommit ? `提交 · ${selectedCommit.short}` : fileDiff ? `Diff · ${fileDiff.path}` : blameData ? `Blame · ${blameData.path}` : '工作目录'}
          </span>
          {(fileDiff || blameData || selectedCommit) && (
            <button className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={() => { setSelectedCommit(null); setFileDiff(null); setBlameData(null) }}>返回</button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <div className="m-3 rounded border border-danger bg-danger-subtle px-3 py-2 text-[12px] text-danger">{error}</div>}

          {/* Commit detail / file diff / blame */}
          {selectedCommit && (
            <div className="p-3">
              <div className="mb-2 text-[13px] font-medium text-text-strong">{selectedCommit.subject}</div>
              <div className="mb-3 text-[11.5px] text-muted">{selectedCommit.author} · {new Date(selectedCommit.timestamp * 1000).toLocaleString('zh-CN')} · {selectedCommit.sha.slice(0, 8)}</div>
              <pre className="overflow-auto rounded border border-border bg-bg p-3 font-mono text-[10.5px] leading-5 text-text">{commitDiff}</pre>
            </div>
          )}
          {fileDiff && (
            <pre className="p-3 font-mono text-[10.5px] leading-5 text-text">{fileDiff.patch}</pre>
          )}
          {blameData && (
            <div className="p-3">
              {blameData.lines.map((l, i) => (
                <div key={i} className="flex gap-2 font-mono text-[10.5px] leading-5">
                  <span className="w-16 shrink-0 text-muted">{l.sha}</span>
                  <span className="w-24 shrink-0 truncate text-info">{l.author}</span>
                  <span className="min-w-0 flex-1 whitespace-pre text-text">{l.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* Working directory (default view) */}
          {!selectedCommit && !fileDiff && !blameData && (
            <div className="p-3">
              {/* Commit box */}
              {staged.length > 0 && (
                <div className="mb-3 rounded-lg border border-border bg-card p-2.5">
                  <textarea
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    placeholder="提交信息…"
                    rows={2}
                    className="mb-2 w-full resize-none rounded border border-border bg-bg px-2 py-1.5 text-[12px] text-text outline-none placeholder:text-muted"
                  />
                  <div className="flex gap-2">
                    <button
                      disabled={!commitMsg.trim()}
                      className="rounded bg-accent px-3 py-1 text-[11.5px] text-accent-fg hover:opacity-90 disabled:opacity-40"
                      onClick={() => { stageOp('commit', { message: commitMsg }); setCommitMsg('') }}
                    >提交 ({staged.length} 文件)</button>
                    <button className="rounded border border-border px-2 py-1 text-[11.5px] text-muted hover:bg-bg-hover" onClick={() => stageOp('all', { unstage: true })}>全部反暂存</button>
                  </div>
                </div>
              )}

              {/* Staged files */}
              {staged.length > 0 && (
                <div className="mb-3">
                  <div className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-ok">
                    已暂存 ({staged.length})
                    <button className="rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted hover:bg-bg-hover" onClick={() => stageOp('all')}>暂存全部</button>
                  </div>
                  {staged.map((f) => (
                    <div key={f.path} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-bg-hover">
                      <span className="font-mono text-[10px] text-ok">✓</span>
                      <button className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-text" onClick={() => showFileDiff(f, true)}>{f.path}</button>
                      <button className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted group-hover:block" onClick={() => stageOp('file', { path: f.path, unstage: true })}>反暂存</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Unstaged files */}
              <div>
                <div className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-muted">
                  未暂存 ({unstaged.length})
                  {unstaged.length > 0 && <button className="rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted hover:bg-bg-hover" onClick={() => stageOp('all')}>暂存全部</button>}
                </div>
                {unstaged.map((f) => (
                  <div key={f.path} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-bg-hover">
                    <span className={`font-mono text-[10px] ${f.untracked ? 'text-warn' : 'text-danger'}`}>{f.status}</span>
                    <button className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-text" onClick={() => showFileDiff(f, false)}>{f.path}</button>
                    <div className="hidden gap-1 group-hover:flex">
                      <button className="rounded border border-border px-1.5 py-0.5 text-[10px] text-accent" onClick={() => stageOp('file', { path: f.path })}>暂存</button>
                      <button className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted" onClick={() => showBlame(f)}>Blame</button>
                      {!f.untracked && <button className="rounded border border-danger px-1.5 py-0.5 text-[10px] text-danger" onClick={() => { if (window.confirm(`丢弃 ${f.path} 的未暂存改动？`)) branchExtra('discard', { path: f.path }) }}>丢弃</button>}
                    </div>
                  </div>
                ))}
                {unstaged.length === 0 && staged.length === 0 && (
                  <p className="py-4 text-center text-[12px] text-muted">工作目录干净</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
