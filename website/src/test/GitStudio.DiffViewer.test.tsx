/**
 * DiffViewer line-staging tests — the Fork headline feature checked at the
 * contract the backend consumes: selection keys are `t:old:new`, hunk staging
 * submits every +/- line of the hunk, and both layouts render the same lines.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { DiffViewer } from '../apps/praxis-git/components/DiffViewer'
import type { DiffFile } from '../apps/praxis-git/types'

vi.mock('../i18n/t', () => ({ i18nT: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k) }))

const FILE: DiffFile = {
  header: ['diff --git a/a.txt b/a.txt'],
  oldPath: 'a.txt',
  newPath: 'a.txt',
  status: 'modified',
  binary: false,
  hunks: [
    {
      header: '@@ -1,2 +1,4 @@',
      note: '',
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 4,
      lines: [
        { t: 'ctx', old: 1, new: 1, text: 'one' },
        { t: 'ctx', old: 2, new: 2, text: 'two' },
        { t: 'add', old: null, new: 3, text: 'three' },
        { t: 'add', old: null, new: 4, text: 'four' },
      ],
    },
  ],
}

describe('DiffViewer staging', () => {
  afterEach(cleanup)

  it('ticking one add line enables a selection staged with exactly that line key', () => {
    const onStageSelection = vi.fn()
    render(<DiffViewer files={[FILE]} staging="worktree" sbs={false} onStageSelection={onStageSelection} />)
    fireEvent.click(screen.getByTestId('line-check-add:null:3'))
    fireEvent.click(screen.getByTestId('stage-selection-0'))
    expect(onStageSelection).toHaveBeenCalledWith('a.txt', [{ hunk: 0, keys: ['add:null:3'] }])
  })

  it('context lines have no checkbox; only +/- lines are selectable', () => {
    render(<DiffViewer files={[FILE]} staging="worktree" sbs={false} onStageSelection={vi.fn()} />)
    expect(screen.queryByTestId('line-check-ctx:1:1')).toBeNull()
    expect(screen.getByTestId('line-check-add:null:4')).toBeTruthy()
  })

  it('hunk staging submits every change line of the hunk', () => {
    const onStageSelection = vi.fn()
    render(<DiffViewer files={[FILE]} staging="worktree" sbs={false} onStageSelection={onStageSelection} />)
    fireEvent.click(screen.getByTestId('hunk-stage-0-0'))
    expect(onStageSelection).toHaveBeenCalledWith('a.txt', [
      { hunk: 0, keys: ['add:null:3', 'add:null:4'] },
    ])
  })

  it('staged mode flips labels to unstage semantics', () => {
    const onStageSelection = vi.fn()
    render(<DiffViewer files={[FILE]} staging="staged" sbs={false} onStageSelection={onStageSelection} />)
    fireEvent.click(screen.getByTestId('line-check-add:null:3'))
    const btn = screen.getByTestId('stage-selection-0')
    expect(btn.textContent).toContain('unstageSelection')
    fireEvent.click(btn)
    expect(onStageSelection).toHaveBeenCalled()
  })

  it('side-by-side renders both sides of a modification', () => {
    const file: DiffFile = {
      ...FILE,
      hunks: [
        {
          ...FILE.hunks[0],
          lines: [
            { t: 'del', old: 1, new: null, text: 'old line' },
            { t: 'add', old: null, new: 1, text: 'new line' },
          ],
        },
      ],
    }
    render(<DiffViewer files={[file]} staging="none" sbs onStageSelection={undefined} />)
    expect(screen.getByText('old line')).toBeTruthy()
    expect(screen.getByText('new line')).toBeTruthy()
  })

  it('binary files render a notice instead of hunks', () => {
    render(<DiffViewer files={[{ ...FILE, binary: true, hunks: [] }]} staging="none" sbs={false} />)
    expect(screen.getByText('apps.gitStudio.diff.binary')).toBeTruthy()
  })
})
