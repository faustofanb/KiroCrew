/**
 * DiffViewer — unified / side-by-side diff with Fork-style line selection.
 *
 * Staging works at three granularities: whole file, whole hunk, and arbitrary
 * line subsets (checkboxes on +/- lines; context is always carried). Selection
 * keys mirror the backend's `t:old:new` line keys, so "stage selection"
 * posts exactly the lines the operator ticked.
 *
 * Syntax colouring is per-line highlight.js with a memo cache: a diff line is
 * a fragment anyway, and per-line highlighting keeps the HTML balanced where
 * whole-hunk highlighting would split spans mid-token.
 */
import { memo, useState } from 'react'
import { ChevronDown, FileText } from 'lucide-react'
import hljs from 'highlight.js/lib/common'
import { i18nT } from '../../../i18n/t'
import { Btn, Checkbox } from '../../../components/ui'
import type { DiffFile, DiffHunk, DiffLine } from '../types'

const RENDER_CAP = 4000 // lines per file; beyond this the file truncates honestly

function lineKey(l: DiffLine): string {
  return `${l.t}:${l.old}:${l.new}`
}

function langOf(path: string | null): string | null {
  if (!path) return null
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
    sh: 'bash', bash: 'bash', zsh: 'bash', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    md: 'markdown', html: 'xml', xml: 'xml', css: 'css', scss: 'scss', sql: 'sql',
    proto: 'protobuf', tf: 'hcl', hcl: 'hcl', lua: 'lua', vim: 'vim',
  }
  return map[ext] ?? null
}

const hlCache = new Map<string, string>()
function highlight(text: string, lang: string | null): string {
  if (!lang || !hljs.getLanguage(lang)) return text
  const key = ''.concat(lang, '\x00', text)
  const hit = hlCache.get(key)
  if (hit !== undefined) return hit
  let html: string
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    html = text
  }
  if (hlCache.size > 30000) hlCache.clear()
  hlCache.set(key, html)
  return html
}

function Segments(props: { line: DiffLine; lang: string | null }) {
  const { line, lang } = props
  if (line.segs && line.segs.length) {
    return (
      <>
        {line.segs.map((s, i) =>
          s.t === 'eq' ? (
            <span key={i} dangerouslySetInnerHTML={{ __html: highlight(s.v, lang) }} />
          ) : s.t === 'add' ? (
            <span key={i} className="rounded-sm bg-ok-subtle text-ok">{s.v}</span>
          ) : (
            <span key={i} className="rounded-sm bg-danger-subtle text-danger line-through">{s.v}</span>
          ),
        )}
      </>
    )
  }
  return <span dangerouslySetInnerHTML={{ __html: highlight(line.text, lang) }} />
}

type RowCtx = {
  lang: string | null
  staging: boolean
  reverse: boolean
  selected: Set<string>
  toggle: (l: DiffLine) => void
}

function LineCheckbox(props: { line: DiffLine; ctx: RowCtx }) {
  const { line, ctx } = props
  if (!ctx.staging || (line.t !== 'add' && line.t !== 'del' && line.t !== 'mod')) return <span className="w-4 shrink-0" />
  const key = lineKey(line)
  return (
    <Checkbox
      checked={ctx.selected.has(key)}
      onChange={() => ctx.toggle(line)}
      className="mt-0.5"
      aria-label={`${ctx.reverse ? i18nT('apps.gitStudio.diff.unstageLine') : i18nT('apps.gitStudio.diff.stageLine')} ${line.new ?? line.old}`}
      data-testid={`line-check-${lineKey(line)}`}
    />
  )
}

const UnifiedRow = memo(function UnifiedRow(props: { line: DiffLine; ctx: RowCtx }) {
  const { line, ctx } = props
  const cls =
    line.t === 'add' || line.t === 'mod'
      ? 'bg-ok-subtle/60'
      : line.t === 'del'
        ? 'bg-danger-subtle/50'
        : ''
  return (
    <div className={`flex items-start font-mono text-[11px] leading-5 ${cls}`}>
      <LineCheckbox line={line} ctx={ctx} />
      <span className="w-10 shrink-0 select-none pr-1 text-right text-muted/60">{line.old ?? ''}</span>
      <span className="w-10 shrink-0 select-none pr-1 text-right text-muted/60">{line.new ?? ''}</span>
      <span className="w-3 shrink-0 select-none text-center text-muted">
        {line.t === 'add' || line.t === 'mod' ? '+' : line.t === 'del' ? '−' : ''}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 text-text">
        <Segments line={line} lang={ctx.lang} />
      </span>
    </div>
  )
})

