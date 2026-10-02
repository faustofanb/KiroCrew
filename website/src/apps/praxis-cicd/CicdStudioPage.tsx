/**
 * CI/CD Studio — Praxis Delivery lifecycle visualization (domain semantics,
 * not a generic CI tool).
 *
 * Rails encoded in the UI itself: UNKNOWN never renders as a failure color
 * (it carries its own neutral token and a "≠ FAILED" note); the delivery
 * stage flow shows E13 hard gates with pending/blocked states; every stage
 * links its 6-level Evidence provenance; simulated data is STAMPED as such
 * on every panel. The stage timeline is drawn with d3 scales; the ChangeSet
 * topology renders through mermaid.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import mermaid from 'mermaid'
import { AlertTriangle, BadgeCheck, GitBranch, HelpCircle, Rocket, ShieldAlert, Workflow } from 'lucide-react'
import { i18nT } from '../../i18n/t'

const BASE = '/api/apps/praxis-cicd'

type Stage = { stage: string; reached: boolean; current: boolean; gate: { id: string | null; state: string; requires: string } }
type Timeline = {
  source: string
  delivery: { id: string; changesetId: string; status: string; hasTestEvidence: boolean }
  changeset: { id: string; title: string; status: string; divergence: string | null } | null
  stages: Stage[]
  qualificationPending: boolean
  qualificationNote: string
  evidenceChain: { id?: string; level?: string; summary?: string }[]
}
type Pipeline = {
  source: string
  statusWords: string[]
  evidenceLevels: string[]
  deliveryStages: string[]
  works: { id: string; title: string; status: string }[]
  runs: { id: string; label: string; status: string; epochs?: string[] }[]
  changesets: { id: string; title: string; status: string; repos: { repo: string }[]; divergence: string | null }[]
  deliveries: { id: string; changesetId: string; status: string; hasTestEvidence: boolean }[]
  unknowns: { operationId: string; lastFact: string; reconciliation: string; safeCommand: string }[]
  hardGates: { id: string; statement: string }[]
}
type AdapterView = {
  source: string
  seam: { operation: string; contract: string; failureMode: string }[]
  e11b5: { chapter: string; statement: string }
  timeline: { runId: string; status: string; note: string; lastFact: string; reconciliation: string; safeCommand: string }[]
}
type CsView = {
  source: string
  changeset: { id: string; title: string; status: string; repos: { repo: string }[]; worktrees?: string[]; divergence: string | null }
  delivery: { id: string; status: string } | null
  divergenceWarning: string | null
  topology: { nodes: { id: string; kind: string; label: string }[]; edges: { from: string; to: string; kind: string }[] }
}

async function j<T>(resp: Response): Promise<T> {
  const body = await resp.json().catch(() => ({}) as T)
  if (!resp.ok) {
    const e = body as { error?: string }
    throw new Error(e.error || `HTTP ${resp.status}`)
  }
  return body as T
}

/** The domain rule, expressed in the only place it can't drift: the renderer. */
function statusTone(s: string): string {
  if (s === 'UNKNOWN') return 'border-border bg-bg-hover text-muted'
  if (s === 'ACCEPTED' || s === 'DELIVERED') return 'border-ok bg-ok-subtle text-ok'
  if (s === 'TEST_QUALIFIED') return 'border-accent bg-accent-subtle text-accent'
  if (s === 'FAILED') return 'border-danger bg-danger-subtle text-danger'
  if (s === 'BLOCKED' || s === 'RECOVERY_REQUIRED') return 'border-warn bg-warn-subtle text-warn'
  return 'border-border bg-bg-hover text-text'
}

function SimStamp() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-warn bg-warn-subtle px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-warn" data-testid="sim-stamp">
      <HelpCircle size={9} />
      {i18nT('apps.cicd.simulated')}
    </span>
  )
}

function EvidenceLevel(props: { level?: string }) {
  const tone =
    props.level === 'verification_result'
      ? 'text-ok'
      : props.level === 'product_fact'
        ? 'text-accent'
        : props.level === 'unknown'
          ? 'text-muted'
          : 'text-info'
  return <span className={`font-mono text-[9px] ${tone}`}>{props.level}</span>
}

