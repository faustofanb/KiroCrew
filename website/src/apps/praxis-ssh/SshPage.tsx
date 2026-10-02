/**
 * SSH — connections, key inventory, streaming exec, interactive PTY, SFTP.
 *
 * Five tabs over one owner-gated backend (system ssh, key auth only, no
 * stored passwords): Connections (CRUD + connectivity probe with host-key
 * state and latency), Keys (~/.ssh/*.pub fingerprints + agent + known_hosts),
 * Exec (SSE-streamed stdout/stderr with exit codes + history), Terminal
 * (xterm.js over the websocket PTY bridge), Files (SFTP browse + upload +
 * download + mkdir/rename/remove). Every list carries empty/loading/error.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  Clock,
  FolderTree,
  KeySquare,
  Loader2,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Server,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
} from 'lucide-react'
import { i18nT } from '../../i18n/t'
import SimpleSelect from '../../components/SimpleSelect'

const BASE = '/api/apps/praxis-ssh'

type Conn = {
  id: string
  name: string
  host: string
  port: number
  user: string
  identityFile: string | null
  labels?: string | null
  lastTest?: { at: number; ok: boolean; state: string; latencyMs: number | null } | null
}
type SshKey = { pubFile: string; privatePresent: boolean; type: string; bits: number; fingerprint: string; comment: string }
type AgentStatus = { running: boolean; hasSocket: boolean; keys: { fingerprint: string; type: string }[]; hint?: string }
type KnownHosts = { entries: { kind: string; host: string; keyType: string }[]; total: number; truncated: boolean }
type DirEntry = { name: string; dir: boolean; symlink: boolean; size: string; mtime: string; owner: string }
type ExecEvent =
  | { type: 'start'; command: string }
  | { type: 'line'; stream: string; text: string }
  | { type: 'timeout'; seconds: number }
  | { type: 'done'; exitCode: number; error?: string }
  | { type: 'closed' }
type HistItem = { at: number; connectionId: string; command: string; exitCode: number; timedOut?: boolean }

type Load = 'idle' | 'loading' | 'error' | 'ready'

async function j<T>(resp: Response): Promise<T> {
  const body = await resp.json().catch(() => ({}) as T)
  if (!resp.ok) {
    const e = body as { error?: string }
    throw new Error(e.error || `HTTP ${resp.status}`)
  }
  return body as T
}

function Tri(props: { state: Load; error?: string | null; empty?: boolean; emptyText?: string; children: React.ReactNode }) {
  if (props.state === 'loading')
    return (
      <div className="flex justify-center p-4">
        <Loader2 size={14} className="animate-spin text-muted" />
      </div>
    )
  if (props.state === 'error')
    return (
      <div className="m-2 rounded border border-danger bg-danger-subtle p-2 text-[12px] text-danger">
        <AlertTriangle size={12} className="mr-1 inline" />
        {props.error}
      </div>
    )
  if (props.empty) return <div className="p-4 text-center text-[12px] text-muted">{props.emptyText}</div>
  return <>{props.children}</>
}

// ── Connections tab ──────────────────────────────────────────────────────────

function ConnectionsTab(props: { onNotice: (k: 'ok' | 'error' | 'info', t: string) => void; refreshKey: number }) {
  const [conns, setConns] = useState<Conn[]>([])
  const [state, setState] = useState<Load>('idle')
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', host: '', port: '22', user: '', identityFile: '' })
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    setState('loading')
    fetch(`${BASE}/connections`)
      .then((r) => j<{ connections: Conn[] }>(r))
      .then((d) => {
        setConns(d.connections)
        setState('ready')
      })
      .catch((e) => {
        setError(String(e))
        setState('error')
      })
  }, [])
  useEffect(load, [load, props.refreshKey])

  const create = async () => {
    if (!form.host.trim()) return
    setBusy('create')
    try {
      await j(
        await fetch(`${BASE}/connections`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...form, port: parseInt(form.port || '22', 10) }),
        }),
      )
      setForm({ name: '', host: '', port: '22', user: '', identityFile: '' })
      load()
    } catch (e) {
      props.onNotice('error', String(e))
    } finally {
      setBusy(null)
    }
  }

  const test = async (id: string) => {
    setBusy(id)
    try {
      const r = await j<{ ok: boolean; state: string; latencyMs: number | null; hint?: string }>(
        await fetch(`${BASE}/connections/${id}/test`, { method: 'POST' }),
      )
      props.onNotice(r.ok ? 'ok' : 'error', `${r.state}${r.latencyMs !== null ? ` · ${r.latencyMs}ms` : ''}${r.hint ? ` — ${r.hint}` : ''}`)
      load()
    } catch (e) {
      props.onNotice('error', String(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string) => {
    setBusy(id)
    try {
      await j(await fetch(`${BASE}/connections/${id}`, { method: 'DELETE' }))
      load()
    } catch (e) {
      props.onNotice('error', String(e))
    } finally {
      setBusy(null)
    }
  }

  const stateTone = (s: string) =>
    s === 'ok' ? 'text-ok' : s === 'hostkey-changed' ? 'text-danger' : s === 'auth-refused' || s === 'unreachable' || s === 'timeout' ? 'text-warn' : 'text-muted'

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto p-3">
        <Tri state={state} error={error} empty={!conns.length} emptyText={i18nT('apps.ssh.conn.empty')}>
          {conns.map((c) => (
            <div key={c.id} className="group mb-1.5 flex items-center gap-2 rounded border border-border bg-card px-3 py-2" data-testid={`ssh-conn-${c.host}`}>
              <Server size={14} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium text-text-strong">{c.name || c.host}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">
                    {c.user ? `${c.user}@` : ''}
                    {c.host}:{c.port}
                  </span>
                  {c.lastTest && (
                    <span className={`shrink-0 text-[10px] ${stateTone(c.lastTest.state)}`}>
                      {c.lastTest.state}
                      {c.lastTest.latencyMs !== null ? ` ${c.lastTest.latencyMs}ms` : ''}
                    </span>
                  )}
                </div>
                {c.identityFile && <div className="truncate font-mono text-[9.5px] text-muted/70">🔑 {c.identityFile}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                <button className="rounded border border-border px-2 py-0.5 text-[10px] text-text hover:bg-bg-hover" disabled={busy === c.id} onClick={() => void test(c.id)} data-testid={`ssh-test-${c.host}`}>
                  {busy === c.id ? <Loader2 size={10} className="animate-spin" /> : i18nT('apps.ssh.conn.test')}
                </button>
                <button className="rounded border border-border px-2 py-0.5 text-[10px] text-danger hover:bg-danger-subtle" disabled={busy === c.id} onClick={() => void remove(c.id)}>
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          ))}
        </Tri>
      </div>
      <div className="w-72 shrink-0 border-l border-border p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-text-strong">
          <Plus size={12} />
          {i18nT('apps.ssh.conn.add')}
        </div>
        {(['name', 'host', 'port', 'user', 'identityFile'] as const).map((k) => (
          <input
            key={k}
            value={form[k]}
            onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
            placeholder={i18nT(`apps.ssh.conn.field_${k}`)}
            className="mb-1.5 h-8 w-full rounded border border-border bg-bg px-2 font-mono text-[11px] text-text outline-none focus:border-accent"
            data-testid={`ssh-form-${k}`}
          />
        ))}
        <p className="mb-2 text-[9.5px] leading-4 text-muted/70">{i18nT('apps.ssh.conn.noPassword')}</p>
        <button
          className="inline-flex w-full items-center justify-center gap-1 rounded bg-accent px-3 py-1.5 text-[12px] text-accent-fg hover:opacity-90 disabled:opacity-40"
          disabled={busy === 'create' || !form.host.trim()}
          onClick={() => void create()}
          data-testid="ssh-create"
        >
          {busy === 'create' ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          {i18nT('apps.ssh.conn.add')}
        </button>
      </div>
    </div>
  )
}

// ── Keys tab ─────────────────────────────────────────────────────────────────

function KeysTab() {
  const [keys, setKeys] = useState<SshKey[]>([])
  const [agent, setAgent] = useState<AgentStatus | null>(null)
  const [kh, setKh] = useState<KnownHosts | null>(null)
  const [state, setState] = useState<Load>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setState('loading')
    Promise.all([
      fetch(`${BASE}/keys`).then((r) => j<{ keys: SshKey[] }>(r)),
      fetch(`${BASE}/agent`).then((r) => j<AgentStatus>(r)),
      fetch(`${BASE}/known-hosts`).then((r) => j<KnownHosts>(r)),
    ])
      .then(([k, a, h]) => {
        setKeys(k.keys)
        setAgent(a)
        setKh(h)
        setState('ready')
      })
      .catch((e) => {
        setError(String(e))
        setState('error')
      })
  }, [])

  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-3 overflow-y-auto p-3" data-testid="ssh-keys">
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-text-strong">
          <KeySquare size={12} className="text-accent" />
          {i18nT('apps.ssh.keys.title')}
        </div>
        <Tri state={state} error={error} empty={!keys.length} emptyText={i18nT('apps.ssh.keys.empty')}>
          {keys.map((k) => (
            <div key={k.pubFile} className="mb-1 rounded border border-border bg-card px-2.5 py-1.5" data-testid={`ssh-key-${k.pubFile}`}>
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[11px] text-text-strong">{k.pubFile}</span>
                <span className="shrink-0 rounded bg-bg-hover px-1.5 text-[9px] text-muted">{k.type || '?'}</span>
                {k.bits > 0 && <span className="shrink-0 font-mono text-[9px] text-muted/60">{k.bits}b</span>}
                {!k.privatePresent && <span className="shrink-0 text-[9px] text-warn">{i18nT('apps.ssh.keys.pubOnly')}</span>}
              </div>
              <div className="truncate font-mono text-[9.5px] text-muted">{k.fingerprint}</div>
              {k.comment && <div className="truncate text-[9.5px] text-muted/70">{k.comment}</div>}
            </div>
          ))}
        </Tri>
      </div>
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-text-strong">
          <Monitor size={12} className={agent?.running ? 'text-ok' : 'text-warn'} />
          {i18nT('apps.ssh.agent.title')}
          <span className={`rounded px-1.5 text-[9.5px] ${agent?.running ? 'bg-ok-subtle text-ok' : 'bg-warn-subtle text-warn'}`}>
            {agent?.running ? i18nT('apps.ssh.agent.running') : i18nT('apps.ssh.agent.notRunning')}
          </span>
        </div>
        {agent && !agent.running && <div className="mb-2 text-[10px] text-warn">{agent.hint}</div>}
        {agent?.keys.map((k, i) => (
          <div key={i} className="truncate font-mono text-[10px] text-muted">
            {k.fingerprint} <span className="text-muted/60">{k.type}</span>
          </div>
        ))}
        <div className="mb-1.5 mt-4 flex items-center gap-1.5 text-[12px] font-semibold text-text-strong">
          <Server size={12} className="text-muted" />
          {i18nT('apps.ssh.knownHosts.title')}
          <span className="text-[10px] font-normal text-muted">{kh?.total ?? 0}</span>
        </div>
        <div className="max-h-56 overflow-y-auto rounded border border-border/60">
          {(kh?.entries ?? []).slice(0, 100).map((e, i) => (
            <div key={i} className="flex items-center gap-2 border-b border-border/20 px-2 py-0.5 font-mono text-[9.5px]">
              <span className={e.kind === 'hashed' ? 'text-muted/60' : 'text-text'}>{e.host}</span>
              <span className="ml-auto text-muted/60">{e.keyType}</span>
            </div>
          ))}
          {kh?.truncated && <div className="px-2 py-1 text-[9px] text-warn">{i18nT('apps.ssh.knownHosts.truncated')}</div>}
        </div>
      </div>
    </div>
  )
}

// ── Exec tab ─────────────────────────────────────────────────────────────────

function ExecTab(props: { conns: Conn[]; onNotice: (k: 'ok' | 'error' | 'info', t: string) => void }) {
  const [connId, setConnId] = useState('')
  const [command, setCommand] = useState('')
  const [lines, setLines] = useState<{ stream: string; text: string }[]>([])
  const [running, setRunning] = useState(false)
  const [exit, setExit] = useState<number | null>(null)
  const [hist, setHist] = useState<HistItem[]>([])
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!connId && props.conns.length) setConnId(props.conns[0].id)
  }, [props.conns, connId])
  useEffect(() => {
    fetch(`${BASE}/history`)
      .then((r) => j<{ history: HistItem[] }>(r))
      .then((d) => setHist(d.history))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines])

  const run = () => {
    if (!connId || !command.trim() || running) return
    setLines([])
    setExit(null)
    setRunning(true)
    fetch(`${BASE}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: connId, command }),
    })
      .then((r) => j<{ opId: string }>(r))
      .then(({ opId }) => {
        const es = new EventSource(`${BASE}/exec/${opId}/stream`)
        es.onmessage = (ev) => {
          try {
            const e = JSON.parse(ev.data) as ExecEvent
            if (e.type === 'line') setLines((l) => [...l.slice(-500), { stream: e.stream, text: e.text }])
            else if (e.type === 'timeout') setLines((l) => [...l, { stream: 'stderr', text: `⏱ timeout ${e.seconds}s` }])
            else if (e.type === 'done') {
              setExit(e.exitCode)
              setRunning(false)
              es.close()
              fetch(`${BASE}/history`)
                .then((r) => j<{ history: HistItem[] }>(r))
                .then((d) => setHist(d.history))
                .catch(() => {})
            } else if (e.type === 'closed') {
              setRunning(false)
              es.close()
            }
          } catch {
            /* skip malformed frame */
          }
        }
        es.onerror = () => {
          setRunning(false)
          es.close()
        }
      })
      .catch((e) => {
        props.onNotice('error', String(e))
        setRunning(false)
      })
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
          <SimpleSelect
            options={props.conns.map((c) => c.id)}
            optionLabels={props.conns.map((c) => c.name || c.host)}
            value={connId}
            onChange={setConnId}
            aria-label={i18nT('apps.ssh.tab.connections')}
            className="h-8 max-w-52 font-mono text-[11px]"
          />
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder={i18nT('apps.ssh.exec.placeholder')}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-bg px-2 font-mono text-[11.5px] text-text outline-none focus:border-accent"
            data-testid="exec-command"
          />
          <button className="inline-flex shrink-0 items-center gap-1 rounded bg-accent px-3 py-1.5 text-[11.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" disabled={running || !command.trim() || !connId} onClick={run} data-testid="exec-run">
            {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            {i18nT('apps.ssh.exec.run')}
          </button>
          {exit !== null && <span className={`shrink-0 font-mono text-[10px] ${exit === 0 ? 'text-ok' : 'text-danger'}`}>exit {exit}</span>}
        </div>
        <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto bg-bg p-2 font-mono text-[11px] leading-5" data-testid="exec-output">
          {lines.length === 0 && !running && <div className="p-4 text-center text-muted">{i18nT('apps.ssh.exec.empty')}</div>}
          {lines.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${l.stream === 'stderr' ? 'text-danger' : 'text-text'}`}>
              {l.text}
            </div>
          ))}
          {running && <Loader2 size={11} className="animate-spin text-muted" />}
        </div>
      </div>
      <div className="w-64 shrink-0 overflow-y-auto border-l border-border p-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-text-strong">
          <Clock size={11} className="text-muted" />
          {i18nT('apps.ssh.exec.history')}
        </div>
        {hist.length === 0 && <div className="text-[10.5px] text-muted">{i18nT('apps.ssh.exec.noHistory')}</div>}
        {hist.slice().reverse().map((h, i) => (
          <button
            key={i}
            className="mb-1 block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[10px] text-text hover:bg-bg-hover"
            title={h.command}
            onClick={() => setCommand(h.command)}
          >
            <span className={h.exitCode === 0 ? 'text-ok' : 'text-danger'}>{h.exitCode}</span> {h.command}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Terminal tab ─────────────────────────────────────────────────────────────

function TerminalTab(props: { conns: Conn[]; onNotice: (k: 'ok' | 'error' | 'info', t: string) => void }) {
  const [connId, setConnId] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const holderRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!connId && props.conns.length) setConnId(props.conns[0].id)
  }, [props.conns, connId])

  const open = () => {
    if (!connId) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}${BASE}/terminal/${connId}`)
    ws.binaryType = 'arraybuffer'
    const term = new Terminal({ cursorBlink: true, fontSize: 12, theme: { background: 'transparent' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(holderRef.current!)
    fit.fit()
    termRef.current = term
    wsRef.current = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ resize: [term.cols, term.rows] }))
      term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(new TextEncoder().encode(d)))
      term.onResize(({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ resize: [cols, rows] })))
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return
      term.write(new Uint8Array(ev.data))
    }
    ws.onclose = () => {
      term.write('\r\n\x1b[90m— ' + i18nT('apps.ssh.term.closed') + ' —\x1b[0m')
      setActive(null)
    }
    ws.onerror = () => props.onNotice('error', i18nT('apps.ssh.term.error'))
    setActive(connId)
    term.focus()
  }

  const close = () => {
    wsRef.current?.close()
    termRef.current?.dispose()
    termRef.current = null
    setActive(null)
  }

  const conn = props.conns.find((c) => c.id === connId)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ssh-terminal">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <TerminalIcon size={13} className="text-accent" />
        <SimpleSelect
          options={props.conns.map((c) => c.id)}
          optionLabels={props.conns.map((c) => c.name || c.host)}
          value={connId}
          onChange={setConnId}
          disabled={!!active}
          aria-label={i18nT('apps.ssh.tab.connections')}
          className="h-7 max-w-52 font-mono text-[11px]"
        />
        {active ? (
          <button className="rounded border border-danger px-2.5 py-1 text-[11px] text-danger hover:bg-danger-subtle" onClick={close} data-testid="term-close">
            {i18nT('apps.ssh.term.close')}
          </button>
        ) : (
          <button className="rounded bg-accent px-3 py-1 text-[11.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" disabled={!connId} onClick={open} data-testid="term-open">
            {i18nT('apps.ssh.term.open')}
          </button>
        )}
        {active && conn && (
          <span className="font-mono text-[10px] text-muted">
            {conn.user ? `${conn.user}@` : ''}
            {conn.host}
          </span>
        )}
        <span className="ml-auto text-[9.5px] text-muted/60">{i18nT('apps.ssh.term.hint')}</span>
      </div>
      <div ref={holderRef} className={`min-h-0 flex-1 overflow-hidden bg-bg p-2 ${active ? '' : 'flex items-center justify-center'}`} data-testid="term-holder">
        {!active && <div className="text-[12px] text-muted">{i18nT('apps.ssh.term.pickFirst')}</div>}
      </div>
    </div>
  )
}