/** Aligned pair row for side-by-side: left (old) vs right (new). */
const SbsRow = memo(function SbsRow(props: {
  left: DiffLine | null
  right: DiffLine | null
  ctx: RowCtx
}) {
  const { left, right, ctx } = props
  const cell = (l: DiffLine | null, side: 'old' | 'new') => {
    if (!l) return <div className="min-w-0 flex-1 bg-bg/40" />
    const bg = side === 'old' ? (l.t === 'del' || l.t === 'mod' ? 'bg-danger-subtle/50' : '') : l.t === 'add' || l.t === 'mod' ? 'bg-ok-subtle/60' : ''
    return (
      <div className={`flex min-w-0 flex-1 items-start ${bg}`}>
        {side === 'old' ? <LineCheckbox line={l} ctx={ctx} /> : <span className="w-4 shrink-0" />}
        <span className="w-10 shrink-0 select-none pr-1 text-right text-[11px] leading-5 text-muted/60">{side === 'old' ? l.old ?? '' : l.new ?? ''}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 font-mono text-[11px] leading-5 text-text">
          <Segments line={l} lang={ctx.lang} />
        </span>
      </div>
    )
  }
  return (
    <div className="flex border-b border-border/10">
      {cell(left, 'old')}
      <div className="w-px shrink-0 bg-border/40" />
      {cell(right, 'new')}
    </div>
  )
})

/** Pair del/add runs into aligned rows (classic two-up alignment). */
function pairRows(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = () => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (l.t === 'del') dels.push(l)
    else if (l.t === 'add') adds.push(l)
    else if (l.t === 'mod') rows.push({ left: l, right: l })
    else if (l.t === 'note') continue
    else {
      flush()
      rows.push({ left: l, right: l })
    }
  }
  flush()
  return rows
}

function HunkBlock(props: {
  file: DiffFile
  fileIdx: number
  hunk: DiffHunk
  hunkIdx: number
  sbs: boolean
  ctx: RowCtx
  onHunkAll: (fileIdx: number, hunkIdx: number) => void
}) {
  const { hunk, sbs, ctx, onHunkAll, fileIdx, hunkIdx } = props
  const adds = hunk.lines.filter((l) => l.t === 'add' || l.t === 'mod').length
  const dels = hunk.lines.filter((l) => l.t === 'del' || l.t === 'mod').length
  const capped = hunk.lines.length > RENDER_CAP
  const lines = capped ? hunk.lines.slice(0, RENDER_CAP) : hunk.lines
  return (
    <div className="mb-2 overflow-hidden rounded border border-border/60" data-testid={`hunk-${fileIdx}-${hunkIdx}`}>
      <div className="flex items-center gap-2 border-b border-border/60 bg-card px-2 py-1">
        <span className="truncate font-mono text-[9.5px] text-muted" title={hunk.header}>
          {hunk.header}
        </span>
        <span className="shrink-0 font-mono text-[9.5px]">
          <span className="text-ok">+{adds}</span> <span className="text-danger">−{dels}</span>
        </span>
        {ctx.staging && (
          <Btn
            className="ml-auto shrink-0 px-1.5 py-0 text-[9px]"
            onClick={() => onHunkAll(fileIdx, hunkIdx)}
            data-testid={`hunk-stage-${fileIdx}-${hunkIdx}`}
          >
            {ctx.reverse ? i18nT('apps.gitStudio.diff.unstageHunk') : i18nT('apps.gitStudio.diff.stageHunk')}
          </Btn>
        )}
      </div>
      {sbs
        ? pairRows(lines).map((r, i) => <SbsRow key={i} left={r.left} right={r.right} ctx={ctx} />)
        : lines.map((l, i) => <UnifiedRow key={i} line={l} ctx={ctx} />)}
      {capped && (
        <div className="border-t border-border/40 bg-card px-2 py-1 text-[10px] text-warn">
          {i18nT('apps.gitStudio.diff.truncated', { shown: String(RENDER_CAP), total: String(hunk.lines.length) })}
        </div>
      )}
    </div>
  )
}

export type DiffSelections = { hunk: number; keys: string[] }[]

