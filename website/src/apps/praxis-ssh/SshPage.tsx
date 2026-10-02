/**
 * SSH Terminal — connection manager + remote command execution.
 *
 * Left: saved connections (add/test/remove) + SSH key inventory.
 * Right: remote command execution with output display.
 */
import { useCallback, useEffect, useState } from 'react'

const BASE = '/api/apps/praxis-ssh'

type Conn = { id: string; name: string; host: string; port: number; user: string; keyPath: string }
type SshKey = { path: string; type: string; comment: string }

export default function SshPage() {
  const [conns, setConns] = useState<Conn[]>([])
  const [keys, setKeys] = useState<SshKey[]>([])
  const [active, setActive] = useState<Conn | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newHost, setNewHost] = useState('')
  const [newUser, setNewUser] = useState('')
  const [newPort, setNewPort] = useState('22')
  const [newKey, setNewKey] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [cmd, setCmd] = useState('')
  const [output, setOutput] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => {
    fetch(`${BASE}/connections`).then(r => r.json()).then(d => setConns(d.connections ?? [])).catch(() => {})
    fetch(`${BASE}/keys`).then(r => r.json()).then(d => setKeys(d.keys ?? [])).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const addConn = () => {
    if (!newName.trim() || !newHost.trim()) return
    fetch(`${BASE}/connections`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName, host: newHost, user: newUser, port: parseInt(newPort) || 22, keyPath: newKey }),
    }).then(() => { setShowAdd(false); setNewName(''); setNewHost(''); refresh() }).catch(() => {})
  }
  const removeConn = (id: string) => {
    fetch(`${BASE}/connections/${id}/remove`, { method: 'POST' }).then(() => { refresh(); setActive(null) }).catch(() => {})
  }
  const testConn = (c: Conn) => {
    setBusy(`test:${c.id}`); setTestResult(null)
    fetch(`${BASE}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: c.host, port: c.port, user: c.user, keyPath: c.keyPath }),
    })
      .then(r => r.json())
      .then(d => setTestResult(d.ok ? `✓ ${c.name} 连接成功` : `✗ ${c.name}: ${d.error ?? d.output ?? '连接失败'}`))
      .catch(e => setTestResult(`✗ ${e}`))
      .finally(() => setBusy(null))
  }
  const execCmd = () => {
    if (!active || !cmd.trim()) return
    setBusy('exec'); setOutput(null)
    fetch(`${BASE}/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: active.id, command: cmd }),
    })
      .then(r => r.json())
      .then(d => setOutput(d.error ? `ERROR: ${d.error}` : `$ ${cmd}\n${d.stdout || ''}${d.stderr ? `\n[stderr]\n${d.stderr}` : ''}\n[exit: ${d.exitCode}]`))
      .catch(e => setOutput(`ERROR: ${e}`))
      .finally(() => setBusy(null))
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Left: connections + keys */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-10 items-center gap-2 border-b border-border px-3">
          <span className="text-[13px] font-semibold text-text-strong">SSH 连接</span>
          <button className="ml-auto rounded border border-border px-1.5 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={() => setShowAdd(!showAdd)}>+ 添加</button>
        </div>
        {showAdd && (
          <div className="space-y-1.5 border-b border-border p-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="名称" className="h-7 w-full rounded border border-border bg-bg px-2 text-[12px] text-text outline-none placeholder:text-muted" />
            <input value={newHost} onChange={e => setNewHost(e.target.value)} placeholder="主机 (host 或 IP)" className="h-7 w-full rounded border border-border bg-bg px-2 font-mono text-[11px] text-text outline-none placeholder:text-muted" />
            <div className="flex gap-1.5">
              <input value={newUser} onChange={e => setNewUser(e.target.value)} placeholder="用户" className="h-7 w-20 rounded border border-border bg-bg px-2 text-[11px] text-text outline-none placeholder:text-muted" />
              <input value={newPort} onChange={e => setNewPort(e.target.value)} placeholder="端口" className="h-7 w-16 rounded border border-border bg-bg px-2 text-[11px] text-text outline-none placeholder:text-muted" />
            </div>
            <select value={newKey} onChange={e => setNewKey(e.target.value)} className="h-7 w-full rounded border border-border bg-bg px-2 text-[11px] text-text outline-none">
              <option value="">默认密钥</option>
              {keys.map(k => <option key={k.path} value={k.path}>{k.comment || k.path}</option>)}
            </select>
            <button className="h-7 w-full rounded bg-accent text-[11.5px] text-accent-fg hover:opacity-90" onClick={addConn}>保存连接</button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {conns.map(c => (
            <div key={c.id} className={`group flex items-center gap-2 rounded px-2 py-1.5 ${active?.id === c.id ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}>
              <button className="flex min-w-0 flex-1 flex-col items-start" onClick={() => { setActive(c); setOutput(null); setTestResult(null) }}>
                <span className="truncate text-[12.5px] text-text-strong">{c.name}</span>
                <span className="truncate font-mono text-[10px] text-muted">{c.user ? `${c.user}@` : ''}{c.host}:{c.port}</span>
              </button>
              <div className="hidden shrink-0 gap-0.5 group-hover:flex">
                <button className="rounded border border-border px-1 py-px text-[9px] text-accent" onClick={() => testConn(c)} disabled={busy !== null}>{busy === `test:${c.id}` ? '…' : '测试'}</button>
                <button className="rounded border border-border px-1 py-px text-[9px] text-danger" onClick={() => removeConn(c.id)}>删</button>
              </div>
            </div>
          ))}
          {conns.length === 0 && <p className="px-2 text-[12px] text-muted">还没有保存的连接。</p>}
        </div>
        {testResult && <div className={`border-t border-border px-3 py-2 text-[11.5px] ${testResult.startsWith('✓') ? 'text-ok' : 'text-danger'}`}>{testResult}</div>}
        {keys.length > 0 && (
          <div className="border-t border-border p-2">
            <div className="mb-1 text-[10px] font-semibold text-muted">可用密钥 ({keys.length})</div>
            {keys.slice(0, 5).map(k => (
              <div key={k.path} className="truncate font-mono text-[10px] text-muted">{k.comment || k.path.split('/').pop()}</div>
            ))}
          </div>
        )}
      </aside>

      {/* Right: terminal */}
      <div className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
              <span className="text-[14px] font-semibold text-text-strong">{active.name}</span>
              <span className="font-mono text-[11px] text-muted">{active.user ? `${active.user}@` : ''}{active.host}</span>
              {active.keyPath && <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">🔑 {active.keyPath.split('/').pop()}</span>}
            </div>
            <div className="flex-1 overflow-y-auto bg-neutral-900 p-3">
              {output ? (
                <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-neutral-200">{output}</pre>
              ) : (
                <div className="text-center text-[13px] text-neutral-500">
                  <p>输入命令在 <span className="font-mono text-neutral-300">{active.host}</span> 上执行</p>
                  <p className="mt-1 text-[11px]">30 秒超时 · 输出截断到 100KB</p>
                </div>
              )}
            </div>
            <div className="flex h-14 shrink-0 items-center gap-2 border-t border-neutral-700 bg-neutral-900 px-3">
              <span className="font-mono text-[13px] text-emerald-400">$</span>
              <input
                value={cmd}
                onChange={e => setCmd(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); execCmd() } }}
                placeholder="输入远程命令…"
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-neutral-100 outline-none placeholder:text-neutral-600"
              />
              <button disabled={busy !== null || !cmd.trim()} className="rounded bg-accent px-3 py-1 text-[12px] text-accent-fg hover:opacity-90 disabled:opacity-30" onClick={execCmd}>
                {busy === 'exec' ? '执行中…' : '执行'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-bg">
            <div className="max-w-md text-center">
              <p className="text-[15px] font-medium text-text-strong">SSH 远程终端</p>
              <p className="mt-2 text-[13px] text-muted">
                从左侧选择一个连接，或在 KiroCrew 底部终端面板直接使用 <code className="rounded bg-bg-elevated px-1 font-mono text-[11px]">ssh</code> 命令。
                这里保存的连接支持一键测试和远程命令执行。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
