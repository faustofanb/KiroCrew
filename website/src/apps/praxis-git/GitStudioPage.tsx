/**
 * Git Studio — a Fork-class visual Git client as a KiroCrew page.
 *
 * Three-pane layout: sidebar (repos + branch/tag/remote tree) · center
 * (network bar, virtualized commit graph, working directory with the commit
 * box) · right (context detail: commit diff, file diff with line-level
 * staging, blame, file history, stash, conflict resolver, rebase editor,
 * search results). Every control drives a real git invocation through the
 * typed backend; destructive ops confirm, long ops stream progress, and
 * every list carries empty/loading/error states.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  FileClock,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from 'lucide-react'
import { api, GitStudioApiError } from './api'
import SimpleSelect from '../../components/SimpleSelect'
import { i18nT } from '../../i18n/t'
import type {
  Branch,
  ConflictItem,
  DiffFile,
  GraphPage,
  RepoStatus,
  RepoSummary,
  RebaseStatus,
  CommitRow,
  StashItem,
  Tag,
  Remote,
} from './types'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { CommitGraph } from './components/CommitGraph'
import { ConflictResolver } from './components/ConflictResolver'
import { DiffViewer } from './components/DiffViewer'
import { NetworkBar } from './components/NetworkBar'
import { RebasePanel } from './components/RebasePanel'
import { StashPanel } from './components/StashPanel'
import { BlameView, FileHistoryView } from './components/HistoryViews'
import { BranchTree } from './components/BranchTree'
import { ConfirmDialog, LoadState, Notices, TriState, type Notice } from './components/common'

type RightView =
  | { kind: 'none' }
  | { kind: 'commit'; sha: string }
  | { kind: 'file'; path: string; staged: boolean }
  | { kind: 'blame'; path: string }
  | { kind: 'history'; path: string }
  | { kind: 'stash' }
  | { kind: 'conflict' }
  | { kind: 'rebase' }
  | { kind: 'search'; query: string }

export default function GitStudioPage() {
  // ── repos ────────────────────────────────────────────────────────────────
  const [repos, setRepos] = useState<RepoSummary[]>([])
  const [reposState, setReposState] = useState<LoadState>('idle')
  const [reposError, setReposError] = useState<string | null>(null)
  const [repoId, setRepoId] = useState<string | null>(null)
  const [addPath, setAddPath] = useState('')
  const [adding, setAdding] = useState(false)

  // ── working state ────────────────────────────────────────────────────────
  const [status, setStatus] = useState<RepoStatus | null>(null)

  // ── graph ────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<CommitRow[]>([])
  const [graphMeta, setGraphMeta] = useState<{ session: string; total: number; hasMore: boolean; truncated: boolean; cap: number } | null>(null)
  const [graphState, setGraphState] = useState<LoadState>('idle')
  const [graphError, setGraphError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [branch] = useState('HEAD')
  const [firstParent, setFirstParent] = useState(false)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)

  // ── right panel ──────────────────────────────────────────────────────────
  const [view, setView] = useState<RightView>({ kind: 'none' })
  const [revDiff, setRevDiff] = useState<DiffFile[] | null>(null)
  const [fileDiff, setFileDiff] = useState<DiffFile[] | null>(null)
  const [diffState, setDiffState] = useState<LoadState>('idle')
  const [diffError, setDiffError] = useState<string | null>(null)
  const [sbs, setSbs] = useState(true)
  const [ignoreWs, setIgnoreWs] = useState('none')
  const [wordDiff, setWordDiff] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // ── sidebar data ─────────────────────────────────────────────────────────
  const [branchData, setBranchData] = useState<{ local: Branch[]; remote: { name: string; sha: string; timestamp: number }[] } | null>(null)
  const [tags, setTags] = useState<Tag[] | null>(null)
  const [remotes, setRemotes] = useState<{ remotes: Remote[]; defaultRemote: string } | null>(null)
  const [sideState, setSideState] = useState<LoadState>('idle')
  const [sideError, setSideError] = useState<string | null>(null)
  const [stashes, setStashes] = useState<StashItem[]>([])
  const [conflicts, setConflicts] = useState<ConflictItem[]>([])
  const [conflictState, setConflictState] = useState<LoadState>('idle')
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [rebaseStatus, setRebaseStatus] = useState<RebaseStatus | null>(null)

  // ── commit box / confirm / notices ──────────────────────────────────────
  const [commitMsg, setCommitMsg] = useState('')
  const [commitBusy, setCommitBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; body: string; danger?: boolean; run: () => Promise<void> } | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const notice = useCallback((kind: Notice['kind'], text: string) => {
    setNotices((n) => [...n.slice(-4), { id: Date.now() + Math.random(), kind, text }])
  }, [])
  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), [])

  const errText = (e: unknown) => (e instanceof GitStudioApiError ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e))

  // ── data loading ─────────────────────────────────────────────────────────
  const loadRepos = useCallback(async () => {
    setReposState('loading')
    try {
      const d = await api.listRepos()
      setRepos(d.repos)
      setReposState('ready')
      setRepoId((cur) => cur ?? d.repos[0]?.id ?? null)
    } catch (e) {
      setReposError(errText(e))
      setReposState('error')
    }
  }, [])

  useEffect(() => {
    void loadRepos()
  }, [loadRepos])

  const loadGraph = useCallback(
    async (opts: { refresh?: boolean } = {}) => {
      if (!repoId) return
      setGraphState('loading')
      setGraphError(null)
      try {
        const g: GraphPage = await api.graph({
          repo: repoId,
          branch,
          firstParent,
          session: opts.refresh ? null : graphMeta?.session,
          offset: 0,
          limit: 400,
          refresh: opts.refresh,
        })
        setRows(g.rows)
        setGraphMeta({ session: g.session, total: g.total, hasMore: g.hasMore, truncated: g.truncated, cap: g.cap })
        setGraphState('ready')
      } catch (e) {
        setGraphError(errText(e))
        setGraphState('error')
      }
    },
    [repoId, branch, firstParent, graphMeta?.session],
  )

  const loadMore = useCallback(async () => {
    if (!repoId || !graphMeta?.hasMore || loadingMore || graphState !== 'ready') return
    setLoadingMore(true)
    try {
      const g = await api.graph({
        repo: repoId,
        branch,
        firstParent,
        session: graphMeta.session,
        offset: rows.length,
        limit: 400,
      })
      setRows((prev) => [...prev, ...g.rows])
      setGraphMeta((m) => (m ? { ...m, hasMore: g.hasMore } : m))
    } catch (e) {
      notice('error', errText(e))
    } finally {
      setLoadingMore(false)
    }
  }, [repoId, graphMeta, loadingMore, graphState, branch, firstParent, rows.length, notice])

  const loadStatus = useCallback(async () => {
    if (!repoId) return
    try {
      const s = await api.repoStatus(repoId)
      setStatus(s)
    } catch {
      // poll errors keep the last good state; the banner shows staleness
    }
  }, [repoId])

  const loadSide = useCallback(async () => {
    if (!repoId) return
    setSideState('loading')
    try {
      const [b, t, r, st] = await Promise.all([api.branches(repoId), api.tags(repoId), api.remotes(repoId), api.stashList(repoId)])
      setBranchData({ local: b.local, remote: b.remote })
      setTags(t.tags)
      setRemotes(r)
      setStashes(st.stashes)
      setSideState('ready')
    } catch (e) {
      setSideError(errText(e))
      setSideState('error')
    }
  }, [repoId])

  const loadConflictState = useCallback(async () => {
    if (!repoId) return
    setConflictState('loading')
    try {
      const [c, rb] = await Promise.all([api.conflicts(repoId), api.rebaseStatus(repoId)])
      setConflicts(c.conflicts)
      setConflictError(null)
      setConflictState('ready')
      setRebaseStatus(rb)
    } catch (e) {
      setConflictError(errText(e))
      setConflictState('error')
    }
  }, [repoId])

  useEffect(() => {
    if (!repoId) return
    setView({ kind: 'none' })
    setRows([])
    setGraphMeta(null)
    setSelectedSha(null)
    void loadGraph({ refresh: true })
    void loadStatus()
    void loadSide()
    void loadConflictState()
  }, [repoId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!repoId) return
    setRows([])
    setGraphMeta(null)
    void loadGraph({ refresh: true })
  }, [branch, firstParent]) // eslint-disable-line react-hooks/exhaustive-deps

  // status polling — only while the tab is visible
  useEffect(() => {
    if (!repoId) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void loadStatus()
    }, 4000)
    return () => clearInterval(id)
  }, [repoId, loadStatus])

  const refreshAll = useCallback(
    (opts: { graph?: boolean } = {}) => {
      void loadStatus()
      void loadSide()
      void loadConflictState()
      void loadRepos()
      if (opts.graph) void loadGraph({ refresh: true })
    },
    [loadStatus, loadSide, loadConflictState, loadRepos, loadGraph],
  )

  // ── right panel loaders ──────────────────────────────────────────────────
  useEffect(() => {
    if (view.kind === 'commit') {
      if (!repoId) return
      let cancelled = false
      setDiffState('loading')
      api
        .diffRev(repoId, view.sha, { ignoreWs, wordDiff })
        .then((d) => {
          if (cancelled) return
          setRevDiff(d.files)
          setDiffState('ready')
        })
        .catch((e) => {
          if (cancelled) return
          setDiffError(errText(e))
          setDiffState('error')
        })
      return () => {
        cancelled = true
      }
    }
    if (view.kind === 'file') {
      if (!repoId) return
      let cancelled = false
      setDiffState('loading')
      api
        .diffWorktree(repoId, { path: view.path, staged: view.staged, ignoreWs, wordDiff })
        .then((d) => {
          if (cancelled) return
          setFileDiff(d.files)
          setDiffState('ready')
        })
        .catch((e) => {
          if (cancelled) return
          setDiffError(errText(e))
          setDiffState('error')
        })
      return () => {
        cancelled = true
      }
    }
    setRevDiff(null)
    setFileDiff(null)
  }, [view, repoId, ignoreWs, wordDiff])

  // ── operations ───────────────────────────────────────────────────────────
  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, opts: { graph?: boolean } = {}) => {
      setBusy(true)
      try {
        await fn()
        notice('ok', label)
        refreshAll(opts)
      } catch (e) {
        notice('error', errText(e))
      } finally {
        setBusy(false)
      }
    },
    [notice, refreshAll],
  )

  const stageLines = useCallback(
    (path: string, selections: { hunk: number; keys: string[] }[]) => {
      if (!repoId || view.kind !== 'file') return
      const staged = view.staged
      void run(staged ? i18nT('apps.gitStudio.notice.unstagedLines') : i18nT('apps.gitStudio.notice.stagedLines'), () =>
        api.stageLines(repoId, path, selections, staged),
      ).then(() => {
        // re-open the file diff to reflect the new split
        setView({ kind: 'file', path, staged })
      })
    },
    [repoId, view, run],
  )

  const doCommit = useCallback(
    async (amend: boolean) => {
      if (!repoId || (!commitMsg.trim() && !amend)) return
      setCommitBusy(true)
      try {
        await api.commit(repoId, commitMsg, { amend })
        notice('ok', i18nT('apps.gitStudio.notice.committed'))
        setCommitMsg('')
        refreshAll({ graph: true })
      } catch (e) {
        notice('error', errText(e))
      } finally {
        setCommitBusy(false)
      }
    },
    [repoId, commitMsg, notice, refreshAll],
  )

  const openCommit = useCallback((c: CommitRow) => {
    setSelectedSha(c.sha)
    setView({ kind: 'commit', sha: c.sha })
  }, [])

  const moveSelection = useCallback(
    (delta: number) => {
      if (!rows.length) return
      const idx = rows.findIndex((r) => r.sha === selectedSha)
      const next = idx < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, idx + delta))
      const target = rows[next]
      if (target.sha !== selectedSha) openCommit(target)
    },
    [rows, selectedSha, openCommit],
  )

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (typing) return
      if (e.key === 'j') {
        e.preventDefault()
        moveSelection(1)
      } else if (e.key === 'k') {
        e.preventDefault()
        moveSelection(-1)
      } else if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
      } else if (e.key === 'r') {
        refreshAll({ graph: true })
      } else if (e.key === 'u') {
        if (repoId) void run(i18nT('apps.gitStudio.notice.stagedAll'), () => api.stageAll(repoId))
      } else if (e.key === 's') {
        setView({ kind: 'stash' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveSelection, refreshAll, repoId, run])

  const doSearch = useCallback(async () => {
    if (!repoId || !searchQuery.trim()) return
    setView({ kind: 'search', query: searchQuery.trim() })
  }, [repoId, searchQuery])

  // ── derived ──────────────────────────────────────────────────────────────
  const current = repos.find((r) => r.id === repoId) ?? null
  const inProgress = status?.inProgress ?? null
  const fileZones = useMemo(() => {
    const staged = status?.files.filter((f) => f.staged) ?? []
    const unstaged = status?.files.filter((f) => !f.staged && !f.untracked && !f.conflict) ?? []
    const untracked = status?.files.filter((f) => f.untracked) ?? []
    const conflicted = status?.files.filter((f) => f.conflict) ?? []
    return { staged, unstaged, untracked, conflicted }
  }, [status?.files])

  const paletteActions: PaletteAction[] = useMemo(() => {
    // filter matches the label AND the english action id, so searchability
    // survives translation without shipping literal copy
    const acts: PaletteAction[] = [
      { id: 'refresh', label: i18nT('apps.gitStudio.palette.refresh'), run: () => refreshAll({ graph: true }) },
      { id: 'stash', label: i18nT('apps.gitStudio.palette.openStash'), run: () => setView({ kind: 'stash' }) },
      { id: 'rebase', label: i18nT('apps.gitStudio.palette.openRebase'), run: () => setView({ kind: 'rebase' }) },
      { id: 'stage all', label: i18nT('apps.gitStudio.palette.stageAll'), run: () => repoId && void run(i18nT('apps.gitStudio.notice.stagedAll'), () => api.stageAll(repoId)) },
      { id: 'unstage all', label: i18nT('apps.gitStudio.palette.unstageAll'), run: () => repoId && void run(i18nT('apps.gitStudio.notice.unstagedAll'), () => api.stageAll(repoId, true)) },
      { id: 'stash push', label: i18nT('apps.gitStudio.palette.stashPush'), run: () => repoId && void run(i18nT('apps.gitStudio.stash.pushed'), () => api.stashOp(repoId, { op: 'push' })) },
    ]
    if (selectedSha) {
      acts.push(
        { id: 'cherry pick', label: i18nT('apps.gitStudio.palette.cherryPick'), run: () => repoId && void run(i18nT('apps.gitStudio.notice.cherryPicked'), () => api.cherryPick(repoId, [selectedSha]), { graph: true }) },
        { id: 'revert', label: i18nT('apps.gitStudio.palette.revert'), run: () => repoId && void run(i18nT('apps.gitStudio.notice.reverted'), () => api.revert(repoId, [selectedSha]), { graph: true }) },
        { id: 'reset soft', label: i18nT('apps.gitStudio.palette.resetSoft'), run: () => repoId && setConfirm({ title: i18nT('apps.gitStudio.confirm.resetTitle', { mode: 'soft' }), body: i18nT('apps.gitStudio.confirm.resetBody', { sha: selectedSha.slice(0, 8), mode: 'soft' }), run: async () => { await api.reset(repoId, selectedSha, 'soft') } }) },
        { id: 'reset mixed', label: i18nT('apps.gitStudio.palette.resetMixed'), run: () => repoId && setConfirm({ title: i18nT('apps.gitStudio.confirm.resetTitle', { mode: 'mixed' }), body: i18nT('apps.gitStudio.confirm.resetBody', { sha: selectedSha.slice(0, 8), mode: 'mixed' }), run: async () => { await api.reset(repoId, selectedSha, 'mixed') } }) },
        { id: 'reset hard', label: i18nT('apps.gitStudio.palette.resetHard'), danger: true, run: () => repoId && setConfirm({ title: i18nT('apps.gitStudio.confirm.resetTitle', { mode: 'hard' }), body: i18nT('apps.gitStudio.confirm.resetBody', { sha: selectedSha.slice(0, 8), mode: 'hard' }), danger: true, run: async () => { await api.reset(repoId, selectedSha, 'hard') } }) },
        { id: 'checkout commit', label: i18nT('apps.gitStudio.palette.checkoutCommit'), run: () => repoId && void run(i18nT('apps.gitStudio.notice.checkedOut'), () => api.branchOp(repoId, { op: 'checkout', ref: selectedSha }), { graph: true }) },
      )
    }
    return acts
  }, [refreshAll, repoId, run, selectedSha])

  const addRepo = async () => {
    if (!addPath.trim()) return
    setAdding(true)
    try {
      const out = await api.addRepo(addPath.trim())
      notice('ok', out.alreadyRegistered ? i18nT('apps.gitStudio.notice.repoRegistered') : i18nT('apps.gitStudio.notice.repoAdded'))
      setAddPath('')
      await loadRepos()
      setRepoId(out.id)
    } catch (e) {
      notice('error', errText(e))
    } finally {
      setAdding(false)
    }
  }

  // ── render helpers ───────────────────────────────────────────────────────
  const fileRow = (f: (typeof fileZones)['staged'][number], zone: 'staged' | 'unstaged' | 'untracked' | 'conflicted') => (
    <div key={`${zone}-${f.path}`} className="group flex items-center gap-1.5 rounded px-2 py-1 hover:bg-bg-hover" data-testid={`wfile-${zone}-${f.path}`}>
      <span
        className={`w-6 shrink-0 rounded text-center font-mono text-[9px] ${
          zone === 'staged' ? 'bg-ok-subtle text-ok' : zone === 'conflicted' ? 'bg-danger-subtle text-danger' : zone === 'untracked' ? 'bg-warn-subtle text-warn' : 'bg-danger-subtle/60 text-danger'
        }`}
        title={f.label}
      >
        {zone === 'conflicted' ? f.status : zone === 'staged' ? 'A/M' : f.status}
      </span>
      <button
        className="min-w-0 flex-1 truncate text-left font-mono text-[10.5px] text-text"
        title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        onClick={() => {
          if (zone === 'conflicted') setView({ kind: 'conflict' })
          else setView({ kind: 'file', path: f.path, staged: zone === 'staged' })
        }}
      >
        {f.oldPath && <span className="text-muted">{f.oldPath} → </span>}
        {f.path}
      </button>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        {zone === 'staged' && repoId && (
          <button className="rounded border border-border px-1 py-px text-[9px] text-muted" disabled={busy} onClick={() => void run(i18nT('apps.gitStudio.notice.unstaged'), () => api.stageFiles(repoId, [f.path], true))}>
            {i18nT('apps.gitStudio.workdir.unstage')}
          </button>
        )}
        {(zone === 'unstaged' || zone === 'untracked') && repoId && (
          <button className="rounded border border-accent px-1 py-px text-[9px] text-accent" disabled={busy} onClick={() => void run(i18nT('apps.gitStudio.notice.staged'), () => api.stageFiles(repoId, [f.path]))}>
            {i18nT('apps.gitStudio.workdir.stage')}
          </button>
        )}
        {(zone === 'unstaged' || zone === 'untracked') && (
          <button
            className="rounded border border-border px-1 py-px text-[9px] text-muted"
            onClick={() => setView({ kind: 'history', path: f.path })}
            title={i18nT('apps.gitStudio.workdir.history')}
          >
            <FileClock size={9} />
          </button>
        )}
        {zone !== 'staged' && zone !== 'conflicted' && repoId && (
          <button
            className="rounded border border-danger px-1 py-px text-[9px] text-danger"
            onClick={() =>
              setConfirm({
                title: i18nT('apps.gitStudio.confirm.discardTitle'),
                body: i18nT('apps.gitStudio.confirm.discardBody', { path: f.path }),
                danger: true,
                run: async () => {
                  await api.discard(repoId, [f.path])
                },
              })
            }
          >
            {i18nT('apps.gitStudio.workdir.discard')}
          </button>
        )}
        {zone !== 'conflicted' && (
          <button className="rounded border border-border px-1 py-px text-[9px] text-muted" onClick={() => setView({ kind: 'blame', path: f.path })} title={i18nT('apps.gitStudio.workdir.blame')}>
            {i18nT('apps.gitStudio.workdir.blameShort')}
          </button>
        )}
      </div>
    </div>
  )

  const viewTabs: { id: RightView['kind']; label: string }[] = [
    { id: 'commit', label: i18nT('apps.gitStudio.view.commit') },
    { id: 'file', label: i18nT('apps.gitStudio.view.file') },
    { id: 'blame', label: i18nT('apps.gitStudio.view.blame') },
    { id: 'history', label: i18nT('apps.gitStudio.view.history') },
    { id: 'stash', label: i18nT('apps.gitStudio.view.stash') },
    { id: 'conflict', label: i18nT('apps.gitStudio.view.conflict') },
    { id: 'rebase', label: i18nT('apps.gitStudio.view.rebase') },
    { id: 'search', label: i18nT('apps.gitStudio.view.search') },
  ]

  return (
    <div className="flex h-full min-h-0 bg-bg text-text">
      {/* ── sidebar ─────────────────────────────────────────────────────── */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <GitBranch size={13} className="text-accent" />
          <span className="text-[13px] font-semibold text-text-strong">{i18nT('apps.gitStudio.title')}</span>
        </div>
        <div className="flex items-center gap-1 border-b border-border p-1.5">
          <FolderPlus size={12} className="shrink-0 text-muted" />
          <input
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addRepo()}
            placeholder={i18nT('apps.gitStudio.repos.addPlaceholder')}
            disabled={adding}
            className="h-6.5 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-[10px] text-text outline-none placeholder:text-muted focus:border-accent"
            data-testid="add-repo-input"
          />
          <button className="shrink-0 rounded border border-border p-1 text-muted hover:bg-bg-hover hover:text-text" onClick={() => void addRepo()} disabled={adding} title={i18nT('apps.gitStudio.repos.add')} data-testid="add-repo-go">
            {adding ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
          </button>
        </div>
        <div className="max-h-44 shrink-0 overflow-y-auto border-b border-border p-1">
          <TriState state={reposState} error={reposError} empty={!repos.length} emptyText={i18nT('apps.gitStudio.repos.empty')}>
            {repos.map((r) => (
              <div key={r.id} className={`group flex items-center gap-1.5 rounded px-2 py-1.5 ${repoId === r.id ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`} data-testid={`repo-${r.name}`}>
                <button
                  className="flex min-w-0 flex-1 flex-col text-left"
                  onClick={() => setRepoId(r.id)}
                  title={`${r.path}\n${r.branch}${r.upstream ? ` → ${r.upstream}` : ''}`}
                >
                  <span className="flex items-center gap-1">
                    <span className="truncate text-[11.5px] text-text">{r.name}</span>
                    {!r.available && <AlertTriangle size={10} className="shrink-0 text-danger" />}
                  </span>
                  <span className="flex items-center gap-1 text-[9px] text-muted">
                    <span className="truncate">{r.detached ? `(${r.head})` : r.branch || '—'}</span>
                    {(r.ahead ?? 0) > 0 && <span className="text-ok">↑{r.ahead}</span>}
                    {(r.behind ?? 0) > 0 && <span className="text-warn">↓{r.behind}</span>}
                    {r.counts.staged + r.counts.unstaged + r.counts.untracked > 0 && (
                      <span className="rounded bg-bg-hover px-1 text-[8.5px]">●{r.counts.staged + r.counts.unstaged + r.counts.untracked}</span>
                    )}
                  </span>
                </button>
                <button
                  className="hidden shrink-0 rounded p-0.5 text-muted hover:text-danger group-hover:block"
                  title={i18nT('apps.gitStudio.repos.remove')}
                  onClick={() =>
                    setConfirm({
                      title: i18nT('apps.gitStudio.confirm.removeRepoTitle'),
                      body: i18nT('apps.gitStudio.confirm.removeRepoBody', { name: r.name }),
                      run: async () => {
                        await api.removeRepo(r.id)
                      },
                    })
                  }
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </TriState>
        </div>
        <div className="min-h-0 flex-1">
          <BranchTree
            repo={repoId ?? ''}
            branches={branchData}
            tags={tags}
            remotes={remotes}
            state={sideState}
            error={sideError}
            onRefresh={() => {
              void loadSide()
              void loadStatus()
            }}
            onNotice={notice}
          />
        </div>
      </aside>

      {/* ── center ───────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-[1.15] flex-col">
        {/* header */}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <GitCommitHorizontal size={13} className="shrink-0 text-accent" />
          <span className="shrink-0 truncate text-[12.5px] font-semibold text-text-strong">{current?.name ?? '—'}</span>
          <span className="shrink-0 rounded bg-bg-hover px-1.5 py-px font-mono text-[10px] text-muted">{branch === 'HEAD' ? status?.branch || 'HEAD' : branch}</span>
          {inProgress && (
            <span className="flex shrink-0 items-center gap-1 rounded bg-warn-subtle px-1.5 py-px text-[10px] text-warn">
              <Zap size={9} />
              {inProgress}
            </span>
          )}
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doSearch()}
            placeholder={`${i18nT('apps.gitStudio.graph.searchPlaceholder')}  /`}
            className="h-6.5 min-w-0 max-w-56 flex-1 rounded border border-border bg-bg px-2 text-[11px] text-text outline-none placeholder:text-muted focus:border-accent"
            data-testid="graph-search"
          />
          <label className="flex shrink-0 items-center gap-1 text-[9.5px] text-muted" title={i18nT('apps.gitStudio.graph.firstParentHint')}>
            <input type="checkbox" checked={firstParent} onChange={(e) => setFirstParent(e.target.checked)} className="h-3 w-3" data-testid="first-parent-toggle" />
            1st
          </label>
          <button className="ml-auto shrink-0 rounded border border-border p-1 text-muted hover:bg-bg-hover hover:text-text" onClick={() => refreshAll({ graph: true })} title={`${i18nT('apps.gitStudio.palette.refresh')} (r)`} data-testid="refresh-all">
            <RefreshCw size={11} />
          </button>
        </div>

        {/* in-progress banners */}
        {inProgress === 'merge' && (
          <div className="flex shrink-0 items-center gap-2 border-b border-warn bg-warn-subtle px-3 py-1.5 text-[11px] text-warn" data-testid="merge-banner">
            <AlertTriangle size={12} />
            {conflicts.length > 0 ? (
              <>
                {i18nT('apps.gitStudio.banner.mergeConflicts', { n: String(conflicts.length) })}
                <button className="rounded border border-warn px-2 py-px text-[10px] hover:bg-warn/10" onClick={() => setView({ kind: 'conflict' })}>
                  {i18nT('apps.gitStudio.banner.openResolver')}
                </button>
              </>
            ) : (
              <>
                {i18nT('apps.gitStudio.banner.mergeInProgress')}
                <button
                  className="rounded border border-warn px-2 py-px text-[10px] hover:bg-warn/10"
                  disabled={busy}
                  onClick={() => repoId && void run(i18nT('apps.gitStudio.notice.mergeCommitted'), () => api.mergeContinue(repoId), { graph: true })}
                  data-testid="merge-continue"
                >
                  {i18nT('apps.gitStudio.banner.finishMerge')}
                </button>
              </>
            )}
            <button
              className="ml-auto rounded border border-warn px-2 py-px text-[10px] hover:bg-warn/10"
              disabled={busy}
              onClick={() =>
                setConfirm({
                  title: i18nT('apps.gitStudio.confirm.abortMergeTitle'),
                  body: i18nT('apps.gitStudio.confirm.abortMergeBody'),
                  danger: true,
                  run: async () => {
                    if (repoId) await api.mergeAbort(repoId)
                  },
                })
              }
            >
              {i18nT('apps.gitStudio.banner.abortMerge')}
            </button>
          </div>
        )}
        {(inProgress === 'cherry-pick' || inProgress === 'revert') && (
          <div className="flex shrink-0 items-center gap-2 border-b border-warn bg-warn-subtle px-3 py-1.5 text-[11px] text-warn" data-testid="sequencer-banner">
            <AlertTriangle size={12} />
            {conflicts.length > 0 ? i18nT('apps.gitStudio.banner.sequencerConflicts', { op: inProgress }) : i18nT('apps.gitStudio.banner.sequencerInProgress', { op: inProgress })}
            {conflicts.length > 0 && (
              <button className="rounded border border-warn px-2 py-px text-[10px] hover:bg-warn/10" onClick={() => setView({ kind: 'conflict' })}>
                {i18nT('apps.gitStudio.banner.openResolver')}
              </button>
            )}
            <button
              className="ml-auto rounded border border-warn px-2 py-px text-[10px] hover:bg-warn/10"
              disabled={busy}
              onClick={() => repoId && void run(i18nT('apps.gitStudio.notice.continued'), () => api.sequencer(repoId, 'continue', inProgress === 'cherry-pick' ? 'cherry-pick' : 'revert'), { graph: true })}
            >
              {i18nT('apps.gitStudio.banner.continue')}
            </button>
            <button
              className="rounded border border-warn px-2 py-px text-[10px] hover:bg-warn/10"
              disabled={busy}
              onClick={() =>
                setConfirm({
                  title: i18nT('apps.gitStudio.confirm.abortSequencerTitle', { op: inProgress }),
                  body: i18nT('apps.gitStudio.confirm.abortSequencerBody', { op: inProgress }),
                  danger: true,
                  run: async () => {
                    if (repoId) await api.sequencer(repoId, 'abort', inProgress === 'cherry-pick' ? 'cherry-pick' : 'revert')
                  },
                })
              }
            >
              {i18nT('apps.gitStudio.banner.abort')}
            </button>
          </div>
        )}

        <NetworkBar
          repo={repoId ?? ''}
          defaultRemote={remotes?.defaultRemote ?? 'origin'}
          branch={status?.branch || 'HEAD'}
          onFinished={() => refreshAll({ graph: true })}
          onNotice={notice}
        />

        {/* graph */}
        <TriState state={graphState} error={graphError} empty={!rows.length} emptyText={repoId ? i18nT('apps.gitStudio.graph.empty') : i18nT('apps.gitStudio.repos.empty')}>
          <CommitGraph
            rows={rows}
            total={graphMeta?.total ?? rows.length}
            hasMore={graphMeta?.hasMore ?? false}
            loadingMore={loadingMore}
            truncated={graphMeta?.truncated ?? false}
            cap={graphMeta?.cap ?? 0}
            selectedSha={selectedSha}
            onSelect={openCommit}
            onLoadMore={loadMore}
          />
        </TriState>

        {/* working directory */}
        <div className="flex h-[38%] min-h-40 shrink-0 flex-col border-t-2 border-border">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
            <span className="text-[12px] font-semibold text-text-strong">{i18nT('apps.gitStudio.workdir.title')}</span>
            <span className={`rounded px-1.5 py-px text-[9.5px] ${fileZones.staged.length ? 'bg-ok-subtle text-ok' : 'text-muted'}`} data-testid="count-staged">
              {fileZones.staged.length} {i18nT('apps.gitStudio.workdir.staged')}
            </span>
            <span className={`rounded px-1.5 py-px text-[9.5px] ${fileZones.unstaged.length ? 'bg-warn-subtle text-warn' : 'text-muted'}`}>
              {fileZones.unstaged.length} {i18nT('apps.gitStudio.workdir.unstaged')}
            </span>
            <span className="rounded px-1.5 py-px text-[9.5px] text-muted">
              {fileZones.untracked.length} {i18nT('apps.gitStudio.workdir.untracked')}
            </span>
            {fileZones.conflicted.length > 0 && (
              <button className="rounded bg-danger-subtle px-1.5 py-px text-[9.5px] text-danger" onClick={() => setView({ kind: 'conflict' })} data-testid="count-conflicted">
                {fileZones.conflicted.length} {i18nT('apps.gitStudio.workdir.conflicted')}
              </button>
            )}
            <div className="ml-auto flex gap-1">
              {repoId && (
                <button className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-bg-hover" disabled={busy} onClick={() => void run(i18nT('apps.gitStudio.notice.stagedAll'), () => api.stageAll(repoId))} data-testid="stage-all">
                  +{i18nT('apps.gitStudio.workdir.all')}
                </button>
              )}
              {repoId && fileZones.staged.length > 0 && (
                <button className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-bg-hover" disabled={busy} onClick={() => void run(i18nT('apps.gitStudio.notice.unstagedAll'), () => api.stageAll(repoId, true))}>
                  −{i18nT('apps.gitStudio.workdir.all')}
                </button>
              )}
              {status && status.stashCount > 0 && (
                <button className="rounded border border-warn px-1.5 py-0.5 text-[10px] text-warn hover:bg-warn-subtle" onClick={() => setView({ kind: 'stash' })} data-testid="stash-count">
                  {i18nT('apps.gitStudio.view.stash')} {status.stashCount}
                </button>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="workdir-list">
              {fileZones.conflicted.map((f) => fileRow(f, 'conflicted'))}
              {fileZones.staged.map((f) => fileRow(f, 'staged'))}
              {fileZones.unstaged.map((f) => fileRow(f, 'unstaged'))}
              {fileZones.untracked.map((f) => fileRow(f, 'untracked'))}
              {!status?.files.length && <div className="py-6 text-center text-[11.5px] text-muted">{i18nT('apps.gitStudio.workdir.clean')}</div>}
            </div>
            {/* commit box */}
            <div className="flex w-72 shrink-0 flex-col border-l border-border p-2">
              <textarea
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void doCommit(false)
                }}
                placeholder={i18nT('apps.gitStudio.workdir.commitPlaceholder')}
                rows={3}
                className="mb-1.5 min-h-0 w-full flex-1 resize-none rounded border border-border bg-bg px-2 py-1.5 text-[11.5px] text-text outline-none placeholder:text-muted focus:border-accent"
                data-testid="commit-message"
              />
              <div className="flex gap-1">
                <button
                  className="flex-1 rounded bg-accent px-2 py-1 text-[11px] text-accent-fg hover:opacity-90 disabled:opacity-40"
                  disabled={commitBusy || !repoId || fileZones.staged.length === 0}
                  onClick={() => void doCommit(false)}
                  data-testid="commit-go"
                >
                  {commitBusy ? <Loader2 size={11} className="mx-auto animate-spin" /> : `${i18nT('apps.gitStudio.workdir.commit')} (${fileZones.staged.length})`}
                </button>
                <button
                  className="rounded border border-border px-2 py-1 text-[11px] text-muted hover:bg-bg-hover disabled:opacity-40"
                  disabled={commitBusy || !repoId}
                  onClick={() => void doCommit(true)}
                  title={i18nT('apps.gitStudio.workdir.amendHint')}
                >
                  {i18nT('apps.gitStudio.workdir.amend')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── right panel ──────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col border-l border-border">
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2">
          {viewTabs.map((t) => (
            <button
              key={t.id}
              className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${view.kind === t.id ? 'bg-accent-subtle font-semibold text-accent' : 'text-muted hover:bg-bg-hover'}`}
              onClick={() => {
                if (t.id === 'commit' && selectedSha) setView({ kind: 'commit', sha: selectedSha })
                else if (t.id === 'stash' || t.id === 'conflict' || t.id === 'rebase') setView({ kind: t.id } as RightView)
                else if (t.id === 'search') setView({ kind: 'search', query: searchQuery || '' })
                else if (view.kind !== t.id) notice('info', i18nT('apps.gitStudio.view.pickTargetFirst'))
              }}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {view.kind === 'file' && (
              <label className="flex items-center gap-1 text-[9.5px] text-muted" title={i18nT('apps.gitStudio.diff.sbsHint')}>
                <input type="checkbox" checked={sbs} onChange={(e) => setSbs(e.target.checked)} className="h-3 w-3" data-testid="sbs-toggle" />
                {i18nT('apps.gitStudio.diff.sbs')}
              </label>
            )}
            {(view.kind === 'file' || view.kind === 'commit') && (
              <>
                <SimpleSelect
                  options={['none', 'eol', 'space', 'all']}
                  optionLabels={[i18nT('apps.gitStudio.diff.wsNone'), i18nT('apps.gitStudio.diff.wsEol'), i18nT('apps.gitStudio.diff.wsSpace'), i18nT('apps.gitStudio.diff.wsAll')]}
                  value={ignoreWs}
                  onChange={setIgnoreWs}
                  aria-label={i18nT('apps.gitStudio.diff.wsHint')}
                  className="h-6 text-[9.5px]"
                  labelsInListOnly
                />
                <label className="flex items-center gap-1 text-[9.5px] text-muted">
                  <input type="checkbox" checked={wordDiff} onChange={(e) => setWordDiff(e.target.checked)} className="h-3 w-3" data-testid="worddiff-toggle" />
                  {i18nT('apps.gitStudio.diff.wordDiff')}
                </label>
              </>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {view.kind === 'none' && (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-muted">
              <Layers size={22} className="opacity-40" />
              {i18nT('apps.gitStudio.view.noneHint')}
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘K</span>
            </div>
          )}

          {view.kind === 'commit' && (
            <div className="flex h-full flex-col">
              <CommitHeader sha={view.sha} rows={rows} />
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <TriState state={diffState} error={diffError} empty={!revDiff?.length} emptyText={i18nT('apps.gitStudio.diff.noChanges')}>
                  {revDiff && <DiffViewer files={revDiff} staging="none" sbs={sbs} />}
                </TriState>
              </div>
            </div>
          )}

          {view.kind === 'file' && (
            <div className="flex h-full flex-col">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3">
                <span className="truncate font-mono text-[11.5px] text-text-strong">{view.path}</span>
                <span className={`shrink-0 rounded px-1.5 py-px text-[9.5px] ${view.staged ? 'bg-ok-subtle text-ok' : 'bg-warn-subtle text-warn'}`}>
                  {view.staged ? i18nT('apps.gitStudio.workdir.staged') : i18nT('apps.gitStudio.workdir.unstaged')}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <TriState state={diffState} error={diffError} empty={!fileDiff?.length} emptyText={i18nT('apps.gitStudio.diff.noChanges')}>
                  {fileDiff && repoId && (
                    <DiffViewer
                      files={fileDiff}
                      staging={view.staged ? 'staged' : 'worktree'}
                      sbs={sbs}
                      busy={busy}
                      onStageSelection={(path, selections) => stageLines(path, selections)}
                    />
                  )}
                </TriState>
              </div>
            </div>
          )}

          {view.kind === 'blame' && repoId && <BlameView repo={repoId} path={view.path} onOpenCommit={(sha) => setView({ kind: 'commit', sha })} />}
          {view.kind === 'history' && repoId && <FileHistoryView repo={repoId} path={view.path} onOpenCommit={(sha) => setView({ kind: 'commit', sha })} />}
          {view.kind === 'stash' && repoId && <StashPanel repo={repoId} stashes={stashes} state={sideState} error={sideError} onRefresh={() => refreshAll({ graph: true })} onNotice={notice} />}
          {view.kind === 'conflict' && repoId && (
            <ConflictResolver repo={repoId} conflicts={conflicts} state={conflictState} error={conflictError} onResolved={() => refreshAll({ graph: true })} onNotice={notice} />
          )}
          {view.kind === 'rebase' && repoId && (
            <RebasePanel repo={repoId} branches={(branchData?.local ?? []).map((b) => b.name)} status={rebaseStatus} state={sideState} error={sideError} onChanged={() => refreshAll({ graph: true })} onNotice={notice} />
          )}
          {view.kind === 'search' && repoId && <SearchResultsView repo={repoId} query={view.query} onOpenCommit={(sha) => setView({ kind: 'commit', sha })} />}
        </div>
      </div>

      {/* overlays */}
      <CommandPalette open={paletteOpen} actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const c = confirm
          setConfirm(null)
          if (c) await run(i18nT('apps.gitStudio.common.done'), c.run, { graph: true })
        }}
      />
      <Notices notices={notices} onDismiss={dismiss} />
    </div>
  )
}

function CommitHeader(props: { sha: string; rows: CommitRow[] }) {
  const c = props.rows.find((r) => r.sha === props.sha)
  if (!c) {
    return (
      <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-3 font-mono text-[11.5px] text-text-strong">
        {props.sha.slice(0, 10)}
      </div>
    )
  }
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <span className="truncate text-[12px] font-medium text-text-strong" title={c.subject}>
        {c.subject}
      </span>
      <span className="ml-auto shrink-0 text-[10px] text-muted">
        {c.author.split(' ')[0]} · {c.timestamp ? new Date(c.timestamp * 1000).toLocaleString() : ''} · <span className="font-mono">{c.short}</span>
      </span>
    </div>
  )
}

function SearchResultsView(props: { repo: string; query: string; onOpenCommit: (sha: string) => void }) {
  const [results, setResults] = useState<CommitRow[]>([])
  const [state, setState] = useState<LoadState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState('all')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    api
      .search(props.repo, props.query, { mode, limit: 200, branch: 'HEAD' })
      .then((d) => {
        if (cancelled) return
        setResults(d.commits)
        setState('ready')
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [props.repo, props.query, mode])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="search-results">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Search size={12} className="text-muted" />
        <span className="truncate text-[12px] font-semibold text-text-strong">{props.query}</span>
        <SimpleSelect
          options={['all', 'message', 'author']}
          optionLabels={[i18nT('apps.gitStudio.search.all'), i18nT('apps.gitStudio.search.message'), i18nT('apps.gitStudio.search.author')]}
          value={mode}
          onChange={setMode}
          aria-label={i18nT('apps.gitStudio.search.all')}
          className="ml-auto h-6 text-[10px]"
          labelsInListOnly
        />
        <span className="text-[10px] text-muted">{results.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TriState state={state} error={error} empty={!results.length} emptyText={i18nT('apps.gitStudio.search.empty')}>
          {results.map((c) => (
            <button key={c.sha} className="flex w-full items-start gap-2 border-b border-border/30 px-3 py-1.5 text-left hover:bg-bg-hover" onClick={() => props.onOpenCommit(c.sha)}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] text-text">{c.subject}</div>
                <div className="flex items-center gap-1.5 text-[9.5px] text-muted">
                  <span className="max-w-28 truncate">{c.author.split(' ')[0]}</span>
                  <span>{c.timestamp ? new Date(c.timestamp * 1000).toLocaleDateString() : ''}</span>
                  <span className="font-mono">{c.short}</span>
                </div>
              </div>
            </button>
          ))}
        </TriState>
      </div>
    </div>
  )
}
