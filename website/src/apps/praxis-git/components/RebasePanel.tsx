/**
 * RebasePanel — interactive rebase as a first-class todo editor.
 *
 * Not in a rebase: pick an upstream, preview the todo git would offer
 * (``pick <sha> <subject>`` per commit), edit commands (pick / reword / edit /
 * squash / fixup / drop), reorder rows (drag or arrow buttons), then start.
 * In a rebase: stopped-at info, done/todo tails, conflict surface, and
 * continue / skip / abort / reword-stopped.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GitBranch, Loader2, Play, RotateCcw, SkipForward, Square } from 'lucide-react'
import { api } from '../api'
import { Btn } from '../../../components/ui'
import { i18nT } from '../../../i18n/t'
import type { RebaseStatus } from '../types'
import { LoadState, TriState } from './common'

const COMMANDS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'] as const
type Command = (typeof COMMANDS)[number]

type TodoRow = { command: Command; rest: string }

function parseTodo(lines: string[]): TodoRow[] {
  return lines
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const sp = l.trim().indexOf(' ')
      const head = sp < 0 ? l.trim() : l.trim().slice(0, sp)
      const rest = sp < 0 ? '' : l.trim().slice(sp + 1)
      const command = (COMMANDS as readonly string[]).includes(head) ? (head as Command) : 'pick'
      return { command, rest }
    })
}

export function RebasePanel(props: {
  repo: string
  branches: string[]
  status: RebaseStatus | null
  state: LoadState
  error?: string | null
  onChanged: () => void
  onNotice: (kind: 'ok' | 'error' | 'info', text: string) => void
}) {
  const [upstream, setUpstream] = useState('origin/main')
  const [todo, setTodo] = useState<TodoRow[]>([])
  const [todoState, setTodoState] = useState<LoadState>('idle')
  const [todoError, setTodoError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rewordMsg, setRewordMsg] = useState('')
  const dragFrom = useRef<number | null>(null)

  const inProgress = props.status?.inProgress === true

  useEffect(() => {
    if (!inProgress) return
    setRewordMsg(props.status?.headline?.replace(/^failed \w+ /, '') ?? '')
  }, [inProgress, props.status?.headline])

  const loadPreview = async () => {
    if (!upstream.trim()) return
    setTodoState('loading')
    setTodoError(null)
    try {
      const out = await api.rebaseTodoPreview(props.repo, upstream.trim())
      setTodo(parseTodo(out.todo))
      setTodoState('ready')
    } catch (e) {
      setTodoError(e instanceof Error ? e.message : String(e))
      setTodoState('error')
    }
  }

  const move = (from: number, to: number) => {
    setTodo((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev
      const next = [...prev]
      const [row] = next.splice(from, 1)
      next.splice(to, 0, row)
      return next
    })
  }

  const start = async () => {
    setBusy(true)
    try {
      const out = await api.rebaseOp(props.repo, {
        op: 'start-interactive',
        upstream: upstream.trim(),
        todo: todo.map((r) => `${r.command} ${r.rest}`),
      })
      if (out.conflict) {
        props.onNotice('info', i18nT('apps.gitStudio.rebase.conflictStopped'))
      } else {
        props.onNotice('ok', out.output || i18nT('apps.gitStudio.rebase.done'))
      }
      props.onChanged()
    } catch (e) {
      props.onNotice('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const control = async (op: 'start' | 'continue' | 'skip' | 'abort' | 'reword', extra: Record<string, unknown> = {}) => {
    setBusy(true)
    try {
      const out = await api.rebaseOp(props.repo, { op, ...extra })
      if (out.conflict) {
        props.onNotice('info', i18nT('apps.gitStudio.rebase.conflictStopped'))
      } else {
        props.onNotice('ok', out.output || i18nT('apps.gitStudio.rebase.done'))
      }
      props.onChanged()
    } catch (e) {
      props.onNotice('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doneCount = props.status?.done?.length ?? 0
  const remaining = useMemo(() => parseTodo(props.status?.todo ?? []), [props.status?.todo])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="rebase-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <GitBranch size={13} className="text-accent" />
        <span className="text-[13px] font-semibold text-text-strong">{i18nT('apps.gitStudio.rebase.title')}</span>
        {inProgress && (
          <span className="rounded bg-warn-subtle px-1.5 py-px text-[10px] text-warn" data-testid="rebase-active">
            {i18nT('apps.gitStudio.rebase.inProgress')} · {doneCount} {i18nT('apps.gitStudio.rebase.doneCount')} / {remaining.length} {i18nT('apps.gitStudio.rebase.todoCount')}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TriState state={props.state} error={props.error}>
          {inProgress ? (
            <div className="flex flex-col gap-3">
              <div className="rounded border border-warn bg-warn-subtle px-3 py-2 text-[11.5px] text-warn" data-testid="rebase-stopped">
                <div className="font-semibold">{i18nT('apps.gitStudio.rebase.stoppedAt')}: {props.status?.stoppedAt?.slice(0, 8) || '—'}</div>
                <div className="mt-0.5 break-all">{props.status?.headline}</div>
              </div>
              {!!props.status?.conflicts?.length && (
                <div className="rounded border border-danger px-3 py-2 text-[11.5px] text-danger">
                  <div className="mb-1 font-semibold">{i18nT('apps.gitStudio.rebase.conflictFiles')}</div>
                  {props.status.conflicts.map((c) => (
                    <div key={c} className="break-all font-mono text-[10.5px]">{c}</div>
                  ))}
                  <div className="mt-1 text-[10.5px] opacity-80">{i18nT('apps.gitStudio.rebase.resolveHint')}</div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Btn primary className="px-2.5 py-0.5 text-[11px]" disabled={busy} onClick={() => control('continue')} data-testid="rebase-continue">
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                  {i18nT('apps.gitStudio.rebase.continue')}
                </Btn>
                <Btn className="px-2.5 py-0.5 text-[11px]" disabled={busy} onClick={() => control('skip')}>
                  <SkipForward size={11} />
                  {i18nT('apps.gitStudio.rebase.skip')}
                </Btn>
                <Btn danger className="px-2.5 py-0.5 text-[11px]" disabled={busy} onClick={() => control('abort')} data-testid="rebase-abort">
                  <Square size={11} />
                  {i18nT('apps.gitStudio.rebase.abort')}
                </Btn>
              </div>
              <div className="rounded border border-border p-2">
                <div className="mb-1 text-[11px] font-semibold text-text-strong">{i18nT('apps.gitStudio.rebase.rewordCurrent')}</div>
                <div className="flex gap-2">
                  <input
                    value={rewordMsg}
                    onChange={(e) => setRewordMsg(e.target.value)}
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-[11px] text-text outline-none focus:border-accent"
                    data-testid="rebase-reword-input"
                  />
                  <Btn
                    className="px-2 py-0 text-[10.5px]"
                    disabled={busy || !rewordMsg.trim()}
                    onClick={() => control('reword', { message: rewordMsg })}
                  >
                    {i18nT('apps.gitStudio.rebase.amend')}
                  </Btn>
                </div>
              </div>
              {!!doneCount && (
                <div className="rounded border border-border">
                  <div className="border-b border-border/50 bg-card px-2 py-1 text-[10.5px] font-semibold text-muted">{i18nT('apps.gitStudio.rebase.doneList')}</div>
                  <div className="max-h-40 overflow-y-auto p-1.5">
                    {props.status?.done?.map((l, i) => (
                      <div key={i} className="truncate font-mono text-[10px] text-muted line-through">{l}</div>
                    ))}
                  </div>
                </div>
              )}
              {!!remaining.length && (
                <div className="rounded border border-border">
                  <div className="border-b border-border/50 bg-card px-2 py-1 text-[10.5px] font-semibold text-muted">{i18nT('apps.gitStudio.rebase.todoList')}</div>
                  <div className="max-h-40 overflow-y-auto p-1.5">
                    {remaining.map((r, i) => (
                      <div key={i} className="truncate font-mono text-[10px] text-text">
                        <span className="mr-1.5 text-accent">{r.command}</span>
                        {r.rest}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11.5px] text-muted">{i18nT('apps.gitStudio.rebase.upstream')}</span>
                <input
                  list="git-studio-branches"
                  value={upstream}
                  onChange={(e) => setUpstream(e.target.value)}
                  className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 font-mono text-[11px] text-text outline-none focus:border-accent"
                  data-testid="rebase-upstream"
                />
                <datalist id="git-studio-branches">
                  {props.branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
                <button className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-text hover:bg-bg-hover" onClick={loadPreview} disabled={todoState === 'loading'} data-testid="rebase-preview">
                  {i18nT('apps.gitStudio.rebase.preview')}
                </button>
              </div>
              <TriState
                state={todoState}
                error={todoError}
                empty={!todo.length}
                emptyText={i18nT('apps.gitStudio.rebase.noPreview')}
              >
                <div className="overflow-hidden rounded border border-border" data-testid="rebase-todo">
                  <div className="border-b border-border/50 bg-card px-2 py-1 text-[10.5px] font-semibold text-muted">
                    {i18nT('apps.gitStudio.rebase.todoEditor')} · {todo.length}
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {todo.map((row, i) => (
                      <div
                        key={`${row.rest}-${i}`}
                        className="flex items-center gap-1.5 border-b border-border/20 px-1.5 py-1 hover:bg-bg-hover"
                        draggable
                        onDragStart={() => (dragFrom.current = i)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragFrom.current !== null) move(dragFrom.current, i)
                          dragFrom.current = null
                        }}
                        data-testid={`rebase-row-${i}`}
                      >
                        <div className="flex shrink-0 gap-px" role="group" aria-label={i18nT('apps.gitStudio.rebase.command')}>
                          {COMMANDS.map((c) => (
                            <button
                              key={c}
                              className={`rounded px-1 py-px font-mono text-[9px] ${
                                row.command === c
                                  ? c === 'drop'
                                    ? 'bg-danger text-danger-fg'
                                    : c === 'squash' || c === 'fixup'
                                      ? 'bg-warn text-warn-fg'
                                      : 'bg-accent text-accent-fg'
                                  : 'text-muted hover:bg-bg-hover'
                              }`}
                              onClick={() => setTodo((prev) => prev.map((r, j) => (j === i ? { ...r, command: c } : r)))}
                              title={c}
                              data-testid={`rebase-cmd-${i}-${c}`}
                            >
                              {c[0]}
                            </button>
                          ))}
                        </div>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text" title={row.rest}>
                          {row.rest}
                        </span>
                        <button className="shrink-0 rounded p-0.5 text-muted hover:bg-card hover:text-text" onClick={() => move(i, i - 1)} aria-label={i18nT('apps.gitStudio.rebase.moveUp')}>
                          <ArrowUp size={11} />
                        </button>
                        <button className="shrink-0 rounded p-0.5 text-muted hover:bg-card hover:text-text" onClick={() => move(i, i + 1)} aria-label={i18nT('apps.gitStudio.rebase.moveDown')}>
                          <ArrowDown size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </TriState>
              <div className="flex items-center gap-2">
                <Btn
                  primary
                  className="px-3 py-0.5 text-[11.5px]"
                  disabled={busy || !todo.length || !upstream.trim()}
                  onClick={start}
                  data-testid="rebase-start"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                  {i18nT('apps.gitStudio.rebase.start')}
                </Btn>
                <Btn
                  className="px-2.5 py-0.5 text-[11px]"
                  disabled={busy || !upstream.trim()}
                  onClick={() => control('start', { upstream: upstream.trim() })}
                >
                  {i18nT('apps.gitStudio.rebase.startPlain')}
                </Btn>
                <span className="text-[10.5px] text-muted">{i18nT('apps.gitStudio.rebase.dragHint')}</span>
              </div>
            </div>
          )}
        </TriState>
      </div>
    </div>
  )
}
