/** Git Studio API client — typed fetch wrappers over /api/apps/praxis-git. */
import type {
  ApiError,
  BlameLine,
  Branch,
  ConflictItem,
  ConflictVersions,
  GraphPage,
  HistoryCommit,
  NetworkEvent,
  Remote,
  RemoteBranch,
  RebaseStatus,
  RepoStatus,
  RepoSummary,
  RevDiff,
  SearchResults,
  StashItem,
  Submodule,
  Tag,
  Worktree,
  WorktreeDiff,
} from './types'

const BASE = '/api/apps/praxis-git'

export class GitStudioApiError extends Error {
  code: string
  hint?: string
  constructor(body: ApiError, status: number) {
    super(body.error || `HTTP ${status}`)
    this.code = body.code || 'error'
    this.hint = body.hint
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, init)
  const body = await resp.json().catch(() => ({ error: 'invalid JSON', code: 'bad_json' }) as ApiError)
  if (!resp.ok) throw new GitStudioApiError(body as ApiError, resp.status)
  return body as T
}

async function get<T>(path: string): Promise<T> {
  return req<T>(path)
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return req<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function del<T>(path: string): Promise<T> {
  return req<T>(path, { method: 'DELETE' })
}

const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!entries.length) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

// ── repos ────────────────────────────────────────────────────────────────────

