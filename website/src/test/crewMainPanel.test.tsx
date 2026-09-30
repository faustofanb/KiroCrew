import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { api } from '../api/client'
import { createTestStore, renderWithProviders } from './helpers'
import CommandCenterPanel from '../pages/chat/command-center/CommandCenterPanel'

/** A crew member's MAIN session gets ONE template document whose every count
 * `build_crew_main` derived from that crew's crew-log folds. These cases pin the two
 * things that make the React shell a plain host of it:
 *
 *  1. it stops computing summary numbers in the browser, because a number computed here
 *     from the slot list is a second answer to a question the log already answers, and
 *     the two disagree the moment one source lags;
 *  2. it stops RENDERING the shared summary sections -- the `StatusTiles` readout, the
 *     progress bar, and the `TileList` Blocked and Progress lists with their work-item
 *     rows. Not merely stops showing them: a `hidden` block stays mounted and keeps
 *     fetching. Those components are shared with the chat dock, which keeps all of them.
 *
 * The frame itself is stubbed, the same seam `commandCenterPanel.test.tsx` uses for
 * `TaskDashboardFrame`. What is under test here is the panel's COMPOSITION -- which
 * frames exist, which slot each one addresses, and at which size. The document's own
 * render path (sanitise, theme vars, `data-dashboard-field` binding, the sandbox) is
 * covered by `dashboardDocument.test.ts` and `dynamicDashboardCard.test.tsx`, and
 * duplicating it here would test those files rather than this one.
 */
const frames: { slot: string; panel: boolean }[] = []

vi.mock('../pages/chat/command-center/SessionStatusFrame', () => ({
  default: ({ slot, panel = false }: { slot: string; panel?: boolean }) => {
    frames.push({ slot, panel })
    return <div data-testid="session-status-frame" data-slot={slot} data-panel={String(panel)} />
  },
}))

vi.mock('../pages/chat/command-center/TaskDashboardFrame', () => ({
  default: () => <div data-testid="published-task-view" />,
}))

function crewStore() {
  const initial = createTestStore().getState()
  return createTestStore({ ...initial, dashboard: { ...initial.dashboard, connected: true, slots: [
    { key: 'member-bolin', title: 'Bolin', messages: 0, running: true },
    { key: 'worker', title: 'Review worker', created_by: 'member-bolin', messages: 0, running: false },
  ] } })
}

describe('the crew main dashboard is one template, and the shell draws no number', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  beforeEach(() => {
    vi.restoreAllMocks()
    frames.length = 0
    localStorage.clear()
    vi.spyOn(api, 'kirocrewConfig').mockResolvedValue({ dashboard: { dynamic_dashboard_cards: true } })
    // happy-dom has no layout; establish the panel width that selects tabs.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(480)
    vi.spyOn(api, 'pendingQuestions').mockResolvedValue([])
    vi.spyOn(api, 'approvals').mockResolvedValue([])
    vi.spyOn(api, 'workflowRuns').mockResolvedValue({ runs: [] })
    vi.spyOn(api, 'artifacts').mockResolvedValue({ artifacts: [] })
    vi.spyOn(api, 'dashboardCard').mockResolvedValue({ card: null, status: 'waiting', published_at: null, content_event_at: null, stale: false })
    vi.spyOn(api, 'sessionWorkProjection').mockResolvedValue({ value: { items: [
      { item_id: 'one', title: 'Accepted contract', state: 'accepted' },
      { item_id: 'two', title: 'Review changes', state: 'dispatched', status: 'blocked', summary: 'Needs evidence' },
    ] } })
  })

  it('mounts one panel-sized frame for the crew slot and nothing for a worker', async () => {
    renderWithProviders(<CommandCenterPanel slot="member-bolin" active crewMain />, { store: crewStore() })
    await waitFor(() => expect(frames.length).toBeGreaterThan(0))
    // Asserted over every recorded render, not the first: the stub records one entry per
    // render, so a re-render appends and a fixed-length expectation would pin the render
    // count instead of the composition. Cardinality is pinned in the DOM below.
    expect(frames.every(frame => frame.slot === 'member-bolin' && frame.panel)).toBe(true)
    expect(screen.getAllByTestId('session-status-frame')).toHaveLength(1)
  })

  it('draws no host-computed tiles and no progress bar', async () => {
    renderWithProviders(<CommandCenterPanel slot="member-bolin" active crewMain />, { store: crewStore() })
    await waitFor(() => expect(frames.length).toBeGreaterThan(0))
    // The bar is a percentage drawn: it states a ratio while hiding both of its terms,
    // so it has no field in the contract to move to and simply goes.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument()
  })

  it('shows no board list and no Blocked section', async () => {
    renderWithProviders(<CommandCenterPanel slot="member-bolin" active crewMain />, { store: crewStore() })
    await waitFor(() => expect(frames.length).toBeGreaterThan(0))
    // The board's items are counted in the template, from the fold, with their
    // denominator in words. A per-item list beside it would be the same facts twice.
    expect(screen.queryByText('Accepted contract')).not.toBeInTheDocument()
    expect(screen.queryByText('Review changes')).not.toBeInTheDocument()
    // `Review changes` reports blocked, so the Blocked section has a row to draw and its
    // absence is the gate rather than an empty list.
    expect(screen.queryByText('Needs evidence')).not.toBeInTheDocument()
  })

  it('keeps the approval and question controls, which are not summary numbers', async () => {
    // The panel's real controls stay in React: a control inside a sandboxed presentation
    // document is a control whose authority nobody can audit.
    vi.mocked(api.approvals).mockResolvedValue([
      { id: 'permission', slot: 'dashboard:member-bolin', tool: 'shell', tool_input: 'git status' },
    ])
    vi.mocked(api.pendingQuestions).mockResolvedValue([{ slot: 'dashboard:member-bolin', ask_id: 'ask', questions: [
      { question: 'Which contract?', options: [{ label: 'Stable API' }] },
    ] }])
    renderWithProviders(<CommandCenterPanel slot="member-bolin" active crewMain />, { store: crewStore() })
    await waitFor(() => expect(frames.length).toBeGreaterThan(0))
    expect(await screen.findByText('Which contract?')).toBeInTheDocument()
    expect(screen.getByText('git status')).toBeInTheDocument()
  })

  it('leaves the chat side panel and the fleet page exactly as they were', async () => {
    // Neither passes the flag. This is the boundary the scope change named.
    renderWithProviders(<CommandCenterPanel slot="member-bolin" active />, { store: crewStore() })
    expect(await screen.findByText('Accepted contract')).toBeInTheDocument()
    // Twice, and that is main's own composition: the Blocked section lists it because it
    // reports blocked, and the Progress list carries every work item whatever its state.
    expect(screen.getAllByText('Review changes')).toHaveLength(2)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    // Same single frame, addressing the same slot -- sized as one section among those
    // lists rather than as the whole body. That size is the only thing the flag changes
    // about the frame itself.
    await waitFor(() => expect(frames.length).toBeGreaterThan(0))
    expect(frames.every(frame => frame.slot === 'member-bolin' && !frame.panel)).toBe(true)
    expect(screen.getAllByTestId('session-status-frame')).toHaveLength(1)
  })
})