// ── Files (SFTP) tab ─────────────────────────────────────────────────────────

function FilesTab(props: { conns: Conn[]; onNotice: (k: 'ok' | 'error' | 'info', t: string) => void }) {
  const [connId, setConnId] = useState('')
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [state, setState] = useState<Load>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!connId && props.conns.length) setConnId(props.conns[0].id)
  }, [props.conns, connId])

  const load = useCallback(
    (p: string) => {
      if (!connId) return
      setState('loading')
      setError(null)
      fetch(`${BASE}/sftp/list?connectionId=${encodeURIComponent(connId)}&path=${encodeURIComponent(p)}`)
        .then((r) => j<{ path: string; entries: DirEntry[] }>(r))
        .then((d) => {
          setPath(d.path)
          setEntries(d.entries)
          setState('ready')
        })
        .catch((e) => {
          setError(String(e))
          setState('error')
        })
    },
    [connId],
  )

  useEffect(() => {
    if (connId && entries === null) load('.')
  }, [connId, entries, load])

  const crumbs = useMemo(() => path.split('/').filter(Boolean), [path])

  const upload = async (file: File) => {
    if (!connId) return
    setBusy(true)
    try {
      const remote = path === '.' ? `./${file.name}` : `${path.replace(/\/$/, '')}/${file.name}`
      const resp = await fetch(`${BASE}/sftp/upload?connectionId=${encodeURIComponent(connId)}&path=${encodeURIComponent(remote)}`, {
        method: 'POST',
        body: file,
      })
      await j(resp)
      props.onNotice('ok', `${file.name} → ${remote}`)
      load(path)
    } catch (e) {
      props.onNotice('error', String(e))
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const op = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true)
    try {
      await fn()
      props.onNotice('ok', label)
      load(path)
    } catch (e) {
      props.onNotice('error', String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ssh-files">
      <div className="flex h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3">
        <FolderTree size={13} className="text-accent" />
        <SimpleSelect
          options={props.conns.map((c) => c.id)}
          optionLabels={props.conns.map((c) => c.name || c.host)}
          value={connId}
          onChange={(v) => { setConnId(v); setEntries(null) }}
          aria-label={i18nT('apps.ssh.tab.connections')}
          className="h-7 max-w-52 font-mono text-[11px]"
        />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[11px]">
          <button className="rounded px-1 text-accent hover:bg-bg-hover" onClick={() => load('/')}>
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex shrink-0 items-center">
              <button
                className="rounded px-1 text-text hover:bg-bg-hover"
                onClick={() => load('/' + crumbs.slice(0, i + 1).join('/'))}
              >
                {c}
              </button>
              {i < crumbs.length - 1 && <ChevronRight size={10} className="text-muted/50" />}
            </span>
          ))}
        </div>
        <button className="rounded border border-border p-1 text-muted hover:bg-bg-hover hover:text-text" disabled={busy || !connId} onClick={() => load(path)} title={i18nT('apps.ssh.files.refresh')}>
          <RefreshCw size={11} />
        </button>
        <button
          className="inline-flex items-center gap-1 rounded border border-accent px-2 py-1 text-[10.5px] text-accent hover:bg-accent-subtle disabled:opacity-40"
          disabled={busy || !connId}
          onClick={() => fileInputRef.current?.click()}
          data-testid="sftp-upload-btn"
        >
          <Upload size={10} />
          {i18nT('apps.ssh.files.upload')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Tri state={state} error={error} empty={entries !== null && entries.length === 0} emptyText={i18nT('apps.ssh.files.empty')}>
          {entries && (
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="sticky top-0 bg-card text-[9.5px] text-muted">
                <tr>
                  <th className="px-3 py-1 font-medium">{i18nT('apps.ssh.files.name')}</th>
                  <th className="px-2 py-1 font-medium">{i18nT('apps.ssh.files.size')}</th>
                  <th className="px-2 py-1 font-medium">{i18nT('apps.ssh.files.mtime')}</th>
                  <th className="px-2 py-1 font-medium">{i18nT('apps.ssh.files.owner')}</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.name} className="group border-b border-border/20 hover:bg-bg-hover" data-testid={`sftp-entry-${e.name}`}>
                    <td className="max-w-0 truncate px-3 py-1">
                      {e.dir ? (
                        <button className="text-accent" onClick={() => load(joinPath(path, e.name))} data-testid={`sftp-dir-${e.name}`}>
                          {e.name}/
                        </button>
                      ) : e.symlink ? (
                        <span className="text-info">{e.name}</span>
                      ) : (
                        <a
                          className="text-text hover:underline"
                          href={`${BASE}/sftp/download?connectionId=${encodeURIComponent(connId)}&path=${encodeURIComponent(joinPath(path, e.name))}`}
                        >
                          {e.name}
                        </a>
                      )}
                    </td>
                    <td className="px-2 py-1 text-muted">{e.dir ? '—' : e.size}</td>
                    <td className="px-2 py-1 text-muted">{e.mtime}</td>
                    <td className="px-2 py-1 text-muted/70">{e.owner}</td>
                    <td className="px-2 py-1 text-right">
                      <div className="hidden gap-1 group-hover:flex">
                        <button
                          className="rounded border border-border px-1.5 py-px text-[9px] text-muted"
                          onClick={() => {
                            const name = prompt(i18nT('apps.ssh.files.newName'))
                            if (name) void op(() => fetch(`${BASE}/sftp/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: connId, from: joinPath(path, e.name), to: joinPath(path, name) }) }).then(j), name)
                          }}
                        >
                          {i18nT('apps.ssh.files.rename')}
                        </button>
                        <button
                          className="rounded border border-danger px-1.5 py-px text-[9px] text-danger"
                          onClick={() => {
                            if (!window.confirm(i18nT('apps.ssh.files.rmConfirm', { name: e.name }))) return
                            void op(() => fetch(`${BASE}/sftp/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: connId, path: joinPath(path, e.name), recursive: e.dir }) }).then(j), e.name)
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tri>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-3">
        <ArrowUp size={11} className="text-muted" />
        <input
          placeholder={i18nT('apps.ssh.files.mkdirPlaceholder')}
          className="h-6 w-56 rounded border border-border bg-bg px-2 font-mono text-[10.5px] text-text outline-none focus:border-accent"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const name = (e.target as HTMLInputElement).value.trim()
              if (name) {
                ;(e.target as HTMLInputElement).value = ''
                void op(
                  () =>
                    fetch(`${BASE}/sftp/mkdir`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ connectionId: connId, path: joinPath(path, name) }),
                    }).then(j),
                  name,
                )
              }
            }
          }}
          data-testid="sftp-mkdir"
        />
      </div>
    </div>
  )
}

