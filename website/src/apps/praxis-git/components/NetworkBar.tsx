/**
 * NetworkBar — fetch / pull / push with live SSE progress.
 *
 * Ops start with a POST (op id) and stream via EventSource: progress events
 * drive the percent bar, line events append to a bounded log, done carries
 * the exit code. Force-push is refused silently-less: the backend maps it to
 * --force-with-lease unless the operator ticks the explicit force box.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, CloudDownload, Loader2, X } from 'lucide-react'
import { api, streamNetworkOp } from '../api'
import { i18nT } from '../../../i18n/t'
import type { NetworkEvent } from '../types'

const LOG_CAP = 300

type Running = {
  opId: string
  kind: string
  phase: string
  pct: number
  exitCode: number | null
}

export function NetworkBar(props: {
  repo: string
  defaultRemote: string
  branch: string
  onFinished: (ok: boolean) => void
  onNotice: (kind: 'ok' | 'error' | 'info', text: string) => void
}) {
  const [running, setRunning] = useState<Running | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [force, setForce] = useState(false)
  const [ffOnly, setFfOnly] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const start = useCallback(
    async (kind: 'fetch' | 'pull' | 'push') => {
      if (running) return
      const body: Record<string, unknown> = {}
      if (kind === 'fetch') body.prune = true
      if (kind === 'pull') {
        body.rebase = true
        body.ffOnly = ffOnly
      }
      if (kind === 'push') {
        body.force = force
        body.forceWithLease = !force
        body.refs = ['HEAD:refs/heads/'.concat(props.branch)]
      }
      try {
        const { opId } = await api.networkStart(props.repo, kind, body)
        setRunning({ opId, kind, phase: '', pct: 0, exitCode: null })
        setLog([])
        streamNetworkOp(
          opId,
          (e: NetworkEvent) => {
            if (e.type === 'progress') {
              setRunning((r) => (r ? { ...r, phase: e.phase, pct: e.pct } : r))
            } else if (e.type === 'line') {
              setLog((l) => [...l.slice(-LOG_CAP + 1), e.text])
            } else if (e.type === 'error') {
              setLog((l) => [...l.slice(-LOG_CAP + 1), `✗ ${e.text}`])
            } else if (e.type === 'done') {
              setRunning((r) => (r ? { ...r, exitCode: e.exitCode, pct: 100 } : r))
            }
          },
          () => {
            setRunning((r) => {
              if (r && r.exitCode === null) return { ...r, exitCode: -1 }
              return r
            })
          },
        )
      } catch (e) {
        props.onNotice('error', e instanceof Error ? e.message : String(e))
      }
    },
    [running, props, force, ffOnly],
  )

  // report completion once when exitCode lands
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (running?.exitCode !== null && running?.exitCode !== undefined && reported.current !== running.opId) {
      reported.current = running.opId
      const ok = running.exitCode === 0
      props.onNotice(ok ? 'ok' : 'error', `${running.kind}: exit ${running.exitCode}`)
      props.onFinished(ok)
    }
  }, [running, props])

  const cancel = async () => {
    if (!running) return
    try {
      await api.networkCancel(running.opId)
      props.onNotice('info', i18nT('apps.gitStudio.network.cancelling'))
    } catch {
      // the op may have already finished
    }
  }

  const btn = (kind: 'fetch' | 'pull' | 'push', icon: React.ReactNode, label: string, tone: string, testId: string) => (
    <button
      className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] disabled:opacity-40 ${tone}`}
      disabled={!!running}
      onClick={() => start(kind)}
      data-testid={testId}
      title={`${kind} ${props.defaultRemote}`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div className="shrink-0 border-b border-border bg-card px-3 py-1.5" data-testid="network-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted">{props.defaultRemote}</span>
        {btn('fetch', <CloudDownload size={11} />, i18nT('apps.gitStudio.network.fetch'), 'border border-border text-text hover:bg-bg-hover', 'net-fetch')}
        {btn('pull', <ArrowDownToLine size={11} />, i18nT('apps.gitStudio.network.pull'), 'border border-border text-text hover:bg-bg-hover', 'net-pull')}
        {btn('push', <ArrowUpFromLine size={11} />, i18nT('apps.gitStudio.network.push'), 'border border-accent bg-accent text-accent-fg hover:opacity-90', 'net-push')}
        <label className="flex items-center gap-1 text-[9.5px] text-muted" title={i18nT('apps.gitStudio.network.forceHint')}>
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="h-3 w-3" data-testid="net-force" />
          {i18nT('apps.gitStudio.network.force')}
        </label>
        <label className="flex items-center gap-1 text-[9.5px] text-muted">
          <input type="checkbox" checked={ffOnly} onChange={(e) => setFfOnly(e.target.checked)} className="h-3 w-3" />
          {i18nT('apps.gitStudio.network.ffOnly')}
        </label>
        {running && (
          <div className="ml-auto flex min-w-48 items-center gap-2" data-testid="net-progress">
            {running.exitCode === null ? (
              <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
            ) : (
              <span className={`shrink-0 font-mono text-[10px] ${running.exitCode === 0 ? 'text-ok' : 'text-danger'}`}>exit {running.exitCode}</span>
            )}
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-bg-hover">
              <div className="h-full rounded bg-accent transition-all" style={{ width: `${running.pct}%` }} />
            </div>
            <span className="shrink-0 truncate text-[9.5px] text-muted">
              {running.kind} {running.phase} {running.pct}%
            </span>
            <button className="shrink-0 rounded p-0.5 text-muted hover:text-danger" onClick={cancel} title={i18nT('apps.gitStudio.network.cancel')}>
              <X size={11} />
            </button>
          </div>
        )}
      </div>
      {!!log.length && (
        <div ref={logRef} className="mt-1.5 max-h-20 overflow-y-auto rounded bg-bg px-2 py-1 font-mono text-[9.5px] leading-4 text-muted">
          {log.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
