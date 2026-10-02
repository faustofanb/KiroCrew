/** Git Studio shared types — mirror of the backend adapter's shapes. */

export type RepoSummary = {
  id: string
  path: string
  name: string
  available: boolean
  branch: string
  upstream: string
  ahead: number | null
  behind: number | null
  detached: boolean
  counts: { staged: number; unstaged: number; untracked: number; conflicts: number }
  inProgress: string | null
  stashCount: number
  head: string
  error?: string
}

export type FileEntry = {
  path: string
  oldPath: string | null
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflict: boolean
  status: string
  label: string
}

export type RepoStatus = {
  repo: string
  path: string
  branch: string
  detached: boolean
  upstream: string
  ahead: number | null
  behind: number | null
  files: FileEntry[]
  counts: { staged: number; unstaged: number; untracked: number; conflicts: number }
  inProgress: string | null
  stashCount: number
  head: string
}

export type CommitRow = {
  sha: string
  short: string
  author: string
  email: string
  timestamp: number
  subject: string
  parents: string[]
  node: number
  edges: { a: number | null; b: number | null }[]
  branches?: string[]
  remotes?: string[]
  tags?: string[]
  head?: boolean
}

export type GraphPage = {
  session: string
  repo: string
  branch: string
  firstParent: boolean
  total: number
  truncated: boolean
  cap: number
  offset: number
  limit: number
  hasMore: boolean
  rows: CommitRow[]
}

export type DiffLine = {
  t: 'add' | 'del' | 'ctx' | 'mod' | 'note'
  old: number | null
  new: number | null
  text: string
  segs?: { t: 'eq' | 'add' | 'del'; v: string }[]
}

export type DiffHunk = {
  header: string
  note: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export type DiffFile = {
  header: string[]
  oldPath: string | null
  newPath: string | null
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  hunks: DiffHunk[]
  binary: boolean
}

export type WorktreeDiff = {
  repo: string
  path: string | null
  staged: boolean
  ignoreWs: string
  wordDiff: boolean
  files: DiffFile[]
}

export type RevDiff = {
  repo: string
  rev: string
  ignoreWs: string
  wordDiff: boolean
  files: DiffFile[]
}

export type Branch = {
  name: string
  sha: string
  current: boolean
  upstream: string
  track: string
  ahead: number | null
  behind: number | null
  timestamp: number
  subject: string
}

export type RemoteBranch = { name: string; sha: string; timestamp: number }

export type Tag = {
  name: string
  sha: string
  target: string
  annotated: boolean
  subject: string
  timestamp: number
}

export type Remote = { name: string; fetchUrl: string; pushUrl: string }

export type StashItem = { ref: string; sha: string; date: string; subject: string }

export type Worktree = { path: string; head: string; branch: string; bare: boolean; detached: boolean }

export type Submodule = { path: string; sha: string; state: string; describe: string }

export type ConflictItem = {
  path: string
  stages: number[]
  hasBase: boolean
  hasOurs: boolean
  hasTheirs: boolean
}

export type ConflictVersions = {
  repo: string
  path: string
  versions: { base: string | null; ours: string | null; theirs: string | null }
  labels: { ours: string; theirs: string }
  worktree: string | null
}

export type RebaseStatus = {
  repo: string
  inProgress: boolean
  interactive?: boolean
  onto?: string
  origHead?: string
  stoppedAt?: string
  headline?: string
  done?: string[]
  todo?: string[]
  conflicts?: string[]
}

export type BlameLine = {
  sha: string
  author?: string
  email?: string
  timestamp?: number
  summary?: string
  origPath?: string
  line: number
  text: string
  boundary?: boolean
}

export type HistoryCommit = {
  sha: string
  short: string
  author: string
  timestamp: number
  subject: string
  changes: { status: string; path: string; oldPath?: string }[]
}

export type SearchResults = { repo: string; query: string; mode: string; commits: CommitRow[]; note?: string }

export type NetworkEvent =
  | { type: 'start'; kind: string; argv: string[] }
  | { type: 'progress'; phase: string; pct: number; current: number; total: number }
  | { type: 'line'; stream: string; text: string }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; text: string }
  | { type: 'closed' }

export type ApiError = { error: string; code: string; hint?: string }