function joinPath(dir: string, name: string): string {
  if (dir === '.' || dir === '') return `./${name}`
  return `${dir.replace(/\/$/, '')}/${name}`
}

// ── page shell ───────────────────────────────────────────────────────────────

type Tab = 'connections' | 'keys' | 'exec' | 'terminal' | 'files'

export default function SshPage() {
  const [tab, setTab] = useState<Tab>('connections')
  const [refreshKey, setRefreshKey] = useState(0)
  const [conns, setConns] = useState<Conn[]>([])
  const [notices, setNotices] = useState<{ id: number; kind: 'ok' | 'error' | 'info'; text: string }[]>([])

  const notice = useCallback((kind: 'ok' | 'error' | 'info', text: string) => {
    setNotices((n) => [...n.slice(-3), { id: Date.now() + Math.random(), kind, text }])
    setRefreshKey((k) => k + 1)
  }, [])
  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), [])
  useEffect(() => {
    if (!notices.length) return
    const t = setTimeout(() => setNotices((n) => n.slice(1)), 5000)
    return () => clearTimeout(t)
  }, [notices])

  useEffect(() => {
    fetch(`${BASE}/connections`)
      .then((r) => j<{ connections: Conn[] }>(r))
      .then((d) => setConns(d.connections))
      .catch(() => {})
  }, [refreshKey])

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'connections', label: i18nT('apps.ssh.tab.connections'), icon: <Server size={12} /> },
    { id: 'keys', label: i18nT('apps.ssh.tab.keys'), icon: <KeySquare size={12} /> },
    { id: 'exec', label: i18nT('apps.ssh.tab.exec'), icon: <Play size={12} /> },
    { id: 'terminal', label: i18nT('apps.ssh.tab.terminal'), icon: <TerminalIcon size={12} /> },
    { id: 'files', label: i18nT('apps.ssh.tab.files'), icon: <FolderTree size={12} /> },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-card px-3">
        <ScrollText size={13} className="text-accent" />
        <span className="mr-2 text-[14px] font-semibold text-text-strong">{i18nT('apps.ssh.title')}</span>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`flex items-center gap-1 rounded px-2.5 py-1 text-[11.5px] ${tab === t.id ? 'bg-accent-subtle font-semibold text-accent' : 'text-muted hover:bg-bg-hover'}`}
            onClick={() => setTab(t.id)}
            data-testid={`ssh-tab-${t.id}`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[9.5px] text-muted/60">{i18nT('apps.ssh.policyHint')}</span>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'connections' && <ConnectionsTab onNotice={notice} refreshKey={refreshKey} />}
        {tab === 'keys' && <KeysTab />}
        {tab === 'exec' && <ExecTab conns={conns} onNotice={notice} />}
        {tab === 'terminal' && <TerminalTab conns={conns} onNotice={notice} />}
        {tab === 'files' && <FilesTab conns={conns} onNotice={notice} />}
      </div>
      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-80 flex-col gap-2">
        {notices.map((n) => (
          <button
            key={n.id}
            onClick={() => dismiss(n.id)}
            className={`pointer-events-auto rounded border px-3 py-2 text-left text-[12px] shadow-lg ${n.kind === 'error' ? 'border-danger bg-danger-subtle text-danger' : n.kind === 'ok' ? 'border-ok bg-ok-subtle text-ok' : 'border-border bg-card text-text'}`}
          >
            {n.text}
          </button>
        ))}
      </div>
    </div>
  )
}
