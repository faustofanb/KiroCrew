/**
 * ConflictResolver — three-pane merge resolution with per-block choices.
 *
 * The working-tree file (conflict markers included) is parsed into text and
 * conflict blocks; each block renders ours/theirs (base alongside, when the
 * merge kept a stage-1 blob) with explicit choices — ours / theirs / both /
 * edit-in-place. A file counts as resolved only when every block has a
 * decision; writing it goes through the backend's resolve+add path, never a
 * raw shell.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Eye, GitMerge, Loader2 } from 'lucide-react'
import { api } from '../api'
import { i18nT } from '../../../i18n/t'
import type { ConflictItem, ConflictVersions } from '../types'
import { LoadState, TriState } from './common'

type Block =
  | { kind: 'text'; lines: string[] }
  | { kind: 'conflict'; labelOurs: string; labelTheirs: string; base: string[]; ours: string[]; theirs: string[]; decision: 'ours' | 'theirs' | 'both' | null }

const OURS_RE = /^<{7} ?(.*)$/
const SEP_RE = /^={7}$/
const THEIRS_RE = /^>{7} ?(.*)$/
const BASE_RE = /^\|{7} ?(.*)$/

function parseMarkers(content: string): Block[] {
  const lines = content.split('\n')
  const blocks: Block[] = []
  let i = 0
  const pushText = (buf: string[]) => {
    if (buf.length) blocks.push({ kind: 'text', lines: buf })
  }
  let buf: string[] = []
  while (i < lines.length) {
    const m = OURS_RE.exec(lines[i])
    if (m) {
      pushText(buf)
      buf = []
      const labelOurs = m[1] || 'ours'
      const base: string[] = []
      const ours: string[] = []
      const theirs: string[] = []
      let section: 'base' | 'ours' | 'theirs' = 'ours'
      let labelTheirs = 'theirs'
      i++
      while (i < lines.length) {
        const l = lines[i]
        if (BASE_RE.test(l) && section === 'ours') {
          section = 'base'
        } else if (SEP_RE.test(l) && (section === 'base' || section === 'ours')) {
          section = 'theirs'
        } else if (THEIRS_RE.test(l)) {
          labelTheirs = THEIRS_RE.exec(l)?.[1] || labelTheirs
          break
        } else if (section === 'base') {
          base.push(l)
        } else if (section === 'ours') {
          ours.push(l)
        } else {
          theirs.push(l)
        }
        i++
      }
      blocks.push({ kind: 'conflict', labelOurs, labelTheirs, base, ours, theirs, decision: null })
      i++
      continue
    }
    buf.push(lines[i])
    i++
  }
  pushText(buf)
  return blocks
}

function assemble(blocks: Block[]): string {
  const out: string[] = []
  for (const b of blocks) {
    if (b.kind === 'text') out.push(...b.lines)
    else if (b.decision === 'ours') out.push(...b.ours)
    else if (b.decision === 'theirs') out.push(...b.theirs)
    else if (b.decision === 'both') out.push(...b.ours, ...b.theirs)
    else out.push(`<<<<<<< ${b.labelOurs}`, ...b.ours, '=======', ...b.theirs, `>>>>>>> ${b.labelTheirs}`)
  }
  return out.join('\n')
}

function Pane(props: { title: string; tone: 'ours' | 'theirs' | 'base'; lines: string[]; chosen?: boolean; onChoose?: () => void; testId?: string }) {
  const tone = props.tone === 'ours' ? 'border-accent' : props.tone === 'theirs' ? 'border-aim' : 'border-border'
  return (
    <div className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded border ${tone} ${props.chosen ? 'ring-1 ring-inset ring-accent' : ''}`} data-testid={props.testId}>
      <button
        className="flex items-center gap-1 border-b border-border/50 bg-card px-2 py-1 text-left text-[10px] font-semibold text-text-strong disabled:cursor-default"
        disabled={!props.onChoose}
        onClick={props.onChoose}
      >
        {props.chosen !== undefined && (
          <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${props.chosen ? 'border-accent bg-accent text-accent-fg' : 'border-border'}`}>
            {props.chosen && <Check size={9} />}
          </span>
        )}
        <span className="truncate">{props.title}</span>
        {props.onChoose && <span className="ml-auto shrink-0 text-[9px] font-normal text-accent">{i18nT('apps.gitStudio.conflict.choose')}</span>}
      </button>
      <pre className="max-h-64 min-h-16 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10.5px] leading-5 text-text">
        {props.lines.join('\n') || i18nT('apps.gitStudio.conflict.empty')}
      </pre>
    </div>
  )
}

export function ConflictResolver(props: {
  repo: string
  conflicts: ConflictItem[]
  state: LoadState
  error?: string | null
  onResolved: () => void
  onNotice: (kind: 'ok' | 'error' | 'info', text: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [versions, setVersions] = useState<ConflictVersions | null>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [vState, setVState] = useState<LoadState>('idle')
  const [vError, setVError] = useState<string | null>(null)
  const [showBase, setShowBase] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!selected && props.conflicts.length) setSelected(props.conflicts[0].path)
  }, [props.conflicts, selected])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setVState('loading')
    setVError(null)
    ;(async () => {
      try {
        const v = await api.conflictFile(props.repo, selected)
        if (cancelled) return
        setVersions(v)
        // the worktree file carries the markers — the block canvas; fall back
        // to ours (no markers → single decision needed via quick-take)
        setBlocks(parseMarkers(v.worktree ?? v.versions.ours ?? ''))
        setVState('ready')
      } catch (e) {
        if (cancelled) return
        setVError(e instanceof Error ? e.message : String(e))
        setVState('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.repo, selected])

  const unresolved = useMemo(() => blocks.filter((b) => b.kind === 'conflict' && b.decision === null).length, [blocks])

  const decide = (idx: number, decision: 'ours' | 'theirs' | 'both') => {
    setBlocks((prev) => prev.map((b, i) => (i === idx && b.kind === 'conflict' ? { ...b, decision } : b)))
  }

  const quickTake = async (side: 'ours' | 'theirs') => {
    if (!selected) return
    setSaving(true)
    try {
      await api.resolveConflict(props.repo, selected, { side })
      props.onNotice('ok', i18nT('apps.gitStudio.conflict.resolved', { path: selected }))
      props.onResolved()
    } catch (e) {
      props.onNotice('error', e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const saveMerged = async () => {
    if (!selected) return
    setSaving(true)
    try {
      await api.resolveConflict(props.repo, selected, { content: assemble(blocks) })
      props.onNotice('ok', i18nT('apps.gitStudio.conflict.resolved', { path: selected }))
      props.onResolved()
    } catch (e) {
      props.onNotice('error', e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[12px] font-semibold text-text-strong">
          <GitMerge size={13} className="text-warn" />
          {i18nT('apps.gitStudio.conflict.title')}
          <span className="ml-auto rounded bg-warn-subtle px-1.5 text-[10px] text-warn">{props.conflicts.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <TriState state={props.state} error={props.error} empty={!props.conflicts.length} emptyText={i18nT('apps.gitStudio.conflict.none')}>
            {props.conflicts.map((c) => (
              <button
                key={c.path}
                onClick={() => setSelected(c.path)}
                className={`mb-0.5 block w-full truncate rounded px-2 py-1.5 text-left font-mono text-[11px] ${selected === c.path ? 'bg-accent-subtle text-text-strong' : 'text-text hover:bg-bg-hover'}`}
                title={c.path}
                data-testid={`conflict-file-${c.path}`}
              >
                {c.path}
              </button>
            ))}
          </TriState>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <span className="truncate font-mono text-[11.5px] text-text-strong">{selected ?? '—'}</span>
          <button
            className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-text hover:bg-bg-hover"
            onClick={() => setShowBase((s) => !s)}
            title={versions?.labels.ours ?? ''}
          >
            <span className="inline-flex items-center gap-1">
              <Eye size={11} />
              {i18nT('apps.gitStudio.conflict.showBase')}
            </span>
          </button>
          <button className="shrink-0 rounded border border-accent px-2 py-0.5 text-[10px] text-accent hover:bg-accent-subtle" disabled={saving} onClick={() => quickTake('ours')} data-testid="take-ours">
            {i18nT('apps.gitStudio.conflict.takeOurs')}
          </button>
          <button className="shrink-0 rounded border border-aim px-2 py-0.5 text-[10px] text-aim hover:bg-bg-hover" disabled={saving} onClick={() => quickTake('theirs')} data-testid="take-theirs">
            {i18nT('apps.gitStudio.conflict.takeTheirs')}
          </button>
          <button
            className="shrink-0 rounded bg-accent px-2.5 py-0.5 text-[10px] text-accent-fg hover:opacity-90 disabled:opacity-40"
            disabled={saving || !selected || unresolved > 0}
            onClick={saveMerged}
            data-testid="resolve-merged"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : i18nT('apps.gitStudio.conflict.markResolved')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {vState === 'loading' && <div className="flex justify-center p-4"><Loader2 size={16} className="animate-spin text-muted" /></div>}
          {vState === 'error' && <TriState state="error" error={vError}><span /></TriState>}
          {vState === 'ready' && versions && (
            <>
              {unresolved > 0 && (
                <div className="mb-3 flex items-center gap-2 rounded border border-warn bg-warn-subtle px-3 py-1.5 text-[11px] text-warn">
                  <AlertTriangle size={12} />
                  {i18nT('apps.gitStudio.conflict.unresolved', { n: String(unresolved) })}
                </div>
              )}
              {(() => {
                let conflictNo = -1
                return blocks.map((b, i) => {
                  if (b.kind === 'text') {
                    return (
                      <pre key={i} className="whitespace-pre-wrap break-all border-l-2 border-transparent py-0.5 pl-2 font-mono text-[10.5px] leading-5 text-muted">
                        {b.lines.join('\n')}
                      </pre>
                    )
                  }
                  conflictNo += 1
                  const c = conflictNo
                  return (
                  <div key={i} className="my-2 rounded border border-border" data-testid={`conflict-block-${c}`}>
                    <div className="flex items-center gap-2 border-b border-border/50 bg-card px-2 py-1 font-mono text-[9.5px] text-muted">
                      <span>{b.labelOurs}</span>
                      <span>vs</span>
                      <span>{b.labelTheirs}</span>
                      <span className="ml-auto flex gap-1">
                        <button className="rounded border border-border px-1.5 py-px text-[9px] text-text hover:bg-bg-hover" onClick={() => decide(i, 'both')}>{i18nT('apps.gitStudio.conflict.both')}</button>
                      </span>
                    </div>
                    <div className={`flex gap-1 p-1 ${showBase ? 'flex-col' : ''}`}>
                      {showBase && (
                        <div className="flex w-full gap-1">
                          <Pane title={i18nT('apps.gitStudio.conflict.base')} tone="base" lines={versions.versions.base !== null ? versions.versions.base.split('\n') : b.base} />
                        </div>
                      )}
                      <div className="flex min-w-0 flex-1 gap-1">
                        <Pane
                          title={i18nT('apps.gitStudio.conflict.ours')}
                          tone="ours"
                          lines={b.ours}
                          chosen={b.decision === 'ours' || b.decision === 'both'}
                          onChoose={() => decide(i, 'ours')}
                          testId={`block-ours-${c}`}
                        />
                        <Pane
                          title={i18nT('apps.gitStudio.conflict.theirs')}
                          tone="theirs"
                          lines={b.theirs}
                          chosen={b.decision === 'theirs' || b.decision === 'both'}
                          onChoose={() => decide(i, 'theirs')}
                          testId={`block-theirs-${c}`}
                        />
                      </div>
                    </div>
                  </div>
                  )
                })
              })()}
              {blocks.every((b) => b.kind === 'text') && (
                <div className="rounded border border-border bg-card p-3 text-[11.5px] text-muted">{i18nT('apps.gitStudio.conflict.noMarkers')}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