export const api = {
  listRepos: () => get<{ repos: RepoSummary[] }>('/repos'),
  addRepo: (path: string) => post<{ id: string; alreadyRegistered?: boolean }>('/repos', { path }),
  removeRepo: (id: string) => del<{ removed: string }>(`/repos/${id}`),
  repoStatus: (id: string) => get<RepoStatus>(`/repos/${id}/status`),

  graph: (opts: {
    repo: string
    branch?: string
    firstParent?: boolean
    session?: string | null
    offset?: number
    limit?: number
    cap?: number
    refresh?: boolean
  }) =>
    get<GraphPage>(
      `/repos/${opts.repo}/graph${qs({
        branch: opts.branch || 'HEAD',
        firstParent: opts.firstParent ? '1' : undefined,
        session: opts.session || undefined,
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 400,
        cap: opts.cap,
        refresh: opts.refresh ? '1' : undefined,
      })}`,
    ),

  diffWorktree: (repo: string, opts: { path?: string; staged?: boolean; context?: number; ignoreWs?: string; wordDiff?: boolean; stat?: boolean }) =>
    get<WorktreeDiff>(
      `/repos/${repo}/diff${qs({
        path: opts.path,
        staged: opts.staged ? '1' : undefined,
        context: opts.context,
        ignoreWs: opts.ignoreWs,
        wordDiff: opts.wordDiff ? '1' : undefined,
        stat: opts.stat ? '1' : undefined,
      })}`,
    ),
  diffRev: (repo: string, rev: string, opts: { path?: string; context?: number; ignoreWs?: string; wordDiff?: boolean } = {}) =>
    get<RevDiff>(
      `/repos/${repo}/diff/rev${qs({ rev, path: opts.path, context: opts.context, ignoreWs: opts.ignoreWs, wordDiff: opts.wordDiff ? '1' : undefined })}`,
    ),

  stageFiles: (repo: string, paths: string[], unstage = false) =>
    post(`/repos/${repo}/stage`, { op: 'file', paths, unstage }),
  stageAll: (repo: string, unstage = false) => post(`/repos/${repo}/stage`, { op: 'all', unstage }),
  stageLines: (repo: string, path: string, selections: { hunk: number; keys: string[] }[], staged: boolean) =>
    post(`/repos/${repo}/stage`, { op: 'lines', path, selections, staged }),
  discard: (repo: string, paths: string[], stagedToo = false) =>
    post(`/repos/${repo}/discard`, { paths, stagedToo }),
  commit: (repo: string, message: string, opts: { amend?: boolean; signoff?: boolean } = {}) =>
    post<{ commit: string }>(`/repos/${repo}/commit`, { message, ...opts }),

  branches: (repo: string) => get<{ repo: string; local: Branch[]; remote: RemoteBranch[] }>(`/repos/${repo}/branches`),
  branchOp: (repo: string, body: Record<string, unknown>) => post(`/repos/${repo}/branches`, body),
  tags: (repo: string) => get<{ repo: string; tags: Tag[] }>(`/repos/${repo}/tags`),
  tagOp: (repo: string, body: Record<string, unknown>) => post(`/repos/${repo}/tags`, body),

  merge: (repo: string, source: string, opts: { noFF?: boolean; message?: string } = {}) =>
    post<{ merged: boolean; conflict: boolean; conflicts?: string[]; output: string }>(`/repos/${repo}/merge`, {
      source,
      ...opts,
    }),
  mergeAbort: (repo: string) => post(`/repos/${repo}/merge/abort`),
  mergeContinue: (repo: string, message = '') => post(`/repos/${repo}/merge/continue`, { message }),

  conflicts: (repo: string) => get<{ repo: string; conflicts: ConflictItem[] }>(`/repos/${repo}/conflicts`),
  conflictFile: (repo: string, path: string) =>
    get<ConflictVersions>(`/repos/${repo}/conflicts/file${qs({ path })}`),
  resolveConflict: (repo: string, path: string, body: { content?: string; side?: 'ours' | 'theirs' }) =>
    post(`/repos/${repo}/conflicts/resolve`, { path, ...body }),

  rebaseStatus: (repo: string) => get<RebaseStatus>(`/repos/${repo}/rebase`),
  rebaseOp: (repo: string, body: Record<string, unknown>) =>
    post<{ rebased: boolean; conflict: boolean; output: string; conflicts?: string[] }>(`/repos/${repo}/rebase`, body),
  rebaseTodoPreview: (repo: string, upstream: string) =>
    get<{ upstream: string; todo: string[] }>(`/repos/${repo}/rebase/todo-preview${qs({ upstream })}`),

  stashList: (repo: string) => get<{ repo: string; stashes: StashItem[] }>(`/repos/${repo}/stash`),
  stashOp: (repo: string, body: Record<string, unknown>) => post(`/repos/${repo}/stash`, body),
  stashDiff: (repo: string, index: number) => get<{ files: import('./types').DiffFile[] }>(`/repos/${repo}/stash/${index}/diff`),

  cherryPick: (repo: string, shas: string[], noCommit = false) =>
    post(`/repos/${repo}/cherry-pick`, { shas, noCommit }),
  revert: (repo: string, shas: string[], noCommit = false) => post(`/repos/${repo}/revert`, { shas, noCommit }),
  sequencer: (repo: string, op: 'continue' | 'abort', kind: 'cherry-pick' | 'revert') =>
    post(`/repos/${repo}/sequencer`, { op, kind }),
  reset: (repo: string, ref: string, mode: 'soft' | 'mixed' | 'hard') =>
    post(`/repos/${repo}/reset`, { ref, mode }),

  remotes: (repo: string) => get<{ repo: string; remotes: Remote[]; defaultRemote: string }>(`/repos/${repo}/remotes`),
  remoteOp: (repo: string, body: Record<string, unknown>) => post(`/repos/${repo}/remotes`, body),

  worktrees: (repo: string) => get<{ repo: string; worktrees: Worktree[] }>(`/repos/${repo}/worktrees`),
  worktreeOp: (repo: string, body: Record<string, unknown>) => post(`/repos/${repo}/worktrees`, body),
  submodules: (repo: string) => get<{ repo: string; submodules: Submodule[] }>(`/repos/${repo}/submodules`),

  blame: (repo: string, path: string, ref = 'HEAD') =>
    get<{ repo: string; path: string; lines: BlameLine[] }>(`/repos/${repo}/blame${qs({ path, ref })}`),
  history: (repo: string, path: string, opts: { limit?: number; follow?: boolean } = {}) =>
    get<{ repo: string; path: string; commits: HistoryCommit[] }>(
      `/repos/${repo}/history${qs({ path, limit: opts.limit, follow: opts.follow === false ? '0' : undefined })}`,
    ),
  content: (repo: string, ref: string, path: string) =>
    get<{ content: string | null; binary: boolean; tooLarge: boolean }>(`/repos/${repo}/content${qs({ ref, path })}`),
  search: (repo: string, q: string, opts: { mode?: string; limit?: number; branch?: string; path?: string } = {}) =>
    get<SearchResults>(`/repos/${repo}/search${qs({ q, mode: opts.mode, limit: opts.limit, branch: opts.branch, path: opts.path })}`),

  networkStart: (repo: string, kind: 'fetch' | 'pull' | 'push', body: Record<string, unknown> = {}) =>
    post<{ opId: string; kind: string; argv: string[] }>(`/repos/${repo}/network/${kind}`, body),
  networkCancel: (opId: string) => post(`/network/${opId}/cancel`),
}

/** Attach to a network op's SSE stream; returns a disposer. */
export function streamNetworkOp(opId: string, onEvent: (e: NetworkEvent) => void, onDone: () => void): () => void {
  const es = new EventSource(`${BASE}/network/${opId}/stream`)
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as NetworkEvent
      onEvent(data)
      if (data.type === 'done' || data.type === 'closed') {
        es.close()
        onDone()
      }
    } catch {
      // malformed frame: the stream self-heals on the next message
    }
  }
  es.onerror = () => {
    // server closed (op finished + TTL) — treat as end
    es.close()
    onDone()
  }
  return () => es.close()
}
