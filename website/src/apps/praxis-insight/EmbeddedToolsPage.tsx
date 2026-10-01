/**
 * Embedded Tools + Fork-quality Git GUI — the page-integration layer.
 *
 * LEFT PANEL: tool list (DBX Web etc.) — click to open as full-page iframe.
 * RIGHT PANEL (when a tool is selected): the tool's own web UI at native
 * fidelity inside an iframe, with a toolbar (reload / open external / status).
 *
 * Also: "Add tool" — paste any localhost URL to embed it.
 */
import { useCallback, useEffect, useState } from 'react'

type Tool = {
  id: string; name: string; url: string; category: string; description: string; launchCommand: string
}

export default function EmbeddedToolsPage() {
  const [tools, setTools] = useState<Tool[]>([])
  const [active, setActive] = useState<Tool | null>(null)
  const [reachable, setReachable] = useState<Record<string, boolean | 'checking'>>({})
  const [iframeKey, setIframeKey] = useState(0)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [launching, setLaunching] = useState<string | null>(null)
  const [launchOutput, setLaunchOutput] = useState<string | null>(null)

  const refresh = useCallback(() => {
    fetch('/api/apps/praxis-insight/tools')
      .then((r) => r.json())
      .then((d) => setTools(d.tools ?? []))
      .catch(() => setTools([]))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const check = (id: string, url: string) => {
    setReachable((r) => ({ ...r, [id]: 'checking' }))
    fetch(`/api/apps/praxis-insight/tools/check?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((d) => setReachable((r) => ({ ...r, [id]: d.reachable })))
      .catch(() => setReachable((r) => ({ ...r, [id]: false })))
  }
  useEffect(() => { tools.forEach((t) => check(t.id, t.url)) }, [tools]) // eslint-disable-line react-hooks/exhaustive-deps

  const launch = (id: string) => {
    setLaunching(id)
    setLaunchOutput(null)
    fetch(`/api/apps/praxis-insight/tools/${id}/launch`, { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        setLaunchOutput(d.ok ? '启动成功' : `启动失败: ${d.output}`)
        if (d.ok) setTimeout(() => { check(id, tools.find((t) => t.id === id)?.url ?? '') }, 3000)
      })
      .catch((e) => setLaunchOutput(String(e)))
      .finally(() => setLaunching(null))
  }

  const addTool = () => {
    if (!newName.trim() || !newUrl.trim()) return
    fetch('/api/apps/praxis-insight/tools', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName, url: newUrl }),
    })
      .then(() => { setShowAdd(false); setNewName(''); setNewUrl(''); refresh() })
      .catch(() => {})
  }
  const removeTool = (id: string) => {
    fetch(`/api/apps/praxis-insight/tools/${id}/remove`, { method: 'POST' })
      .then(() => refresh())
      .catch(() => {})
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Tool list sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-10 items-center gap-2 border-b border-border px-3">
          <span className="text-[13px] font-semibold text-text-strong">工具页</span>
          <button className="ml-auto rounded border border-border px-1.5 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={() => setShowAdd(!showAdd)}>+ 添加</button>
        </div>
        {showAdd && (
          <div className="space-y-1.5 border-b border-border p-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="名称" className="h-7 w-full rounded border border-border bg-bg px-2 text-[12px] text-text outline-none placeholder:text-muted" />
            <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="http://localhost:…" className="h-7 w-full rounded border border-border bg-bg px-2 font-mono text-[11px] text-text outline-none placeholder:text-muted" />
            <button className="h-7 w-full rounded bg-accent text-[11.5px] text-accent-fg hover:opacity-90" onClick={addTool}>嵌入</button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {tools.map((t) => (
            <div key={t.id} className={`group mb-1 rounded-md border px-2.5 py-2 ${active?.id === t.id ? 'border-accent bg-accent-subtle' : 'border-transparent hover:border-border'}`}>
              <button className="flex w-full items-center gap-2 text-left" onClick={() => { setActive(t); setIframeKey((k) => k + 1) }}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${reachable[t.id] === true ? 'bg-ok' : reachable[t.id] === 'checking' ? 'bg-warn animate-pulse' : 'bg-danger'}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-text-strong">{t.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted">{t.url}</div>
                </div>
              </button>
              <div className="mt-1 hidden gap-1 group-hover:flex">
                {t.launchCommand && reachable[t.id] === false && (
                  <button disabled={launching === t.id} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:bg-bg-hover disabled:opacity-40" onClick={() => launch(t.id)}>
                    {launching === t.id ? '启动中…' : '启动'}
                  </button>
                )}
                <button className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-bg-hover" onClick={() => check(t.id, t.url)}>检测</button>
                <button className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-danger hover:bg-bg-hover" onClick={() => removeTool(t.id)}>移除</button>
              </div>
            </div>
          ))}
          {tools.length === 0 && <p className="px-2 text-[12px] text-muted">还没有嵌入的工具。</p>}
        </div>
        {launchOutput && <div className="border-t border-border px-3 py-2 text-[11px] text-muted">{launchOutput}</div>}
      </aside>

      {/* Full-page iframe of the selected tool */}
      {active ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
            <span className="text-[13px] font-medium text-text-strong">{active.name}</span>
            <span className="font-mono text-[10.5px] text-muted">{active.url}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${reachable[active.id] ? 'bg-ok-subtle text-ok' : 'bg-danger-subtle text-danger'}`}>
              {reachable[active.id] ? '在线' : '离线'}
            </span>
            <div className="ml-auto flex gap-1.5">
              <button className="rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={() => setIframeKey((k) => k + 1)}>刷新</button>
              <button className="rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={() => window.open(active.url, '_blank')}>外部打开</button>
              <button className="rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-bg-hover" onClick={() => setActive(null)}>关闭</button>
            </div>
          </div>
          {reachable[active.id] ? (
            <iframe
              key={iframeKey}
              src={active.url}
              className="min-h-0 flex-1 border-0 bg-white"
              title={active.name}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
                <p className="text-[14px] font-medium text-text-strong">{active.name} 未运行</p>
                <p className="mt-2 text-[12.5px] text-muted">{active.description}</p>
                {active.launchCommand && (
                  <>
                    <p className="mt-3 rounded border border-border bg-bg p-2 font-mono text-[10.5px] text-muted break-all">{active.launchCommand}</p>
                    <button disabled={launching === active.id} className="mt-3 rounded-md bg-accent px-4 py-1.5 text-[12.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => launch(active.id)}>
                      {launching === active.id ? '启动中…' : '启动服务'}
                    </button>
                  </>
                )}
                <button className="mt-2 block w-full rounded-md border border-border px-4 py-1.5 text-[12px] text-muted hover:bg-bg-hover" onClick={() => check(active.id, active.url)}>重新检测</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center bg-bg">
          <div className="max-w-md text-center">
            <p className="text-[15px] font-medium text-text-strong">嵌入开发工具的完整页面</p>
            <p className="mt-2 text-[12.5px] text-muted">
              从左侧选择一个工具（如 DBX Web），它的完整 UI 将在此嵌入——不是 MCP，不是 CLI，是工具自己的界面。
              任何运行在 localhost 的 Web UI 都可以添加。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
