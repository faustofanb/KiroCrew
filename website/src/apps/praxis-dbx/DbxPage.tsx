/**
 * DBX — dbx-web process lifecycle + full Web UI via the gateway proxy.
 *
 * First load calls /ensure (attach-or-launch), then the complete dbx-web
 * interface renders in an iframe at /dbx-app/ — same origin as the gateway
 * (DBX_PUBLIC_BASE_PATH makes every dbx-web link and cookie stay inside the
 * proxy prefix; no naked 4224 exposure). The control bar owns lifecycle:
 * start/stop/restart, health, bounded log tail, auto-restart switch, the
 * read-only connection inventory, and the AI SQL prompt entry.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Database,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Square,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { i18nT } from '../../i18n/t'
import { Badge, Btn, Card, EmptyState, Toggle } from '../../components/ui'
import ErrorNotice from '../../components/ErrorNotice'

const BASE = '/api/apps/praxis-dbx'
const PROXY = '/dbx-app/'

type DbxStatus = {
  state: 'stopped' | 'starting' | 'running' | 'foreign'
  pid: number | null
  up: boolean
  auth?: Record<string, unknown>
  port: number
  publicPath: string
  binaryPresent: boolean
  dataDir: string
  autoRestart: boolean
  version: string
  binary: string
}

type ConnItem = {
  name?: string
  id?: string | number
  type?: string
  db_type?: string
  host?: string
  port?: number | string
  database?: string
  openInUi?: string
}

async function j<T>(resp: Response): Promise<T> {
  const body = await resp.json().catch(() => ({}) as T)
  if (!resp.ok) {
    const e = body as { error?: string }
    throw new Error(e.error || `HTTP ${resp.status}`)
  }
  return body as T
}

export default function DbxPage() {
  const [status, setStatus] = useState<DbxStatus | null>(null)
  const [ensuring, setEnsuring] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const [conns, setConns] = useState<ConnItem[] | null>(null)
  const [question, setQuestion] = useState('')
  const [prompt, setPrompt] = useState<string | null>(null)
  const [iframeKey, setIframeKey] = useState(0)

  const refresh = useCallback(async () => {
    try {
      setStatus(await j<DbxStatus>(await fetch(`${BASE}/status`)))
    } catch {
      /* keep the last known status */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setEnsuring(true)
    fetch(`${BASE}/ensure`, { method: 'POST' })
      .then(async (r) => (r.ok ? j<DbxStatus>(r) : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`))))
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setEnsuring(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (status?.up) {
      fetch(`${BASE}/connections`)
        .then((r) => j<{ connections: ConnItem[] }>(r))
        .then((d) => setConns(d.connections))
        .catch(() => setConns([]))
    }
  }, [status?.up])

  const op = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
      await refresh()
      if (name === 'restart') setIframeKey((k) => k + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const start = () =>
    op('start', async () => {
      const r = await fetch(`${BASE}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      await j<DbxStatus>(r)
      setIframeKey((k) => k + 1)
    })
  const stop = () => op('stop', async () => void j(await fetch(`${BASE}/stop`, { method: 'POST' })))
  const toggleAuto = () =>
    op('auto', async () => {
      await j(await fetch(`${BASE}/auto-restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !(status?.autoRestart ?? true) }),
      }))
    })
  const showLogs = () =>
    op('logs', async () => {
      const d = await j<{ logs: string }>(await fetch(`${BASE}/logs`))
      setLogs(d.logs)
    })

  const askAi = async () => {
    if (!question.trim()) return
    setBusy('ai')
    try {
      const d = await j<{ prompt: string }>(
        await fetch(`${BASE}/ai`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ connection: conns?.[0]?.name ?? '', question }),
        }),
      )
      setPrompt(d.prompt)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const running = status?.up === true
  const stateLabel = ensuring
    ? i18nT('apps.dbx.state.checking')
    : status?.state === 'running'
      ? i18nT('apps.dbx.state.running')
      : status?.state === 'starting'
        ? i18nT('apps.dbx.state.starting')
        : status?.state === 'foreign'
          ? i18nT('apps.dbx.state.foreign')
          : i18nT('apps.dbx.state.stopped')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* control bar */}
      <div className="flex h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3">
        <Database size={14} className="shrink-0 text-accent" />
        <span className="text-[14px] font-semibold text-text-strong">{i18nT('apps.dbx.title')}</span>
        <Badge variant={ensuring ? 'warn' : status?.up ? 'ok' : status?.state === 'starting' ? 'warn' : 'err'} data-testid="dbx-state">
          {stateLabel}
        </Badge>
        {status?.pid && <Badge variant="muted">pid {status.pid}</Badge>}
        {status?.version && <Badge variant="muted">v{status.version}</Badge>}
        <Badge variant="muted">:{status?.port ?? 4224}</Badge>
        <Toggle checked={status?.autoRestart ?? false} onChange={toggleAuto} label={i18nT('apps.dbx.autoRestart')} tone="muted" data-testid="dbx-auto-restart" />
        <div className="ml-auto flex shrink-0 gap-1.5">
          {running ? (
            <>
              <Btn className="py-0.5 text-[11px]" disabled={!!busy} onClick={() => setIframeKey((k) => k + 1)}>
                <RefreshCw size={11} />
                {i18nT('apps.dbx.reload')}
              </Btn>
              <Btn className="py-0.5 text-[11px]" disabled={!!busy} onClick={showLogs} data-testid="dbx-logs">
                {busy === 'logs' ? <Loader2 size={11} className="animate-spin" /> : <ScrollText size={11} />}
                {i18nT('apps.dbx.logs')}
              </Btn>
              <Btn danger className="py-0.5 text-[11px]" disabled={!!busy} onClick={() => op('restart', async () => void j(await fetch(`${BASE}/restart`, { method: 'POST' })))}>
                {busy === 'restart' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {i18nT('apps.dbx.restart')}
              </Btn>
              <Btn danger className="py-0.5 text-[11px]" disabled={!!busy} onClick={stop} data-testid="dbx-stop">
                <Square size={11} />
                {i18nT('apps.dbx.stop')}
              </Btn>
            </>
          ) : (
            <Btn
              primary
              className="py-0.5 text-[12px]"
              disabled={!!busy || ensuring || status?.binaryPresent === false}
              onClick={start}
              data-testid="dbx-start"
            >
              {busy || ensuring ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              {ensuring ? i18nT('apps.dbx.state.checking') : i18nT('apps.dbx.start')}
            </Btn>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2" data-testid="dbx-error">
          <ErrorNotice message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {/* body: iframe or stopped panel */}
      {running ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {typeof status?.auth?.setup_required === 'boolean' && status.auth.setup_required && (
            <div className="border-b border-warn bg-warn-subtle px-3 py-1.5 text-[11px] text-warn" data-testid="dbx-setup-hint">
              {i18nT('apps.dbx.setupHint')}
            </div>
          )}
          <iframe
            key={iframeKey}
            src={PROXY}
            className="min-h-0 flex-1 border-0 bg-bg"
            title={i18nT('apps.dbx.title')}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <Card className="max-w-lg p-6 text-center">
            <Database size={28} className="mx-auto text-muted" />
            <p className="mt-3 text-[15px] font-medium text-text-strong">{i18nT('apps.dbx.stoppedTitle')}</p>
            <p className="mt-2 text-[12.5px] leading-6 text-muted">{i18nT('apps.dbx.stoppedBody')}</p>
            <p className="mt-3 font-mono text-[10px] text-muted/70">
              {status?.binary ?? ''} · {status?.dataDir ?? ''}
            </p>
            <Btn
              primary
              className="mx-auto mt-4 px-6 py-2 text-[13px]"
              disabled={!!busy || ensuring}
              onClick={start}
            >
              {busy || ensuring ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {i18nT('apps.dbx.start')}
            </Btn>
          </Card>
        </div>
      )}

      {/* connection bridge drawer */}
      {(running || conns?.length) && (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border bg-card px-3 py-2" data-testid="dbx-connections">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11.5px] font-semibold text-text-strong">{i18nT('apps.dbx.connections')}</span>
            <span className="rounded bg-bg-hover px-1.5 text-[9.5px] text-muted">{conns?.length ?? 0}</span>
            <span className="text-[9.5px] text-muted/70">{i18nT('apps.dbx.connectionsReadOnly')}</span>
            <div className="ml-auto flex items-center gap-1">
              <Sparkles size={11} className="text-aim" />
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void askAi()}
                placeholder={i18nT('apps.dbx.askPlaceholder')}
                className="h-6 w-64 rounded border border-border bg-bg px-2 text-[10.5px] text-text outline-none focus:border-accent"
                data-testid="dbx-ask"
              />
              <Btn
                className="px-1.5 py-0 text-[10px]"
                disabled={busy === 'ai' || !question.trim()}
                onClick={() => void askAi()}
              >
                {busy === 'ai' ? <Loader2 size={10} className="animate-spin" /> : i18nT('apps.dbx.ask')}
              </Btn>
            </div>
          </div>
          {prompt && (
            <div className="mb-1.5 rounded border border-aim/40 bg-bg p-2">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-aim">
                <Terminal size={10} />
                {i18nT('apps.dbx.promptReady')}
                <Btn className="ml-auto px-1.5 py-0 text-[9px]" onClick={() => void navigator.clipboard?.writeText(prompt)}>
                  {i18nT('apps.dbx.copy')}
                </Btn>
                <Btn className="px-1.5 py-0 text-[9px]" onClick={() => setPrompt(null)}>
                  ×
                </Btn>
              </div>
              <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[9.5px] leading-4 text-text">{prompt}</pre>
            </div>
          )}
          {conns === null ? (
            <div className="flex items-center gap-1.5 py-1.5 text-[10.5px] text-muted">
              <Loader2 size={10} className="animate-spin" />
              {i18nT('apps.dbx.loadingConnections')}
            </div>
          ) : conns.length === 0 ? (
            <div className="py-1">
              <EmptyState icon={<Database size={18} />} title={i18nT('apps.dbx.noConnections')} testId="dbx-no-connections" />
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {conns.map((c, i) => (
                <a
                  key={i}
                  href={c.openInUi ?? PROXY}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] text-text hover:border-accent hover:text-accent"
                  title={`${c.type ?? c.db_type ?? ''} ${c.host ?? ''}${c.port ? `:${c.port}` : ''}${c.database ? ` /${c.database}` : ''}`}
                >
                  {c.name ?? c.id}
                  <span className="ml-1 text-muted/60">{c.type ?? c.db_type ?? ''}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* logs drawer */}
      {logs !== null && (
        <Card className="fixed inset-x-4 bottom-4 z-40 p-3 shadow-xl" data-testid="dbx-log-panel">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-text-strong">
            <ScrollText size={12} className="text-muted" />
            {i18nT('apps.dbx.logTail')}
            <Btn className="ml-auto px-1.5 py-0 text-[10px]" onClick={() => setLogs(null)}>
              ×
            </Btn>
          </div>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[9.5px] leading-4 text-muted">{logs || i18nT('apps.dbx.noLogs')}</pre>
        </Card>
      )}
    </div>
  )
}