/** Horizontal stage flow with d3 band scale + gates. */
function StageFlow(props: { timeline: Timeline }) {
  const ref = useRef<SVGSVGElement | null>(null)
  const { stages, delivery } = props.timeline
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const width = el.clientWidth || 640
    const height = 86
    d3.select(el).selectAll('*').remove()
    const svg = d3.select(el).attr('viewBox', `0 0 ${width} ${height}`)
    const x = d3.scaleBand().domain(stages.map((s) => s.stage)).range([24, width - 24]).padding(0.35)
    const g = svg.append('g')
    // connectors
    const centers = stages.map((s) => (x(s.stage)! + x.bandwidth() / 2))
    for (let i = 0; i < centers.length - 1; i++) {
      const on = stages[i + 1].reached
      g.append('line')
        .attr('x1', centers[i])
        .attr('x2', centers[i + 1])
        .attr('y1', 34)
        .attr('y2', 34)
        .attr('stroke', on ? 'var(--color-accent)' : 'var(--color-border)')
        .attr('stroke-width', on ? 2 : 1)
        .attr('stroke-dasharray', on ? null : '4 3')
    }
    stages.forEach((s, i) => {
      const cx = centers[i]
      const fill = s.reached ? (s.current ? 'var(--color-accent)' : 'var(--color-ok)') : 'var(--color-bg-hover)'
      g.append('circle').attr('cx', cx).attr('cy', 34).attr('r', s.current ? 8 : 6).attr('fill', fill)
      if (s.current) g.append('circle').attr('cx', cx).attr('cy', 34).attr('r', 12).attr('fill', 'none').attr('stroke', 'var(--color-accent)').attr('stroke-width', 1)
      g.append('text').attr('x', cx).attr('y', 16).attr('text-anchor', 'middle').attr('class', 'fill-current text-[9px] font-semibold').attr('fill', s.reached ? 'var(--color-text-strong)' : 'var(--color-muted)').text(s.stage)
      const gate = s.gate
      if (gate?.id) {
        const gateColor = gate.state === 'satisfied' ? 'var(--color-ok)' : gate.state === 'blocked' ? 'var(--color-danger)' : 'var(--color-warn)'
        g.append('text').attr('x', cx).attr('y', 58).attr('text-anchor', 'middle').attr('class', 'fill-current text-[8px] font-mono').attr('fill', gateColor).text(`${gate.id} ${gate.state}`)
      }
    })
  }, [stages])
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <Rocket size={12} className="text-accent" />
        <span className="font-mono text-[12px] text-text-strong">{delivery.id}</span>
        <span className="text-[10px] text-muted">→ {props.timeline.changeset?.title ?? delivery.changesetId}</span>
        {!delivery.hasTestEvidence && <span className="rounded border border-warn px-1.5 text-[9px] text-warn">{i18nT('apps.cicd.noTestEvidence')}</span>}
      </div>
      <svg ref={ref} className="w-full" style={{ height: 86 }} data-testid="stage-flow" />
    </div>
  )
}

/** mermaid topology for a ChangeSet. */
function Topology(props: { view: CsView }) {
  const idRef = useRef(`m${Math.random().toString(36).slice(2, 8)}`)
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    const { nodes, edges } = props.view.topology
    const lines = [['graph', 'LR'].join(' ')]
    for (const n of nodes) {
      const shape = n.kind === 'changeset' ? `("${n.label}")` : n.kind === 'repo' ? `[${n.label}]` : `(${n.label})`
      lines.push(`  ${n.id.replace(/[^A-Za-z0-9]/g, '_')}${shape}`)
    }
    for (const e of edges) {
      const f = e.from.replace(/[^A-Za-z0-9]/g, '_')
      const t = e.to.replace(/[^A-Za-z0-9]/g, '_')
      lines.push(e.kind === 'worktree-of' ? `  ${f} -.-> ${t}` : `  ${t} --> ${f}`)
    }
    mermaid.initialize({ startOnLoad: false, theme: 'dark' })
    mermaid
      .render(idRef.current, lines.join('\n'))
      .then(({ svg: out }) => setSvg(out))
      .catch(() => setSvg(null))
  }, [props.view])
  if (!svg) return <div className="p-4 text-[11px] text-muted">{i18nT('apps.cicd.topologyUnavailable')}</div>
  return <div className="overflow-x-auto" data-testid="cs-topology" dangerouslySetInnerHTML={{ __html: svg }} />
}

