/**
 * RebasePanel todo-editor tests — preview load, command rewrite, reorder,
 * and the exact todo argv the backend receives on start.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { RebasePanel } from '../apps/praxis-git/components/RebasePanel'
import type { RebaseStatus } from '../apps/praxis-git/types'

vi.mock('../i18n/t', () => ({ i18nT: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k) }))

const apiMock = vi.hoisted(() => ({
  rebaseTodoPreview: vi.fn(),
  rebaseOp: vi.fn(),
}))
vi.mock('../apps/praxis-git/api', () => ({ api: apiMock }))

const NOT_IN_PROGRESS: RebaseStatus = { repo: 'r1', inProgress: false }

beforeEach(() => {
  apiMock.rebaseTodoPreview.mockReset()
  apiMock.rebaseOp.mockReset()
})

describe('RebasePanel todo editor', () => {
  afterEach(cleanup)

  it('previews the todo git would offer and renders one row per commit', async () => {
    apiMock.rebaseTodoPreview.mockResolvedValue({
      upstream: 'main',
      todo: ['pick aa1111 first', 'pick bb2222 second', 'pick cc3333 third'],
    })
    render(<RebasePanel repo="r1" branches={['main', 'dev']} status={NOT_IN_PROGRESS} state="ready" onChanged={() => {}} onNotice={() => {}} />)
    fireEvent.change(screen.getByTestId('rebase-upstream'), { target: { value: 'main' } })
    fireEvent.click(screen.getByTestId('rebase-preview'))
    await waitFor(() => screen.getByTestId('rebase-row-0'))
    expect(screen.getByTestId('rebase-row-0').textContent).toContain('aa1111 first')
    expect(screen.getByTestId('rebase-row-2').textContent).toContain('cc3333 third')
  })

  it('reorders rows via the arrow buttons and starts with the new order', async () => {
    apiMock.rebaseTodoPreview.mockResolvedValue({
      upstream: 'main',
      todo: ['pick aa1 one', 'pick bb2 two', 'pick cc3 three'],
    })
    apiMock.rebaseOp.mockResolvedValue({ rebased: true, conflict: false, output: '' })
    render(<RebasePanel repo="r1" branches={['main']} status={NOT_IN_PROGRESS} state="ready" onChanged={() => {}} onNotice={() => {}} />)
    fireEvent.click(screen.getByTestId('rebase-preview'))
    await waitFor(() => screen.getByTestId('rebase-row-0'))
    // move row 2 (three) up twice → it becomes row 0
    fireEvent.click(screen.getAllByLabelText('apps.gitStudio.rebase.moveUp')[2])
    fireEvent.click(screen.getAllByLabelText('apps.gitStudio.rebase.moveUp')[1])
    fireEvent.click(screen.getByTestId('rebase-start'))
    await waitFor(() => expect(apiMock.rebaseOp).toHaveBeenCalled())
    const body = apiMock.rebaseOp.mock.calls[0][1]
    expect(body.todo).toEqual(['pick cc3 three', 'pick aa1 one', 'pick bb2 two'])
  })

  it('rewriting a command to fixup reaches the submitted todo', async () => {
    apiMock.rebaseTodoPreview.mockResolvedValue({ upstream: 'main', todo: ['pick aa1 one', 'pick bb2 two'] })
    apiMock.rebaseOp.mockResolvedValue({ rebased: true, conflict: false, output: '' })
    render(<RebasePanel repo="r1" branches={['main']} status={NOT_IN_PROGRESS} state="ready" onChanged={() => {}} onNotice={() => {}} />)
    fireEvent.click(screen.getByTestId('rebase-preview'))
    await waitFor(() => screen.getByTestId('rebase-row-0'))
    fireEvent.click(screen.getByTestId('rebase-cmd-1-fixup'))
    fireEvent.click(screen.getByTestId('rebase-start'))
    await waitFor(() => expect(apiMock.rebaseOp).toHaveBeenCalled())
    expect(apiMock.rebaseOp.mock.calls[0][1].todo).toEqual(['pick aa1 one', 'fixup bb2 two'])
  })

  it('in-progress state shows stopped info and control buttons, not the editor', () => {
    render(
      <RebasePanel
        repo="r1"
        branches={['main']}
        status={{
          repo: 'r1',
          inProgress: true,
          stoppedAt: 'deadbeefdeadbeef',
          headline: 'could not apply cc3 three',
          done: ['pick aa1 one'],
          todo: ['pick bb2 two'],
          conflicts: ['f.txt'],
        }}
        state="ready"
        onChanged={() => {}}
        onNotice={() => {}}
      />,
    )
    expect(screen.getByTestId('rebase-active')).toBeTruthy()
    expect(screen.getByTestId('rebase-continue')).toBeTruthy()
    expect(screen.getByTestId('rebase-abort')).toBeTruthy()
    expect(screen.queryByTestId('rebase-todo')).toBeNull()
  })
})
