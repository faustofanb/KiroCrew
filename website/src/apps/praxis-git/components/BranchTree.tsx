/**
 * BranchTree — local / remote / tag tree with inline operations.
 *
 * Local rows: checkout, merge into current, delete (guarded, force is an
 * explicit second click), rename, upstream binding. Remote rows group by
 * remote name. Tags: create (lightweight / annotated) and delete. The remotes
 * section manages fetch/push URLs and prune.
 */
import { useMemo, useState } from 'react'
import { GitBranch, Globe, Loader2, Tag as TagIcon } from 'lucide-react'
import { api } from '../api'
import { i18nT } from '../../../i18n/t'
import type { Branch, Remote, RemoteBranch, Tag } from '../types'
import { ConfirmDialog, InlineInput, LoadState, TriState } from './common'

function TrackBadge(props: { b: Branch }) {
  const { b } = props
  if (!b.upstream) return <span className="shrink-0 text-[9px] text-muted/70">{i18nT('apps.gitStudio.branch.noUpstream')}</span>
  if (b.track === 'gone') return <span className="shrink-0 rounded bg-danger-subtle px-1 text-[9px] text-danger">{i18nT('apps.gitStudio.branch.gone')}</span>
  const ahead = b.ahead ?? 0
  const behind = b.behind ?? 0
  if (!ahead && !behind) return <span className="shrink-0 font-mono text-[9px] text-muted">=</span>
  return (
    <span className="shrink-0 font-mono text-[9px]">
      {ahead > 0 && <span className="text-ok">↑{ahead}</span>}
      {behind > 0 && <span className="text-warn">↓{behind}</span>}
    </span>
  )
}

