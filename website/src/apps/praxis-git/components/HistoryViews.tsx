/**
 * HistoryViews — blame annotation and per-file history.
 *
 * Blame groups consecutive lines by (sha, author) — the gutter shows the
 * commit once per run instead of per line, exactly like Fork. Clicking a
 * gutter jumps to that commit's diff. File history lists the commits that
 * touched the path (rename-following) with per-commit status chips.
 */
import { useEffect, useMemo, useState } from 'react'
import { Clock, FileClock, User } from 'lucide-react'
import { api } from '../api'
import { i18nT } from '../../../i18n/t'
import type { BlameLine, HistoryCommit } from '../types'
import { LoadState, TriState, useWindow } from './common'

const BLAME_ROW_H = 20

export function BlameView(props: {
  repo: string
  path: string
  onOpenCommit: (sha: string) => void
}) {
  const [lines, setLines] = useState<BlameLine[]>([])
  const [state, setState] = useState<LoadState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [hoverSha, setHoverSha] = useState<string | null>(null)
  const win = useWindow({ rowHeight: BLAME_ROW_H, count: lines.length })

  useEffect(() => {
    let cancelled = false
    setState('loading')
    api
      .blame(props.repo, props.path)
      .then((d) => {
        if (cancelled) return
        setLines(d.lines)
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
  }, [props.repo, props.path])

  /** run-start rows: first line of a consecutive (sha) group shows the meta */
  const runStarts = useMemo(() => {
    const set = new Set<number>()
    let prevSha = ''
    let prevRunStart = -1
    let runLen = 0
    lines.forEach((l, i) => {
      if (l.sha !== prevSha) {
        if (prevRunStart >= 0 && runLen > 0) set.add(prevRunStart)
        prevSha = l.sha
        prevRunStart = i
        runLen = 1
      } else {
        runLen++
      }
    })
    if (prevRunStart >= 0) set.add(prevRunStart)
    return set
  }, [lines])

  const runLengths = useMemo(() => {
    const lens = new Map<number, number>()
    let start = 0
    for (let i = 1; i <= lines.length; i++) {
      if (i === lines.length || lines[i].sha !== lines[start].sha) {
        lens.set(start, i - start)
        start = i
      }
    }
    return lens
  }, [lines])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="blame-view">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <FileClock size={13} className="text-info" />
        <span className="truncate font-mono text-[11.5px] text-text-strong">{props.path}</span>
        <span className="ml-auto text-[10px] text-muted">{lines.length} {i18nT('apps.gitStudio.blame.lines')}</span>
      </div>
      <div ref={win.ref} onScroll={win.onScroll} className="min-h-0 flex-1 overflow-auto">
        <TriState state={state} error={error} empty={!lines.length} emptyText={i18nT('apps.gitStudio.blame.empty')}>
          <div style={{ height: win.totalHeight }} className="relative">
            {lines.slice(win.first, win.last).map((l, i) => {
              const index = win.first + i
              const isStart = runStarts.has(index)
              const len = runLengths.get(index) ?? 1
              const first = lines[index]
              const hot = hoverSha !== null && l.sha === hoverSha
              return (
                <div
                  key={index}
                  className={`absolute left-0 flex w-full items-start font-mono text-[10.5px] leading-5 ${hot ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}
                  style={{ top: index * BLAME_ROW_H, height: BLAME_ROW_H }}
                  onMouseEnter={() => setHoverSha(l.sha)}
                  onMouseLeave={() => setHoverSha(null)}
                >
                  <button
                    className={`flex w-56 shrink-0 items-center gap-1.5 border-r border-border/40 px-1.5 text-left ${isStart ? 'text-muted' : 'text-transparent'}`}
                    style={isStart ? {} : { pointerEvents: 'none' }}
                    onClick={() => props.onOpenCommit(l.sha)}
                    title={first.summary ? `${first.sha} ${first.author ?? ''}: ${first.summary}` : l.sha}
                  >
                    {isStart && (
                      <>
                        <span className="w-12 shrink-0 truncate font-mono text-accent">{l.sha}</span>
                        <span className="w-16 shrink-0 truncate text-[9.5px] text-info">{l.author ?? ''}</span>
                        <span className="min-w-0 flex-1 truncate text-[9px] text-muted/70">{first.summary ?? ''}</span>
                      </>
                    )}
                    {isStart && len > 1 && <span className="shrink-0 text-[8.5px] text-muted/40">×{len}</span>}
                  </button>
                  <span className="w-10 shrink-0 select-none pr-1 text-right text-[9.5px] text-muted/50">{l.line}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pl-1 pr-2 text-text">{l.text}</span>
                </div>
              )
            })}
          </div>
        </TriState>
      </div>
    </div>
  )
}

const STATUS_COLORS: Record<string, string> = {
  A: 'text-ok', M: 'text-warn', D: 'text-danger', R: 'text-info', C: 'text-info',
}

export function FileHistoryView(props: {
  repo: string
  path: string
  onOpenCommit: (sha: string) => void
}) {
  const [commits, setCommits] = useState<HistoryCommit[]>([])
  const [state, setState] = useState<LoadState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    api
      .history(props.repo, props.path, { limit: 300, follow })
      .then((d) => {
        if (cancelled) return
        setCommits(d.commits)
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
  }, [props.repo, props.path, follow])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-history">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Clock size={13} className="text-info" />
        <span className="truncate font-mono text-[11.5px] text-text-strong">{props.path}</span>
        <label className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="h-3 w-3" />
          {i18nT('apps.gitStudio.history.followRenames')}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TriState state={state} error={error} empty={!commits.length} emptyText={i18nT('apps.gitStudio.history.empty')}>
          {commits.map((c) => {
            const change = c.changes[0]
            const status = change?.status.replace(/\d+$/, '') ?? '?'
            return (
              <button
                key={c.sha}
                className="flex w-full items-center gap-2 border-b border-border/30 px-3 py-1.5 text-left hover:bg-bg-hover"
                onClick={() => props.onOpenCommit(c.sha)}
                data-testid={`history-${c.short}`}
              >
                <span className={`w-6 shrink-0 rounded bg-bg-hover text-center font-mono text-[9px] ${STATUS_COLORS[status] ?? 'text-muted'}`}>
                  {status}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] text-text">{c.subject}</div>
                  <div className="flex items-center gap-1.5 text-[9.5px] text-muted">
                    <User size={9} />
                    <span className="max-w-28 truncate">{c.author.split(' ')[0]}</span>
                    <span>{c.timestamp ? new Date(c.timestamp * 1000).toLocaleDateString() : ''}</span>
                    <span className="font-mono">{c.short}</span>
                    {change?.oldPath && (
                      <span className="truncate font-mono text-muted/70">
                        {change.oldPath} → {change.path}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </TriState>
      </div>
    </div>
  )
}
