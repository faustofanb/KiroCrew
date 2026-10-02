/**
 * CommitGraph — virtualized topo DAG with per-row SVG lanes.
 *
 * Each row owns a small SVG covering its own strip: pass-through edges run
 * top→bottom, in-edges curve into the node, out-edges leave it. Because lane
 * indexes are stable across rows (the backend never compacts interior lanes),
 * a window of rows is a complete picture — 100k-commit repos render only what
 * is visible, and pages stream in as the scroll approaches the end.
 */
import { memo, useMemo } from 'react'
import { GitBranch, Tag as TagIcon, Globe, Loader2 } from 'lucide-react'
import { i18nT } from '../../../i18n/t'
import type { CommitRow } from '../types'
import { useWindow } from './common'

const ROW_H = 26
const LANE_W = 13
const NODE_R = 3.5

/** Semantic-token lane palette, cycled by lane index. */
const LANE_CLASSES = ['text-accent', 'text-aim', 'text-info', 'text-warn', 'text-muted']

function laneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2 + 4
}

function edgePath(a: number | null, b: number | null): string {
  const x1 = laneX(a ?? -1)
  const y1 = a === null ? ROW_H / 2 : 0
  const x2 = laneX(b ?? -1)
  const y2 = b === null ? ROW_H / 2 : ROW_H
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const my = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${my} ${x2} ${my} ${x2} ${y2}`
}

function RefBadge(props: { kind: 'branch' | 'remote' | 'tag'; name: string }) {
  const { kind, name } = props
  if (kind === 'tag') {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-warn bg-warn-subtle px-1 font-mono text-[9px] text-warn" title={name}>
        <TagIcon size={8} />
        {name}
      </span>
    )
  }
  if (kind === 'remote') {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border bg-card px-1 font-mono text-[9px] text-muted" title={name}>
        <Globe size={8} />
        {name}
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-accent bg-accent-subtle px-1 font-mono text-[9px] text-accent" title={name}>
      <GitBranch size={8} />
      {name}
    </span>
  )
}

const GraphRow = memo(function GraphRow(props: { row: CommitRow; index: number; selected: boolean; onSelect: (c: CommitRow) => void }) {
  const { row, index, selected, onSelect } = props
  const lanes = useMemo(() => {
    const m = new Set<number>()
    m.add(row.node)
    for (const e of row.edges) {
      if (e.a !== null) m.add(e.a)
      if (e.b !== null) m.add(e.b)
    }
    return Math.max(...m) + 1
  }, [row])
  const graphW = lanes * LANE_W + 10
  const date = row.timestamp ? new Date(row.timestamp * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : ''
  return (
    <div
      role="button"
      aria-label={`${row.subject} ${row.short}`}
      className={`absolute left-0 flex w-full cursor-pointer items-center border-b border-border/30 pl-1 pr-3 hover:bg-bg-hover ${selected ? 'bg-accent-subtle' : ''}`}
      style={{ top: index * ROW_H, height: ROW_H }}
      onClick={() => onSelect(row)}
      data-testid={`graph-row-${row.short}`}
    >
      <svg width={graphW} height={ROW_H} className="shrink-0 overflow-visible" aria-hidden="true">
        {row.edges.map((e, i) => (
          <path
            key={i}
            d={edgePath(e.a, e.b)}
            fill="none"
            strokeWidth={1.5}
            className={`${LANE_CLASSES[(e.a ?? e.b ?? 0) % LANE_CLASSES.length]} opacity-70`}
            stroke="currentColor"
          />
        ))}
        <circle
          cx={laneX(row.node)}
          cy={ROW_H / 2}
          r={row.parents.length > 1 ? NODE_R + 1 : NODE_R}
          className={row.head ? 'text-danger' : LANE_CLASSES[row.node % LANE_CLASSES.length]}
          fill="currentColor"
        />
      </svg>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
        <span className="flex shrink-0 gap-1 overflow-hidden">
          {(row.branches ?? []).slice(0, 3).map((b) => (
            <RefBadge key={b} kind="branch" name={b} />
          ))}
          {(row.tags ?? []).slice(0, 2).map((t) => (
            <RefBadge key={t} kind="tag" name={t} />
          ))}
          {(row.remotes ?? []).slice(0, 2).map((r) => (
            <RefBadge key={r} kind="remote" name={r} />
          ))}
        </span>
        <span className="truncate text-[12px] text-text" title={[row.subject, ''.concat(row.author, ' <', row.email, '>'), row.sha].join('\n')}>
          {row.subject}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[10px] text-muted">
          <span className="max-w-28 truncate">{row.author.split(' ')[0]}</span>
          <span>{date}</span>
          <span className="font-mono">{row.short}</span>
          {row.parents.length > 1 && <span className="rounded bg-bg-hover px-1 text-[9px] text-muted">{i18nT('apps.gitStudio.graph.merge')}</span>}
        </span>
      </div>
    </div>
  )
})

export function CommitGraph(props: {
  rows: CommitRow[]
  total: number
  hasMore: boolean
  loadingMore: boolean
  truncated: boolean
  cap: number
  selectedSha: string | null
  onSelect: (c: CommitRow) => void
  onLoadMore: () => void
}) {
  const win = useWindow({ rowHeight: ROW_H, count: props.rows.length, onNearEnd: props.onLoadMore })
  const visible = props.rows.slice(win.first, win.last)
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={win.ref} onScroll={win.onScroll} className="h-full overflow-y-auto" data-testid="commit-graph-scroll">
        <div style={{ height: win.totalHeight }} className="relative">
          {visible.map((row, i) => {
            const index = win.first + i
            return (
              <GraphRow
                key={`${row.sha}-${index}`}
                row={row}
                index={index}
                selected={props.selectedSha === row.sha}
                onSelect={props.onSelect}
              />
            )
          })}
        </div>
        <div className="flex items-center justify-center gap-2 border-t border-border/30 py-2 text-[11px] text-muted">
          {props.loadingMore && (
            <>
              <Loader2 size={12} className="animate-spin" />
              {i18nT('apps.gitStudio.graph.loadingMore')}
            </>
          )}
          {!props.loadingMore && !props.hasMore && (
            <span>
              {i18nT('apps.gitStudio.graph.end')}: {props.rows.length}/{props.total}
            </span>
          )}
          {props.truncated && !props.hasMore && (
            <span className="text-warn">
              {i18nT('apps.gitStudio.graph.capped', { cap: String(props.cap) })}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
