/**
 * StashPanel — stash list with diff preview and the full op set.
 *
 * push options: message, include-untracked, staged-only. Per stash:
 * apply / pop / drop / branch-from. Previews load lazily on selection and
 * render read-only through the shared DiffViewer.
 */
import { useEffect, useState } from 'react'
import { Archive, GitBranch as BranchIcon, Loader2 } from 'lucide-react'
import { api } from '../api'
import { i18nT } from '../../../i18n/t'
import type { DiffFile, StashItem } from '../types'
import { ConfirmDialog, LoadState, TriState } from './common'
import { DiffViewer } from './DiffViewer'

export function StashPanel(props: {
  repo: string
  stashes: StashItem[]
  state: LoadState
  error?: string | null
  onRefresh: () => void
  onNotice: (kind: 'ok' | 'error' | 'info', text: string) => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [preview, setPreview] = useState<DiffFile[] | null>(null)
  const [pState, setPState] = useState<LoadState>('idle')
  const [pError, setPError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pushMsg, setPushMsg] = useState('')
  const [optUntracked, setOptUntracked] = useState(false)
  const [optStagedOnly, setOptStagedOnly] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [confirmDrop, setConfirmDrop] = useState<number | null>(null)

  useEffect(() => {
    if (selected === null && props.stashes.length) setSelected(0)
  }, [props.stashes, selected])

  useEffect(() => {
    if (selected === null) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPState('loading')
    api
      .stashDiff(props.repo, selected)
      .then((d) => {
        if (cancelled) return
        setPreview(d.files)
        setPState('ready')
      })
      .catch((e) => {
        if (cancelled) return
        setPError(e instanceof Error ? e.message : String(e))
        setPState('error')
      })
    return () => {
      cancelled = true
    }
  }, [props.repo, selected])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      props.onNotice('ok', label)
      props.onRefresh()
    } catch (e) {
      props.onNotice('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const push = () =>
    run(i18nT('apps.gitStudio.stash.pushed'), () =>
      api.stashOp(props.repo, { op: 'push', message: pushMsg, includeUntracked: optUntracked, stagedOnly: optStagedOnly }),
    ).then(() => setPushMsg(''))

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="stash-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Archive size={13} className="text-warn" />
        <span className="text-[13px] font-semibold text-text-strong">{i18nT('apps.gitStudio.stash.title')}</span>
        <span className="rounded bg-bg-hover px-1.5 text-[10px] text-muted">{props.stashes.length}</span>
      </div>
      <div className="shrink-0 border-b border-border p-2">
        <div className="flex gap-1">
          <input
            value={pushMsg}
            onChange={(e) => setPushMsg(e.target.value)}
            placeholder={i18nT('apps.gitStudio.stash.messagePlaceholder')}
            className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-[11px] text-text outline-none focus:border-accent"
            data-testid="stash-message"
          />
          <button
            className="shrink-0 rounded bg-accent px-2.5 text-[11px] text-accent-fg hover:opacity-90 disabled:opacity-40"
            disabled={busy}
            onClick={push}
            data-testid="stash-push"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : i18nT('apps.gitStudio.stash.push')}
          </button>
        </div>
        <div className="mt-1.5 flex gap-3 text-[10px] text-muted">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={optUntracked} onChange={(e) => setOptUntracked(e.target.checked)} className="h-3 w-3" />
            {i18nT('apps.gitStudio.stash.includeUntracked')}
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={optStagedOnly} onChange={(e) => setOptStagedOnly(e.target.checked)} className="h-3 w-3" />
            {i18nT('apps.gitStudio.stash.stagedOnly')}
          </label>
        </div>
      </div>
      <div className="min-h-0 w-full shrink-0 overflow-y-auto border-b border-border" style={{ maxHeight: '30%' }}>
        <TriState state={props.state} error={props.error} empty={!props.stashes.length} emptyText={i18nT('apps.gitStudio.stash.empty')}>
          {props.stashes.map((s, i) => (
            <div key={s.ref} className={`group flex items-center gap-1.5 px-2 py-1.5 hover:bg-bg-hover ${selected === i ? 'bg-accent-subtle' : ''}`}>
              <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setSelected(i)} data-testid={`stash-item-${i}`}>
                <span className="shrink-0 font-mono text-[10px] text-muted">{s.ref}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-text" title={`${s.subject}\n${s.date}`}>
                  {s.subject}
                </span>
                <span className="shrink-0 font-mono text-[9px] text-muted/60">{s.sha}</span>
              </button>
              <div className="hidden shrink-0 gap-0.5 group-hover:flex">
                <button
                  className="rounded border border-accent px-1.5 py-px text-[9px] text-accent"
                  disabled={busy}
                  onClick={() => run(i18nT('apps.gitStudio.stash.applied'), () => api.stashOp(props.repo, { op: 'apply', index: i }))}
                >
                  {i18nT('apps.gitStudio.stash.apply')}
                </button>
                <button
                  className="rounded border border-border px-1.5 py-px text-[9px] text-muted"
                  disabled={busy}
                  onClick={() => run(i18nT('apps.gitStudio.stash.popped'), () => api.stashOp(props.repo, { op: 'pop', index: i }))}
                >
                  {i18nT('apps.gitStudio.stash.pop')}
                </button>
                <button
                  className="rounded border border-danger px-1.5 py-px text-[9px] text-danger"
                  disabled={busy}
                  onClick={() => setConfirmDrop(i)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </TriState>
        {!!props.stashes.length && (
          <div className="flex items-center gap-1 border-t border-border/50 p-1.5">
            <BranchIcon size={10} className="shrink-0 text-muted" />
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder={i18nT('apps.gitStudio.stash.branchPlaceholder')}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-bg px-2 font-mono text-[10px] text-text outline-none focus:border-accent"
              data-testid="stash-branch-name"
            />
            <button
              className="shrink-0 rounded border border-border px-1.5 py-px text-[9.5px] text-text hover:bg-bg-hover disabled:opacity-40"
              disabled={busy || !branchName.trim() || selected === null}
              onClick={() => run(i18nT('apps.gitStudio.stash.branched'), () => api.stashOp(props.repo, { op: 'branch', index: selected ?? 0, name: branchName.trim() }))}
            >
              {i18nT('apps.gitStudio.stash.branchFrom')}
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <TriState state={pState} error={pError} empty={!preview?.length} emptyText={selected === null ? i18nT('apps.gitStudio.stash.selectHint') : i18nT('apps.gitStudio.diff.noChanges')}>
          {preview && <DiffViewer files={preview} staging="none" sbs={false} />}
        </TriState>
      </div>
      <ConfirmDialog
        open={confirmDrop !== null}
        danger
        title={i18nT('apps.gitStudio.stash.dropTitle')}
        body={i18nT('apps.gitStudio.stash.dropBody', { ref: props.stashes[confirmDrop ?? 0]?.ref ?? '' })}
        onCancel={() => setConfirmDrop(null)}
        onConfirm={async () => {
          const i = confirmDrop
          setConfirmDrop(null)
          if (i !== null) await run(i18nT('apps.gitStudio.stash.dropped'), () => api.stashOp(props.repo, { op: 'drop', index: i }))
        }}
      />
    </div>
  )
}