export function DiffViewer(props: {
  files: DiffFile[]
  /** staging mode: none (read-only) | worktree (stage) | staged (unstage) */
  staging: 'none' | 'worktree' | 'staged'
  sbs: boolean
  onStageSelection?: (path: string, selections: DiffSelections) => void
  busy?: boolean
}) {
  const { files, staging, sbs } = props
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [selection, setSelection] = useState<Map<string, Set<string>>>(new Map())

  const toggleLine = (fileIdx: number, hunkIdx: number, l: DiffLine) => {
    const key = `${fileIdx}:${hunkIdx}`
    setSelection((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(key) ?? [])
      const lk = lineKey(l)
      if (set.has(lk)) set.delete(lk)
      else set.add(lk)
      next.set(key, set)
      return next
    })
  }

  const hunkAll = (fileIdx: number, hunkIdx: number) => {
    const file = files[fileIdx]
    const hunk = file?.hunks[hunkIdx]
    if (!file || !hunk || !props.onStageSelection) return
    const keys = hunk.lines.filter((l) => l.t === 'add' || l.t === 'del' || l.t === 'mod').map(lineKey)
    props.onStageSelection(file.newPath ?? file.oldPath ?? '', [{ hunk: hunkIdx, keys }])
  }

  const submitSelection = (fileIdx: number) => {
    const file = files[fileIdx]
    if (!file || !props.onStageSelection) return
    const selections: DiffSelections = []
    file.hunks.forEach((_h, hunkIdx) => {
      const keys = [...(selection.get(`${fileIdx}:${hunkIdx}`) ?? [])]
      if (keys.length) selections.push({ hunk: hunkIdx, keys })
    })
    if (selections.length) {
      props.onStageSelection(file.newPath ?? file.oldPath ?? '', selections)
    }
    setSelection((prev) => {
      const next = new Map(prev)
      file.hunks.forEach((_, hunkIdx) => next.delete(`${fileIdx}:${hunkIdx}`))
      return next
    })
  }

  if (!files.length) {
    return <div className="p-6 text-center text-[12px] text-muted">{i18nT('apps.gitStudio.diff.noChanges')}</div>
  }
  return (
    <div className="min-w-0">
      {files.map((file, fileIdx) => {
        const display = file.newPath ?? file.oldPath ?? ''
        const adds = file.hunks.reduce((a, h2) => a + h2.lines.filter((l) => l.t === 'add' || l.t === 'mod').length, 0)
        const dels = file.hunks.reduce((a, h2) => a + h2.lines.filter((l) => l.t === 'del' || l.t === 'mod').length, 0)
        const isCollapsed = collapsed.has(fileIdx)
        const lang = langOf(display)
        const selectedForFile = new Set<string>()
        for (const [k, s] of selection) {
          if (k.startsWith(`${fileIdx}:`)) for (const lk of s) selectedForFile.add(lk)
        }
        const ctx: RowCtx = {
          lang,
          staging: staging !== 'none' && !!props.onStageSelection,
          reverse: staging === 'staged',
          selected: selectedForFile,
          toggle: (l) => {
            const hunkIdx = file.hunks.findIndex((h) => h.lines.includes(l))
            if (hunkIdx >= 0) toggleLine(fileIdx, hunkIdx, l)
          },
        }
        return (
          <div key={`${display}-${fileIdx}`} className="mb-3" data-testid={`diff-file-${fileIdx}`}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(fileIdx)) next.delete(fileIdx)
                    else next.add(fileIdx)
                    return next
                  })
                }
              }}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(fileIdx)) next.delete(fileIdx)
                  else next.add(fileIdx)
                  return next
                })
              }
              className="sticky top-0 z-10 flex w-full cursor-pointer select-none items-center gap-2 border-b border-border bg-card px-2 py-1.5 text-left"
            >
              {isCollapsed ? <ChevronDown size={13} className="shrink-0 rotate-[-90deg] text-muted" /> : <ChevronDown size={13} className="shrink-0 text-muted" />}
              <FileText size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-strong" title={display}>
                {display}
                {file.status === 'renamed' && file.oldPath && (
                  <span className="ml-1 text-[10px] text-muted">← {file.oldPath}</span>
                )}
              </span>
              <span className="shrink-0 font-mono text-[10px]">
                <span className="text-ok">+{adds}</span> <span className="text-danger">−{dels}</span>
              </span>
              {ctx.selected.size > 0 && props.onStageSelection && (
                <Btn
                  primary
                  className="shrink-0 px-2 py-0.5 text-[10px]"
                  disabled={props.busy}
                  onClick={(e) => {
                    e.stopPropagation()
                    submitSelection(fileIdx)
                  }}
                  data-testid={`stage-selection-${fileIdx}`}
                >
                  {staging === 'staged'
                    ? i18nT('apps.gitStudio.diff.unstageSelection', { n: String(ctx.selected.size) })
                    : i18nT('apps.gitStudio.diff.stageSelection', { n: String(ctx.selected.size) })}
                </Btn>
              )}
            </div>
            {!isCollapsed &&
              (file.binary ? (
                <div className="px-3 py-4 text-[11.5px] text-muted">{i18nT('apps.gitStudio.diff.binary')}</div>
              ) : (
                <div className="py-1">
                  {file.hunks.map((hunk, hunkIdx) => (
                    <HunkBlock
                      key={hunkIdx}
                      file={file}
                      fileIdx={fileIdx}
                      hunk={hunk}
                      hunkIdx={hunkIdx}
                      sbs={sbs}
                      ctx={ctx}
                      onHunkAll={hunkAll}
                    />
                  ))}
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}
