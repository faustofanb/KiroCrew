/**
 * ConflictResolver tests — the marker parser and per-block decisions,
 * asserted against the exact content the backend will `git add`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ConflictResolver } from '../apps/praxis-git/components/ConflictResolver'
import type { ConflictItem } from '../apps/praxis-git/types'

vi.mock('../i18n/t', () => ({ i18nT: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k) }))

const apiMock = vi.hoisted(() => ({
  conflictFile: vi.fn(),
  resolveConflict: vi.fn(),
}))
vi.mock('../apps/praxis-git/api', () => ({ api: apiMock }))

const CONFLICTS: ConflictItem[] = [
  { path: 'both.txt', stages: [1, 2, 3], hasBase: true, hasOurs: true, hasTheirs: true },
]

const MARKERED = [
  'shared top',
  '<<<<<<< HEAD',
  'ours line',
  '=======',
  'theirs line',
  '>>>>>>> feature',
  'shared bottom',
].join('\n')

beforeEach(() => {
  apiMock.conflictFile.mockClear()
  apiMock.resolveConflict.mockClear()
  apiMock.conflictFile.mockResolvedValue({
    repo: 'r1',
    path: 'both.txt',
    versions: { base: 'base\n', ours: 'ours line\n', theirs: 'theirs line\n' },
    labels: { ours: 'HEAD (main)', theirs: "Merge branch 'feature'" },
    worktree: MARKERED,
  })
  apiMock.resolveConflict.mockResolvedValue({ path: 'both.txt', resolved: true })
})

describe('ConflictResolver', () => {
  afterEach(cleanup)

  it('parses the marker file into one conflict block between shared text', async () => {
    render(<ConflictResolver repo="r1" conflicts={CONFLICTS} state="ready" onResolved={() => {}} onNotice={() => {}} />)
    await waitFor(() => screen.getByTestId('conflict-block-0'))
    expect(screen.getByText('shared top')).toBeTruthy()
    expect(screen.getByText('shared bottom')).toBeTruthy()
    expect(screen.getByTestId('block-ours-0').textContent).toContain('ours line')
    expect(screen.getByTestId('block-theirs-0').textContent).toContain('theirs line')
  })

  it('mark-resolved stays disabled until every block has a decision', async () => {
    render(<ConflictResolver repo="r1" conflicts={CONFLICTS} state="ready" onResolved={() => {}} onNotice={() => {}} />)
    await waitFor(() => screen.getByTestId('resolve-merged'))
    expect(screen.getByTestId('resolve-merged').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('block-ours-0').querySelector('button')!)
    expect(screen.getByTestId('resolve-merged').hasAttribute('disabled')).toBe(false)
  })

  it('choosing ours assembles content without markers or theirs lines', async () => {
    render(<ConflictResolver repo="r1" conflicts={CONFLICTS} state="ready" onResolved={() => {}} onNotice={() => {}} />)
    await waitFor(() => screen.getByTestId('block-ours-0'))
    fireEvent.click(screen.getByTestId('block-ours-0').querySelector('button')!)
    fireEvent.click(screen.getByTestId('resolve-merged'))
    await waitFor(() => expect(apiMock.resolveConflict).toHaveBeenCalled())
    const body = apiMock.resolveConflict.mock.calls[0][2]
    expect(body.content).toBe(['shared top', 'ours line', 'shared bottom'].join('\n'))
    expect(body.content).not.toContain('<<<')
    expect(body.content).not.toContain('theirs line')
  })

  it('keep-both emits ours followed by theirs', async () => {
    render(<ConflictResolver repo="r1" conflicts={CONFLICTS} state="ready" onResolved={() => {}} onNotice={() => {}} />)
    await waitFor(() => screen.getByTestId('conflict-block-0'))
    fireEvent.click(screen.getByText('apps.gitStudio.conflict.both'))
    fireEvent.click(screen.getByTestId('resolve-merged'))
    await waitFor(() => expect(apiMock.resolveConflict).toHaveBeenCalled())
    const body = apiMock.resolveConflict.mock.calls[0][2]
    expect(body.content).toBe(['shared top', 'ours line', 'theirs line', 'shared bottom'].join('\n'))
  })

  it('take-ours posts the side shortcut without needing block decisions', async () => {
    render(<ConflictResolver repo="r1" conflicts={CONFLICTS} state="ready" onResolved={() => {}} onNotice={() => {}} />)
    await waitFor(() => screen.getByTestId('take-ours'))
    fireEvent.click(screen.getByTestId('take-ours'))
    await waitFor(() => expect(apiMock.resolveConflict).toHaveBeenCalledWith('r1', 'both.txt', { side: 'ours' }))
  })
})
