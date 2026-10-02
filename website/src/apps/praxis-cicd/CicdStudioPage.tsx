/** CI/CD Studio — pipeline visualization + delivery lifecycle. */
import { useEffect, useState } from 'react'

type Delivery = { id: string; changesetId: string; status: string; hasTestEvidence: boolean }
type ChangeSet = { id: string; title: string; status: string; repos: { repo: string; candidateId: string }[]; divergence: string | null }

export default function CicdStudioPage() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [changesets, setChangesets] = useState<ChangeSet[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    fetch('/api/apps/praxis-insight/state').then(r => r.json())
      .then(d => { setDeliveries(d.deliveries ?? []); setChangesets(d.changesets ?? []) })
      .catch(e => setError(String(e)))
  }
  useEffect(() => { load() }, [])

  const promote = (id: string, action: string) => {
    setBusy(`${id}:${action}`)
    fetch(`/api/apps/praxis-insight/deliveries/${id}/promote`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(new Error(b.error))))
      .then(() => { load(); setError(null) })
      .catch(e => setError(String(e))).finally(() => setBusy(null))
  }

  const csById = (id: string) => changesets.find(c => c.id === id)

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-10">
      <div className="flex items-baseline gap-3 pt-4 pb-5">
        <h1 className="text-xl font-semibold text-text-strong">CI/CD Studio</h1>
        <span className="text-[12px] text-muted">Delivery 生命周期 · 流水线 · 环境管理</span>
        <button className="ml-auto rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-bg-hover" onClick={load}>刷新</button>
      </div>
      {error && <div className="mb-4 rounded border border-danger bg-danger-subtle px-3 py-2 text-[12px] text-danger">{error}</div>}

      {/* Pipeline visualization */}
      <section className="mb-6">
        <h2 className="mb-3 text-[15px] font-semibold text-text-strong">流水线</h2>
        {deliveries.map(dl => {
          const cs = csById(dl.changesetId)
          const stages = [
            { id: 'ACCEPTED', label: '已接受', done: true },
            { id: 'TEST_QUALIFIED', label: 'TEST 鉴证', done: ['TEST_QUALIFIED', 'DELIVERED', 'CLOSED'].includes(dl.status) },
            { id: 'DELIVERED', label: '已交付', done: ['DELIVERED', 'CLOSED'].includes(dl.status) },
            { id: 'CLOSED', label: '已关闭', done: dl.status === 'CLOSED' },
          ]
          return (
            <div key={dl.id} className="mb-4 rounded-lg border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[14px] font-medium text-text-strong">{dl.id}</span>
                <span className="text-[12px] text-muted">← {cs?.title ?? dl.changesetId}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${dl.hasTestEvidence ? 'bg-ok-subtle text-ok' : 'bg-warn-subtle text-warn'}`}>
                  {dl.hasTestEvidence ? 'TEST 证据 ✓' : '缺 TEST 证据'}
                </span>
              </div>
              {/* Stage pipeline */}
              <div className="flex items-center gap-0">
                {stages.map((s, i) => (
                  <div key={s.id} className="flex items-center">
                    <div className={`flex h-8 min-w-24 items-center justify-center rounded border px-3 text-[11px] font-medium ${s.done ? 'border-ok bg-ok-subtle text-ok' : 'border-border bg-bg text-muted'}`}>
                      {s.label}
                    </div>
                    {i < stages.length - 1 && (
                      <div className={`h-0.5 w-8 ${s.done && stages[i+1].done ? 'bg-ok' : 'bg-border'}`} />
                    )}
                  </div>
                ))}
              </div>
              {/* Actions */}
              <div className="mt-3 flex justify-end gap-2">
                {dl.status === 'ACCEPTED' && (
                  <button disabled={busy !== null} className="rounded-md border border-border px-3 py-1 text-[12px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => promote(dl.id, 'TEST')}>
                    {busy === `${dl.id}:TEST` ? '…' : 'TEST 鉴证'}
                  </button>
                )}
                {dl.status === 'TEST_QUALIFIED' && (
                  <button disabled={busy !== null} className="rounded-md bg-accent px-3 py-1 text-[12px] text-accent-fg hover:opacity-90 disabled:opacity-40" onClick={() => promote(dl.id, 'PROD')}>
                    {busy === `${dl.id}:PROD` ? '…' : '交付 PROD'}
                  </button>
                )}
                {dl.status === 'DELIVERED' && (
                  <button disabled={busy !== null} className="rounded-md border border-border px-3 py-1 text-[12px] text-muted hover:bg-bg-hover disabled:opacity-40" onClick={() => promote(dl.id, 'CLOSE')}>关闭</button>
                )}
              </div>
              {cs?.divergence && (
                <div className="mt-3 rounded border border-dashed border-danger bg-danger-subtle px-3 py-2 text-[12px] text-danger">
                  ⚠ 跨仓分歧未裁决：{cs.divergence}
                </div>
              )}
            </div>
          )
        })}
        {deliveries.length === 0 && <p className="text-[13px] text-muted">暂无交付。</p>}
      </section>
    </div>
  )
}