type Tab = 'lifecycle' | 'changesets' | 'adapter' | 'vocab'

export default function CicdStudioPage() {
  const [tab, setTab] = useState<Tab>('lifecycle')
  const [pipe, setPipe] = useState<Pipeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deliveryId, setDeliveryId] = useState('')
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [csId, setCsId] = useState('')
  const [csView, setCsView] = useState<CsView | null>(null)
  const [adapter, setAdapter] = useState<AdapterView | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(`${BASE}/pipeline`)
      .then((r) => j<Pipeline>(r))
      .then((d) => {
        setPipe(d)
        setDeliveryId((c) => c || d.deliveries[0]?.id || '')
        setCsId((c) => c || d.changesets[0]?.id || '')
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    if (deliveryId) {
      setTimeline(null)
      fetch(`${BASE}/deliveries/${deliveryId}/timeline`)
        .then((r) => j<Timeline>(r))
        .then(setTimeline)
        .catch((e) => setError(String(e)))
    }
  }, [deliveryId])

  useEffect(() => {
    if (csId) {
      setCsView(null)
      fetch(`${BASE}/changesets/${csId}`)
        .then((r) => j<CsView>(r))
        .then(setCsView)
        .catch((e) => setError(String(e)))
    }
  }, [csId])

  useEffect(() => {
    if (tab === 'adapter' && !adapter) {
      fetch(`${BASE}/adapter`)
        .then((r) => j<AdapterView>(r))
        .then(setAdapter)
        .catch((e) => setError(String(e)))
    }
  }, [tab, adapter])

  const promote = async (action: string) => {
    if (!deliveryId) return
    setBusy(true)
    try {
      await j(await fetch(`${BASE}/deliveries/${deliveryId}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }))
      const t = await j<Timeline>(await fetch(`${BASE}/deliveries/${deliveryId}/timeline`))
      setTimeline(t)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const unknownCount = useMemo(() => pipe?.works.filter((w) => w.status === 'UNKNOWN').length ?? 0, [pipe])

  if (error && !pipe) return <div className="m-4 rounded border border-danger bg-danger-subtle p-3 text-[12px] text-danger">{error}</div>
  if (!pipe) return <div className="p-6 text-center text-[12px] text-muted">{i18nT('apps.cicd.loading')}</div>

  const tabs: { id: Tab; label: string }[] = [
    { id: 'lifecycle', label: i18nT('apps.cicd.tab.lifecycle') },
    { id: 'changesets', label: i18nT('apps.cicd.tab.changesets') },
    { id: 'adapter', label: i18nT('apps.cicd.tab.adapter') },
    { id: 'vocab', label: i18nT('apps.cicd.tab.vocab') },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-card px-3">
        <Workflow size={13} className="text-accent" />
        <span className="mr-2 text-[14px] font-semibold text-text-strong">{i18nT('apps.cicd.title')}</span>
        {tabs.map((t) => (
          <button key={t.id} className={`rounded px-2.5 py-1 text-[11.5px] ${tab === t.id ? 'bg-accent-subtle font-semibold text-accent' : 'text-muted hover:bg-bg-hover'}`} onClick={() => setTab(t.id)} data-testid={`cicd-tab-${t.id}`}>
            {t.label}
          </button>
        ))}
        <SimStamp />
        {unknownCount > 0 && (
          <span className="rounded border border-border bg-bg-hover px-1.5 text-[9.5px] text-muted" title={i18nT('apps.cicd.unknownNote')}>
            {i18nT('apps.cicd.unknownCount', { n: String(unknownCount) })}
          </span>
        )}
        {error && <span className="truncate text-[10px] text-danger">{error}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'lifecycle' && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {pipe.deliveries.map((d) => (
                <button
                  key={d.id}
                  className={`rounded border px-2 py-1 font-mono text-[11px] ${deliveryId === d.id ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-text hover:bg-bg-hover'}`}
                  onClick={() => setDeliveryId(d.id)}
                  data-testid={`cicd-delivery-${d.id}`}
                >
                  {d.id} · {d.status}
                  {!d.hasTestEvidence && <span className="ml-1 text-warn">⏳</span>}
                </button>
              ))}
            </div>
            {timeline ? (
              <div className="rounded border border-border bg-card p-3">
                <StageFlow timeline={timeline} />
                {timeline.qualificationPending && (
                  <div className="mt-2 flex items-start gap-2 rounded border border-warn bg-warn-subtle px-3 py-2 text-[11px] text-warn" data-testid="qualification-pending">
                    <ShieldAlert size={13} className="mt-0.5 shrink-0" />
                    {timeline.qualificationNote}
                  </div>
                )}
                <div className="mt-2 flex gap-1.5">
                  <button className="rounded border border-accent px-2 py-1 text-[10.5px] text-accent hover:bg-accent-subtle disabled:opacity-40" disabled={busy} onClick={() => void promote('TEST')} data-testid="promote-test">
                    {i18nT('apps.cicd.promoteTest')}
                  </button>
                  <button className="rounded border border-danger px-2 py-1 text-[10.5px] text-danger hover:bg-danger-subtle disabled:opacity-40" disabled={busy} onClick={() => void promote('PROD')} data-testid="promote-prod">
                    {i18nT('apps.cicd.promoteProd')}
                  </button>
                  <button className="rounded border border-border px-2 py-1 text-[10.5px] text-muted hover:bg-bg-hover disabled:opacity-40" disabled={busy} onClick={() => void promote('CLOSE')}>
                    {i18nT('apps.cicd.close')}
                  </button>
                </div>
                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-semibold text-text-strong">{i18nT('apps.cicd.evidenceChain')}</div>
                  <div className="flex flex-col gap-0.5">
                    {timeline.evidenceChain.map((e, i) => (
                      <div key={i} className="flex items-center gap-2 rounded px-2 py-1 text-[10.5px] hover:bg-bg-hover" data-testid={`evidence-${i}`}>
                        <EvidenceLevel level={e.level} />
                        <span className="min-w-0 flex-1 truncate text-text" title={e.summary}>
                          {e.summary}
                        </span>
                        <BadgeCheck size={11} className="shrink-0 text-muted/50" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 text-center text-[12px] text-muted">{i18nT('apps.cicd.loading')}</div>
            )}
            {/* hard gates */}
            <div className="rounded border border-border bg-card p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-text-strong">
                <ShieldAlert size={12} className="text-warn" />
                {i18nT('apps.cicd.hardGates')}
              </div>
              {pipe.hardGates.map((g) => (
                <div key={g.id} className="mb-1 flex items-start gap-2 text-[10.5px]">
                  <span className="shrink-0 font-mono text-warn">{g.id}</span>
                  <span className="text-muted">{g.statement}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'changesets' && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {pipe.changesets.map((c) => (
                <button
                  key={c.id}
                  className={`rounded border px-2 py-1 font-mono text-[11px] ${csId === c.id ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-text hover:bg-bg-hover'}`}
                  onClick={() => setCsId(c.id)}
                >
                  {c.id} · {c.status}
                </button>
              ))}
            </div>
            {csView ? (
              <div className="rounded border border-border bg-card p-3">
                <div className="mb-2 flex items-center gap-2">
                  <GitBranch size={12} className="text-accent" />
                  <span className="text-[12px] font-semibold text-text-strong">{csView.changeset.title}</span>
                  <span className={`rounded border px-1.5 text-[9.5px] ${statusTone(csView.changeset.status === 'DIVERGED' ? 'BLOCKED' : 'ACCEPTED')}`}>{csView.changeset.status}</span>
                  {csView.delivery && <span className="font-mono text-[9.5px] text-muted">→ {csView.delivery.id}</span>}
                </div>
                {csView.divergenceWarning && (
                  <div className="mb-2 flex items-start gap-2 rounded border border-warn bg-warn-subtle px-3 py-1.5 text-[10.5px] text-warn">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    {i18nT('apps.cicd.divergence')} — {csView.divergenceWarning}
                  </div>
                )}
                <Topology view={csView} />
                <div className="mt-2 text-[9.5px] text-muted/70">{i18nT('apps.cicd.atomicNote')}</div>
              </div>
            ) : (
              <div className="p-4 text-center text-[12px] text-muted">{i18nT('apps.cicd.loading')}</div>
            )}
          </div>
        )}

        {tab === 'adapter' && (
          <div className="flex flex-col gap-3">
            <div className="rounded border border-border bg-card p-3">
              <div className="mb-1 text-[11.5px] font-semibold text-text-strong">{adapter?.e11b5.chapter} — {i18nT('apps.cicd.adapterSeam')}</div>
              <p className="mb-2 text-[10.5px] text-muted">{adapter?.e11b5.statement}</p>
              <div className="grid grid-cols-3 gap-2">
                {(adapter?.seam ?? []).map((s) => (
                  <div key={s.operation} className="rounded border border-border p-2" data-testid={`seam-${s.operation}`}>
                    <div className="mb-1 font-mono text-[11px] font-semibold text-accent">{s.operation}</div>
                    <div className="mb-1 text-[10px] text-text">{s.contract}</div>
                    <div className="text-[9.5px] text-warn">{s.failureMode}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded border border-border bg-card p-3">
              <div className="mb-1.5 text-[11.5px] font-semibold text-text-strong">{i18nT('apps.cicd.restartTimeline')}</div>
              {(adapter?.timeline ?? []).map((t) => (
                <div key={t.runId} className="mb-1.5 rounded border border-border/60 p-2" data-testid={`adapter-tl-${t.runId}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10.5px] text-text-strong">{t.runId}</span>
                    <span className={`rounded border px-1.5 text-[9px] ${statusTone(t.status)}`}>{t.status}</span>
                    <span className="text-[9.5px] text-muted">{t.note}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-muted">{t.lastFact}</div>
                  <div className="text-[10px] text-info">{t.reconciliation}</div>
                  <div className="font-mono text-[9.5px] text-muted/70">{t.safeCommand}</div>
                </div>
              ))}
              {adapter && adapter.timeline.length === 0 && <div className="text-[11px] text-muted">{i18nT('apps.cicd.noFailures')}</div>}
            </div>
          </div>
        )}

        {tab === 'vocab' && (
          <div className="flex flex-col gap-3">
            <div className="rounded border border-border bg-card p-3">
              <div className="mb-2 text-[11.5px] font-semibold text-text-strong">{i18nT('apps.cicd.vocab.title')} ({pipe.statusWords.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {pipe.statusWords.map((w) => (
                  <span key={w} className={`rounded border px-2 py-0.5 font-mono text-[10px] ${statusTone(w)}`} data-testid={`vocab-${w}`}>
                    {w}
                    {w === 'UNKNOWN' && <span className="ml-1 font-sans text-[8.5px]">{i18nT('apps.cicd.notFailed')}</span>}
                  </span>
                ))}
              </div>
              <div className="mt-2 text-[10px] text-muted">{i18nT('apps.cicd.unknownNote')}</div>
            </div>
            <div className="rounded border border-border bg-card p-3">
              <div className="mb-2 text-[11.5px] font-semibold text-text-strong">{i18nT('apps.cicd.vocab.evidence')} ({pipe.evidenceLevels.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {pipe.evidenceLevels.map((l) => (
                  <span key={l} className="rounded border border-border px-2 py-0.5 text-[10px]">
                    <EvidenceLevel level={l} />
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded border border-border bg-card p-3">
              <div className="mb-1.5 text-[11.5px] font-semibold text-text-strong">{i18nT('apps.cicd.vocab.works')}</div>
              {pipe.works.map((w) => (
                <div key={w.id} className="mb-1 flex items-center gap-2">
                  <span className={`rounded border px-1.5 text-[9.5px] ${statusTone(w.status)}`}>{w.status}</span>
                  <span className="font-mono text-[10px] text-muted">{w.id}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text">{w.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