export function BranchTree(props: {
  repo: string
  branches: { local: Branch[]; remote: RemoteBranch[] } | null
  tags: Tag[] | null
  remotes: { remotes: Remote[]; defaultRemote: string } | null
  state: LoadState
  error?: string | null
  onRefresh: () => void
  onNotice: (kind: 'ok' | 'error' | 'info', text: string) => void
}) {
  const [tab, setTab] = useState<'branches' | 'tags' | 'remotes'>('branches')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null)

  const run = async (key: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(key)
    try {
      await fn()
      props.onNotice('ok', okText ?? i18nT('apps.gitStudio.common.done'))
      props.onRefresh()
    } catch (e) {
      props.onNotice('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const remoteGroups = useMemo(() => {
    const groups = new Map<string, RemoteBranch[]>()
    for (const rb of props.branches?.remote ?? []) {
      const idx = rb.name.indexOf('/')
      const remote = idx > 0 ? rb.name.slice(0, idx) : rb.name
      if (!groups.has(remote)) groups.set(remote, [])
      groups.get(remote)!.push(rb)
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [props.branches?.remote])

  const guardDelete = (name: string, force: boolean) => {
    setConfirm({
      title: force ? i18nT('apps.gitStudio.branch.forceDeleteTitle', { name }) : i18nT('apps.gitStudio.branch.deleteTitle', { name }),
      body: force ? i18nT('apps.gitStudio.branch.forceDeleteBody', { name }) : i18nT('apps.gitStudio.branch.deleteBody', { name }),
      run: async () => {
        await api.branchOp(props.repo, { op: 'delete', name, force })
      },
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="branch-tree">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
        <GitBranch size={13} className="ml-1 text-accent" />
        {(['branches', 'tags', 'remotes'] as const).map((t) => (
          <button
            key={t}
            className={`rounded px-2 py-0.5 text-[11px] ${tab === t ? 'bg-accent-subtle font-semibold text-accent' : 'text-muted hover:bg-bg-hover'}`}
            onClick={() => setTab(t)}
          >
            {i18nT(`apps.gitStudio.branch.tab_${t}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <TriState state={props.state} error={props.error} empty={tab === 'branches' && !(props.branches?.local.length)}>
          {tab === 'branches' && (
            <>
              <div className="mb-1 flex items-center gap-1 px-1">
                <InlineInput
                  placeholder={i18nT('apps.gitStudio.branch.newPlaceholder')}
                  testId="new-branch-input"
                  onSubmit={(name) => run(`create:${name}`, () => api.branchOp(props.repo, { op: 'create', name, checkout: false }))}
                />
              </div>
              {(props.branches?.local ?? []).map((b) => (
                <div key={b.name} className={`group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-bg-hover ${b.current ? 'bg-accent-subtle' : ''}`} data-testid={`branch-${b.name}`}>
                  {busy === b.name ? (
                    <Loader2 size={10} className="shrink-0 animate-spin text-muted" />
                  ) : (
                    <GitBranch size={10} className={`shrink-0 ${b.current ? 'text-accent' : 'text-muted'}`} />
                  )}
                  <button
                    className="min-w-0 flex-1 truncate text-left font-mono text-[10.5px] text-text"
                    title={[b.name, b.subject, b.sha, b.upstream ? '→ '.concat(b.upstream) : ''].filter(Boolean).join('\n')}
                    onClick={() => !b.current && run(b.name, () => api.branchOp(props.repo, { op: 'checkout', ref: b.name }))}
                  >
                    {b.name}
                  </button>
                  <TrackBadge b={b} />
                  <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    {!b.current && (
                      <button
                        className="rounded border border-border px-1 py-px text-[8.5px] text-accent"
                        title={i18nT('apps.gitStudio.branch.mergeInto', { current: props.branches?.local.find((x) => x.current)?.name ?? 'HEAD' })}
                        onClick={() => run(`merge:${b.name}`, () => api.merge(props.repo, b.name))}
                      >
                        ⇄
                      </button>
                    )}
                    {!b.current && (
                      <button
                        className="rounded border border-border px-1 py-px text-[8.5px] text-muted"
                        title={i18nT('apps.gitStudio.branch.rebaseOnto', { name: b.name })}
                        onClick={() => run(`rebase:${b.name}`, () => api.rebaseOp(props.repo, { op: 'start', upstream: b.name }))}
                      >
                        ⟳
                      </button>
                    )}
                    {!b.current && (
                      <button className="rounded border border-danger px-1 py-px text-[8.5px] text-danger" title={i18nT('apps.gitStudio.branch.delete')} onClick={() => guardDelete(b.name, false)}>
                        ×
                      </button>
                    )}
                    {!b.current && (
                      <button className="rounded border border-danger px-1 py-px text-[8.5px] text-danger" title={i18nT('apps.gitStudio.branch.forceDelete')} onClick={() => guardDelete(b.name, true)}>
                        !×
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {remoteGroups.map(([remote, items]) => (
                <div key={remote} className="mt-2">
                  <div className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                    <Globe size={10} />
                    {remote}
                  </div>
                  {items.slice(0, 200).map((rb) => (
                    <div key={rb.name} className="flex items-center gap-1 rounded px-3 py-0.5 hover:bg-bg-hover">
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{rb.name.slice(remote.length + 1)}</span>
                      <span className="shrink-0 font-mono text-[9px] text-muted/60">{rb.sha.slice(0, 7)}</span>
                    </div>
                  ))}
                  {items.length > 200 && <div className="px-3 py-0.5 text-[9.5px] text-muted">+{items.length - 200}</div>}
                </div>
              ))}
            </>
          )}
          {tab === 'tags' && (
            <>
              <div className="mb-1 flex items-center gap-1 px-1">
                <InlineInput
                  placeholder={i18nT('apps.gitStudio.tag.newPlaceholder')}
                  testId="new-tag-input"
                  onSubmit={(name) => run(`tag:${name}`, () => api.tagOp(props.repo, { op: 'create', name }))}
                />
              </div>
              <TriState state={props.state} empty={!(props.tags ?? []).length} emptyText={i18nT('apps.gitStudio.tag.empty')}>
                {(props.tags ?? []).map((t) => (
                  <div key={t.name} className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-bg-hover" data-testid={`tag-${t.name}`}>
                    <TagIcon size={10} className="shrink-0 text-warn" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text" title={t.annotated ? t.subject : t.name}>
                      {t.name}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] text-muted/60">{t.target.slice(0, 7)}</span>
                    <button
                      className="hidden shrink-0 rounded border border-danger px-1 py-px text-[8.5px] text-danger group-hover:flex"
                      onClick={() =>
                        setConfirm({
                          title: i18nT('apps.gitStudio.tag.deleteTitle', { name: t.name }),
                          body: i18nT('apps.gitStudio.tag.deleteBody', { name: t.name }),
                          run: async () => {
                            await api.tagOp(props.repo, { op: 'delete', name: t.name })
                          },
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </TriState>
            </>
          )}
          {tab === 'remotes' && (
            <TriState state={props.state} error={props.error} empty={!(props.remotes?.remotes.length)} emptyText={i18nT('apps.gitStudio.remote.empty')}>
              <div className="mb-2 rounded border border-border p-2">
                <RemoteAddRow repo={props.repo} onRefresh={props.onRefresh} onNotice={props.onNotice} />
              </div>
              {(props.remotes?.remotes ?? []).map((r) => (
                <div key={r.name} className="group rounded px-1.5 py-1.5 hover:bg-bg-hover" data-testid={`remote-${r.name}`}>
                  <div className="flex items-center gap-1.5">
                    <Globe size={10} className="shrink-0 text-muted" />
                    <span className="font-mono text-[11px] font-semibold text-text">{r.name}</span>
                    <div className="ml-auto hidden gap-1 group-hover:flex">
                      <button
                        className="rounded border border-border px-1.5 py-px text-[9px] text-text hover:bg-card"
                        onClick={() => run(`prune:${r.name}`, () => api.remoteOp(props.repo, { op: 'prune', name: r.name }))}
                      >
                        {i18nT('apps.gitStudio.remote.prune')}
                      </button>
                      <button
                        className="rounded border border-danger px-1.5 py-px text-[9px] text-danger"
                        onClick={() =>
                          setConfirm({
                            title: i18nT('apps.gitStudio.remote.deleteTitle', { name: r.name }),
                            body: i18nT('apps.gitStudio.remote.deleteBody', { name: r.name }),
                            run: async () => {
                              await api.remoteOp(props.repo, { op: 'remove', name: r.name })
                            },
                          })
                        }
                      >
                        {i18nT('apps.gitStudio.remote.delete')}
                      </button>
                    </div>
                  </div>
                  <div className="mt-0.5 truncate pl-4 font-mono text-[9.5px] text-muted" title={r.fetchUrl}>
                    {r.fetchUrl}
                  </div>
                </div>
              ))}
            </TriState>
          )}
        </TriState>
      </div>
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const c = confirm
          setConfirm(null)
          if (c) await run('confirm', c.run)
        }}
      />
    </div>
  )
}

function RemoteAddRow(props: { repo: string; onRefresh: () => void; onNotice: (kind: 'ok' | 'error' | 'info', text: string) => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    if (!name.trim() || !url.trim()) return
    setBusy(true)
    try {
      await api.remoteOp(props.repo, { op: 'add', name: name.trim(), url: url.trim() })
      props.onNotice('ok', i18nT('apps.gitStudio.remote.added', { name: name.trim() }))
      setName('')
      setUrl('')
      props.onRefresh()
    } catch (e) {
      props.onNotice('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex gap-1">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={i18nT('apps.gitStudio.remote.name')} className="h-7 w-24 rounded border border-border bg-bg px-2 font-mono text-[10.5px] text-text outline-none focus:border-accent" data-testid="remote-add-name" />
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={i18nT('apps.gitStudio.remote.url')} className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 font-mono text-[10.5px] text-text outline-none focus:border-accent" data-testid="remote-add-url" />
      <button className="shrink-0 rounded bg-accent px-2 text-[10.5px] text-accent-fg hover:opacity-90 disabled:opacity-40" disabled={busy || !name.trim() || !url.trim()} onClick={add} data-testid="remote-add-go">
        {busy ? <Loader2 size={11} className="animate-spin" /> : i18nT('apps.gitStudio.remote.add')}
      </button>
    </div>
  )
}
