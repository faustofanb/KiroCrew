/**
 * DBX Database — embeds the full dbx-web UI (built from source, no Docker).
 * The dbx-web binary serves on localhost:4224 with the complete
 * query editor, data grid, ER diagram, and schema diff.
 *
 * This page: manages the dbx-web process lifecycle (start/stop/status)
 * and embeds it as a full-page iframe.
 */
import { useCallback, useEffect, useState } from 'react'

const DBX_PORT = 4224
const DBX_URL = `http://localhost:${DBX_PORT}`
const BASE = '/api/apps/praxis-dbx'

export default function DbxPage() {
  const [running, setRunning] = useState<boolean | 'checking'>('checking')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [iframeKey, setIframeKey] = useState(0)

  const check = useCallback(() => {
    fetch(`${BASE}/status`)
      .then(r => r.json())
      .then(d => setRunning(d.running ?? false))
      .catch(() => setRunning(false))
  }, [])
  useEffect(() => { check() }, [check])

  const start = () => {
    setStarting(true); setError(null)
    fetch(`${BASE}/start`, { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setRunning(false) }
        else { setRunning(true); setIframeKey(k => k + 1) }
      })
      .catch(e => setError(String(e)))
      .finally(() => setStarting(false))
  }

  const stop = () => {
    fetch(`${BASE}/stop`, { method: 'POST' })
      .then(() => { setRunning(false); check() })
      .catch(() => {})
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
        <span className="text-[14px] font-semibold text-text-strong">DBX Database</span>
        <span className="font-mono text-[11px] text-muted">100+ 数据库 · {DBX_URL}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${running === true ? 'bg-ok-subtle text-ok' : running === 'checking' ? 'bg-warn-subtle text-warn' : 'bg-danger-subtle text-danger'}`}>
          {running === true ? '运行中' : running === 'checking' ? '检测中…' : '未运行'}
        </span>
        <div className="ml-auto flex gap-1.5">
          {running !== true ? (
            <button disabled={starting} className="rounded-md bg-accent px-3 py-1 text-[12px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={start}>
              {starting ? '启动中…' : '启动 dbx-web'}
            </button>
          ) : (
            <>
              <button className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-bg-hover" onClick={() => setIframeKey(k => k + 1)}>刷新</button>
              <button className="rounded-md border border-danger px-2 py-1 text-[11px] text-danger hover:bg-danger-subtle" onClick={stop}>停止</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="mx-4 mt-3 rounded border border-danger bg-danger-subtle px-3 py-2 text-[12px] text-danger">{error}</div>}

      {running === true ? (
        <iframe key={iframeKey} src={DBX_URL} className="min-h-0 flex-1 border-0" title="DBX Web" sandbox="allow-same-origin allow-scripts allow-forms allow-popups" />
      ) : running === 'checking' ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">检查 dbx-web 状态…</div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-lg rounded-lg border border-border bg-card p-6 text-center">
            <p className="text-[15px] font-medium text-text-strong">DBX Web 未运行</p>
            <p className="mt-2 text-[13px] leading-6 text-muted">
              点击「启动 dbx-web」从本地编译的二进制启动完整 Web UI（查询编辑器、数据网格、ER 图、Schema Diff）。
              <br />无需 Docker。数据存储在 <code className="rounded bg-bg px-1 font-mono text-[11px]">~/.local/share/dbx-web</code>。
            </p>
            <button disabled={starting} className="mt-4 rounded-lg bg-accent px-6 py-2 text-[13px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={start}>
              {starting ? '启动中…' : '启动 dbx-web'}
            </button>
            <p className="mt-3 font-mono text-[10px] text-muted">二进制位置: /tmp/dbx/target/release/dbx-web · 端口: {DBX_PORT}</p>
          </div>
        </div>
      )}
    </div>
  )
}
