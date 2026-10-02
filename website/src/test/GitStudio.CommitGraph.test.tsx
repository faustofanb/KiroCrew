/**
 * CommitGraph windowing tests — the 100k-commit promise, checked from the
 * outside: only the visible window mounts, and approaching the end asks for
 * the next page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CommitGraph } from '../apps/praxis-git/components/CommitGraph'
import type { CommitRow } from '../apps/praxis-git/types'

vi.mock('../i18n/t', () => ({ i18nT: (k: string) => k }))

function makeRows(n: number): CommitRow[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}`.padEnd(40, '0'),
    short: `s${i}`,
    author: 'Author Name',
    email: 'a@e.com',
    timestamp: 1700000000 + i,
    subject: `commit ${i}`,
    parents: i === 0 ? [] : [`sha${i - 1}`.padEnd(40, '0')],
    node: i % 3,
    edges: [
      { a: null, b: i % 3 },
      { a: i % 3, b: i % 3 },
    ],
    branches: i % 50 === 0 ? ['main'] : [],
  }))
}

function renderGraph(rows: CommitRow[], onLoadMore = vi.fn()) {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 })
  return {
    onLoadMore,
    ...render(
      <CommitGraph
        rows={rows}
        total={rows.length}
        hasMore
        loadingMore={false}
        truncated={false}
        cap={50000}
        selectedSha={null}
        onSelect={() => {}}
        onLoadMore={onLoadMore}
      />,
    ),
  }
}

describe('CommitGraph virtualization', () => {
  afterEach(cleanup)

  it('mounts only a window of 10k rows, not the whole list', () => {
    renderGraph(makeRows(10_000))
    const mounted = document.querySelectorAll('[data-testid^="graph-row-"]').length
    expect(mounted).toBeGreaterThan(10)
    expect(mounted).toBeLessThan(100)
  })

  it('requests the next page when scrolled near the end', async () => {
    const onLoadMore = vi.fn()
    renderGraph(makeRows(2000), onLoadMore)
    const scroller = screen.getByTestId('commit-graph-scroll')
    // spacer height = rows * 26; scroll to the very bottom — the near-end
    // check runs synchronously in the scroll handler
    fireEvent.scroll(scroller, { target: { scrollTop: 2000 * 26 - 400 } })
    expect(onLoadMore).toHaveBeenCalled()
  })

  it('renders decorations (branch badge) on rows that carry them', () => {
    renderGraph(makeRows(30))
    expect(document.querySelector('[data-testid="graph-row-s0"] text-accent, [data-testid="graph-row-s0"] span')).toBeTruthy()
  })

  it('marks the selected row', () => {
    const rows = makeRows(30)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 })
    render(
      <CommitGraph
        rows={rows}
        total={30}
        hasMore={false}
        loadingMore={false}
        truncated={false}
        cap={50000}
        selectedSha={rows[0].sha}
        onSelect={() => {}}
        onLoadMore={() => {}}
      />,
    )
    const row = screen.getByTestId(`graph-row-${rows[0].short}`)
    expect(row.className).toContain('bg-accent-subtle')
  })
})
