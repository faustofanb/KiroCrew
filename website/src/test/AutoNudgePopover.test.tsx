import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AutoNudgePopover, { STOP_FILE_TOKEN, type AutoNudgeLoop } from '../components/AutoNudgePopover'
import { __resetForTests, loadGoalDraft, saveGoalDraft } from '../utils/goalDrafts'
import { DRAFT_SAVE_DEBOUNCE_MS } from '../utils/draftConstants'

const SLOT = 'chat-1-100'

function renderPopover(loop: AutoNudgeLoop | null) {
  // A FRESH client per render: the popover reads the shared `cron-jobs` key, and
  // a client reused across tests would serve one test's stubbed rows to the next.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <AutoNudgePopover
        slotKey={SLOT}
        loop={loop}
        open={true}
        onOpenChange={() => {}}
        onChange={() => {}}
      />
    </QueryClientProvider>,
  )
}

const makeLoop = (over: Partial<AutoNudgeLoop> = {}): AutoNudgeLoop => ({
  id: 'l1', slot_key: SLOT, message: 'active loop goal',
  idle_secs: 90, max_cycles: 3, cycle_count: 1, active: true, last_fire_ts: 0,
  next_due_ts: 0, ...over,
})

describe('AutoNudgePopover goal persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    // The popover fetches on OPEN (reads /api/crons to list this slot's
    // watches) and on Save/Stop. Stub so nothing escapes the test.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const goalBox = () => screen.getByPlaceholderText(/Describe what you want the agent to accomplish/i) as HTMLTextAreaElement

  it('remembers the user-typed goal and restores it after the loop is gone (the reported bug)', () => {
    vi.useFakeTimers()
    // 1. User opens the popover (no loop yet) and types a custom goal.
    const first = renderPopover(null)
    fireEvent.change(goalBox(), { target: { value: 'Ship the BYOA gate harness' } })
    // Debounced: not written synchronously. Advancing past the debounce persists it.
    expect(loadGoalDraft(SLOT)).toBeNull()
    act(() => { vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS) })
    expect(loadGoalDraft(SLOT)?.message).toBe('Ship the BYOA gate harness')
    first.unmount()

    // 2. The loop is stopped elsewhere → ChatPage passes loop={null} on re-open;
    //    the popover restores the stored draft, not the default template.
    renderPopover(null)
    expect(goalBox().value).toBe('Ship the BYOA gate harness')
  })

  it('flushes a pending debounced edit on unmount (a fast close does not lose the last keystrokes)', () => {
    vi.useFakeTimers()
    const view = renderPopover(null)
    fireEvent.change(goalBox(), { target: { value: 'closing fast' } })
    // Close BEFORE the debounce fires — the unmount flush must still persist it.
    expect(loadGoalDraft(SLOT)).toBeNull()
    view.unmount()
    expect(loadGoalDraft(SLOT)?.message).toBe('closing fast')
  })

  it('does not persist the pristine default (an untouched popover pins nothing, on open or close)', () => {
    vi.useFakeTimers()
    const view = renderPopover(null)
    // Opened, never edited → the edit-guard means no write, on debounce OR unmount.
    act(() => { vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS) })
    expect(loadGoalDraft(SLOT)).toBeNull()
    view.unmount()
    expect(loadGoalDraft(SLOT)).toBeNull()
  })

  it('opening with an existing stored draft does not rewrite it (a mere view must not touch the store)', () => {
    // Seed a draft, snapshot the raw storage, then open (no edit) and close.
    // The stored bytes must be identical — no TTL refresh, no LRU bump.
    saveGoalDraft(SLOT, { message: 'remembered goal', idleSecs: 120, maxCycles: 5 })
    const draftsBefore = localStorage.getItem('mc-goal-drafts')
    const tsBefore = localStorage.getItem('mc-goal-drafts-ts')

    const view = renderPopover(null)
    expect(goalBox().value).toBe('remembered goal') // restored on open
    view.unmount() // close without editing

    expect(localStorage.getItem('mc-goal-drafts')).toBe(draftsBefore)
    expect(localStorage.getItem('mc-goal-drafts-ts')).toBe(tsBefore)
  })

  it('prefers the live loop message over a stored draft when a loop is running', () => {
    saveGoalDraft(SLOT, { message: 'stale draft goal', idleSecs: 60, maxCycles: 0 })
    renderPopover(makeLoop({ message: 'active loop goal' }))
    expect(goalBox().value).toBe('active loop goal')
  })

  it('opening with a live loop never writes the loop config into the draft store', () => {
    vi.useFakeTimers()
    // No stored draft. Open with a live loop, let any timer fire, then close.
    const view = renderPopover(makeLoop())
    act(() => { vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS) })
    view.unmount()
    // The live loop's config must NOT have been mirrored into the user-draft store.
    expect(loadGoalDraft(SLOT)).toBeNull()
  })

  it('editing while a loop is running does not persist to the draft store (loop is authoritative)', () => {
    vi.useFakeTimers()
    const view = renderPopover(makeLoop())
    fireEvent.change(goalBox(), { target: { value: 'tweaked while running' } })
    act(() => { vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS) })
    view.unmount()
    expect(loadGoalDraft(SLOT)).toBeNull()
  })

  it('falsy loop fields fall back to default template / 60 / 0, not bare "" / 0 (|| not ??)', () => {
    // A loop with an empty message and idle_secs/max_cycles of 0 must show the
    // default template + 60 — falsy loop fields fall back (|| not ??).
    renderPopover(makeLoop({ message: '', idle_secs: 0, max_cycles: 0 }))
    expect(goalBox().value).toContain('north star')
    expect((screen.getByDisplayValue('60') as HTMLInputElement).value).toBe('60')
  })
})

describe('AutoNudgePopover number-field editing (idle / max cycles)', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  // Idle is the first number input, max-cycles the second (DOM order in the JSX).
  const fields = () => screen.getAllByRole('spinbutton') as HTMLInputElement[]
  const idleField = () => fields()[0]
  const cyclesField = () => fields()[1]

  it('allows clearing the idle field to empty while typing, then defaults to 60 on blur (the reported bug)', () => {
    renderPopover(null)
    expect(idleField().value).toBe('60')
    // The empty edit is allowed as-typed rather than snapping straight back to
    // 60 with the leading digit stuck...
    fireEvent.change(idleField(), { target: { value: '' } })
    expect(idleField().value).toBe('')
    // ...and only commits to the default when the field loses focus.
    fireEvent.blur(idleField())
    expect(idleField().value).toBe('60')
  })

  it('retypes idle 60 -> 30 without the leading digit sticking', () => {
    renderPopover(null)
    fireEvent.change(idleField(), { target: { value: '' } })
    fireEvent.change(idleField(), { target: { value: '30' } })
    expect(idleField().value).toBe('30')
    fireEvent.blur(idleField())
    expect(idleField().value).toBe('30')
  })

  it('empty max-cycles commits to 0 (infinity) on blur', () => {
    renderPopover(null)
    expect(cyclesField().value).toBe('0')
    fireEvent.change(cyclesField(), { target: { value: '' } })
    expect(cyclesField().value).toBe('')
    fireEvent.blur(cyclesField())
    expect(cyclesField().value).toBe('0')
  })

  it('Save sends the typed idle value even without an intervening blur', async () => {
    renderPopover(null)
    fireEvent.change(idleField(), { target: { value: '45' } })
    // Click Start loop WITHOUT blurring the field first — save() must read the
    // raw string, not a stale committed number.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start loop/i })) })
    // Select the call by URL, not by index: opening the popover also READS
    // /api/crons to list this slot's watches, so the save POST is no longer
    // call 0 and an index would pin an unrelated ordering.
    // The init arg is optional and its `body` is too: the /api/crons read is a
    // bare `fetch(url)` and a delete carries only `{ method }`, so `c[1]?.body`
    // below is load-bearing rather than defensive.
    const calls = (fetch as unknown as { mock: { calls: [string, { body?: string }?][] } }).mock.calls
    const save = calls.find(c => String(c[0]).startsWith('/api/autonudge') && c[1]?.body)
    expect(save, 'no /api/autonudge write was issued').toBeTruthy()
    const body = JSON.parse(save![1]!.body!)
    expect(body.idle_secs).toBe(45)
  })
})

describe('AutoNudgePopover trigger chip — interrupted state', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const renderChip = (loop: AutoNudgeLoop | null, interrupted: boolean) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <AutoNudgePopover
        slotKey={SLOT}
        loop={loop}
        open={false}
        onOpenChange={() => {}}
        onChange={() => {}}
        interrupted={interrupted}
      />
    </QueryClientProvider>,
  )

  it('pulses while the loop is active and the session is healthy', () => {
    renderChip(makeLoop({ cycle_count: 47 }), false)
    const chip = screen.getByTitle('Goal active (cycle 47/3)')
    expect(chip.className).toContain('animate-pulse')
    expect(chip.textContent).toContain('47')
  })

  it('stops pulsing and explains itself when the last turn was interrupted (the reported bug)', () => {
    // The composer is showing Resume: nothing runs until the user acts or the
    // next idle-timer cycle fires, so a pulsing chip would claim active work
    // for that whole gap.
    renderChip(makeLoop({ cycle_count: 47 }), true)
    const chip = screen.getByTitle(/last turn was interrupted/)
    expect(chip.className).not.toContain('animate-pulse')
    // The cycle count survives — it is state, not a liveness claim.
    expect(chip.textContent).toContain('47')
  })

  it('ignores interrupted when no loop is active (plain set-a-goal chip)', () => {
    renderChip(null, true)
    const chip = screen.getByTitle('Set a goal')
    expect(chip.className).not.toContain('animate-pulse')
  })
})


describe('AutoNudgePopover — zero-token watches armed on this slot', () => {
  const cron = (over: Record<string, unknown> = {}) => ({
    id: 'j1',
    name: 'pr watch #6234',
    schedule: 'every 60s',
    next_run_ts: 1787816571,
    session_key: `dashboard:${SLOT}`,
    script: '~/.kiro/crew/crons/pr_watch.py:watch',
    enabled: true,
    ...over,
  })

  function stubCrons(rows: unknown[]) {
    // `{ jobs: [...] }` is the endpoint's real envelope. An earlier version of
    // these tests stubbed a bare array, which matched a wrong reader and hid a
    // section that never rendered against the live gateway -- the fixture has to
    // be the shape the server sends, or the test only proves the reader agrees
    // with itself.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(String(url).startsWith('/api/crons') ? { jobs: rows } : { loop: null }),
        }),
      ) as unknown as typeof fetch,
    )
  }

  beforeEach(() => { localStorage.clear(); __resetForTests() })
  afterEach(() => { vi.unstubAllGlobals() })

  /**
   * Render, then wait for the crons read to have been ANSWERED, not just issued.
   *
   * The section is populated by `fetch` -> `json()` -> `setState`, three promise
   * hops that `act` does not wait for, so a bare `await act(render)` samples the
   * popover before the answer lands. That made the positive test below flake
   * (1 in 5 full runs on a loaded host) and every "not listed" assertion in this
   * block vacuous: the section is absent BEFORE the fetch resolves whether or not
   * the filter works. Waiting on the mocked fetch having been called, then
   * draining the chain, makes both kinds of assertion about the rendered answer.
   */
  async function renderPopoverSettled() {
    await act(async () => { renderPopover(null) })
    const fetchMock = vi.mocked(fetch)
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(c => String(c[0]).startsWith('/api/crons'))).toBe(true),
    )
    for (let i = 0; i < 4; i++) {
      await act(async () => { await Promise.resolve() })
    }
  }

  it('lists a script cron this slot owns, so an armed watch is visible in chat', async () => {
    // The reported gap: a watch is deliberately NOT an autonudge loop, so the
    // popover showed "Set a goal" and nothing else while a watch was polling --
    // the one surface a user opens to confirm something is running.
    stubCrons([cron()])
    await renderPopoverSettled()
    expect(await screen.findByText(/Zero-token watches/i)).toBeTruthy()
    expect(screen.getByText('pr watch #6234')).toBeTruthy()
  })

  it('never lists a watch owned by a different slot', async () => {
    // Ownership goes through the shared `runBelongsToSlot`, which normalizes the
    // `dashboard:` namespace rather than demanding byte equality -- but the SLOT
    // must still match, and that is the property worth pinning: another
    // conversation's watch appearing here is worse than showing none.
    stubCrons([cron({ session_key: 'dashboard:chat-9-999', name: 'someone elses watch' })])
    await renderPopoverSettled()
    expect(screen.queryByText('someone elses watch')).toBeNull()
    expect(screen.queryByText(/Zero-token watches/i)).toBeNull()
  })

  it('never lists a message-only cron under a zero-token heading', async () => {
    // A cron with no script wakes the agent every fire. Listing it here would
    // make the heading lie about what it costs.
    stubCrons([cron({ script: '', name: 'daily reminder' })])
    await renderPopoverSettled()
    expect(screen.queryByText('daily reminder')).toBeNull()
    expect(screen.queryByText(/Zero-token watches/i)).toBeNull()
  })

  it('never lists a disabled watch as if it were armed', async () => {
    stubCrons([cron({ enabled: false, name: 'paused watch' })])
    await renderPopoverSettled()
    expect(screen.queryByText('paused watch')).toBeNull()
  })

  it('reads the jobs envelope the endpoint actually returns, not a bare array', async () => {
    // The live endpoint answers `{ jobs: [...] }` (handlers/cron.py). Reading a
    // bare array fails SILENTLY -- no error, the filter just never matches -- so
    // this pins the envelope rather than trusting the reader. Found by a pod
    // capture after the unit tests were green against the wrong fixture.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(String(url).startsWith('/api/crons') ? [cron()] : { loop: null }),
        }),
      ) as unknown as typeof fetch,
    )
    await renderPopoverSettled()
    // A bare array is NOT the contract, so nothing should be read out of it.
    expect(screen.queryByText(/Zero-token watches/i)).toBeNull()
  })

  it('stays silent when the read fails rather than banner-ing over the goal form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).startsWith('/api/crons')
          ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
          : Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) }),
      ) as unknown as typeof fetch,
    )
    await renderPopoverSettled()
    expect(screen.queryByText(/Zero-token watches/i)).toBeNull()
    // The popover's actual job is still fully usable.
    expect(screen.getByPlaceholderText(/Describe what you want the agent to accomplish/i)).toBeTruthy()
  })
})

/** #6482: hovering the goal button / opening the popover shows a live countdown
 *  to the next trigger, computed from the loop's already-serialized next_due_ts. */
describe('AutoNudgePopover next-trigger countdown', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const nowSecs = () => Date.now() / 1000

  it('shows the countdown in the popover and the trigger tooltip, and it ticks', () => {
    renderPopover(makeLoop({ next_due_ts: nowSecs() + 125 }))
    // 125s -> "2m 5s" (en narrow units via fmtDuration).
    expect(screen.getAllByText(/Next cycle in .*2.*m.*5.*s/i).length).toBeGreaterThan(0)
    const trigger = screen.getByRole('button', { name: /Goal active \(cycle 1\/3\)/i })
    expect(trigger.getAttribute('title')).toMatch(/Next cycle in/i)

    // One tick: the rendered remaining time decreases.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getAllByText(/Next cycle in .*2.*m.*4.*s/i).length).toBeGreaterThan(0)
  })

  it('drops the seconds digit above an hour', () => {
    renderPopover(makeLoop({ next_due_ts: nowSecs() + 3_720 }))
    const line = screen.getAllByText(/Next cycle in/i)[0].textContent || ''
    expect(line).toMatch(/1.*h/i)
    expect(line).not.toMatch(/\ds\b/)
  })

  it('reads "due" instead of a negative countdown when the deadline elapsed mid-turn', () => {
    renderPopover(makeLoop({ next_due_ts: nowSecs() - 5 }))
    expect(screen.getAllByText(/Next cycle due, fires after the current turn/i).length).toBeGreaterThan(0)
  })

  it('shows the unscheduled placeholder when next_due_ts is 0', () => {
    renderPopover(makeLoop({ next_due_ts: 0 }))
    expect(screen.getAllByText(/Next cycle not yet scheduled/i).length).toBeGreaterThan(0)
  })

  it('shows no countdown for an inactive loop', () => {
    renderPopover(makeLoop({ active: false, next_due_ts: nowSecs() + 300 }))
    expect(screen.queryByText(/Next cycle/i)).toBeNull()
  })

  /** Review finding: the countdown must stay OUT of aria-label — a per-second
   *  label change re-announces the button to screen readers. Title only. */
  it('keeps aria-label stable (countdown lives in title only)', () => {
    renderPopover(makeLoop({ next_due_ts: nowSecs() + 125 }))
    const trigger = screen.getByRole('button', { name: /Goal active \(cycle 1\/3\)/i })
    expect(trigger.getAttribute('aria-label')).not.toMatch(/Next cycle/i)
    expect(trigger.getAttribute('title')).toMatch(/Next cycle in/i)
  })

  /** Review finding: the 1s ticker is popover-open-only — a closed-but-armed
   *  loop must not re-render the toolbar button every second. Hover/focus
   *  refresh the snapshot instead, which is all a native tooltip can show. */
  it('does not tick while closed; hovering the trigger refreshes the tooltip', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const deadline = nowSecs() + 125
    render(
      <QueryClientProvider client={qc}>
        <AutoNudgePopover slotKey={SLOT} loop={makeLoop({ next_due_ts: deadline })} open={false} onOpenChange={() => {}} onChange={() => {}} />
      </QueryClientProvider>,
    )
    const trigger = screen.getByRole('button', { name: /Goal active \(cycle 1\/3\)/i })
    expect(trigger.getAttribute('title')).toMatch(/2.*m.*5.*s/i)

    // A minute passes with the popover closed: no interval is armed, so the
    // title still carries the mount-time snapshot...
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(trigger.getAttribute('title')).toMatch(/2.*m.*5.*s/i)

    // ...until a hover refreshes it to the current remaining time.
    fireEvent.mouseEnter(trigger)
    expect(trigger.getAttribute('title')).toMatch(/1.*m.*5.*s/i)
  })

  it('stops updating after the loop goes inactive (ticker torn down)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const deadline = nowSecs() + 125
    const props = { slotKey: SLOT, open: true, onOpenChange: () => {}, onChange: () => {} }
    const view = render(
      <QueryClientProvider client={qc}>
        <AutoNudgePopover {...props} loop={makeLoop({ next_due_ts: deadline })} />
      </QueryClientProvider>,
    )
    expect(screen.getAllByText(/Next cycle in/i).length).toBeGreaterThan(0)

    view.rerender(
      <QueryClientProvider client={qc}>
        <AutoNudgePopover {...props} loop={makeLoop({ active: false, next_due_ts: deadline })} />
      </QueryClientProvider>,
    )
    expect(screen.queryByText(/Next cycle/i)).toBeNull()
    // Advancing the clock after teardown must not resurrect it or throw.
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.queryByText(/Next cycle/i)).toBeNull()
  })
})

/** #7410 residual 1: the cycle readout carries its cap, so a loop coasting
 *  toward its max_cycles backstop is visible before it silently stops. */
describe('AutoNudgePopover cycle cap readout', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const renderChip = (loop: AutoNudgeLoop | null, interrupted = false) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <AutoNudgePopover
        slotKey={SLOT}
        loop={loop}
        open={false}
        onOpenChange={() => {}}
        onChange={() => {}}
        interrupted={interrupted}
      />
    </QueryClientProvider>,
  )

  it('renders the cap beside the cycle number, so a loop nearing its backstop is visible before it stops', () => {
    // The reported gap: max_cycles reached the frontend but was never displayed,
    // so cycle 23 of 24 looked exactly like cycle 23 of an uncapped loop.
    renderChip(makeLoop({ cycle_count: 23, max_cycles: 24 }))
    const chip = screen.getByTitle('Goal active (cycle 23/24)')
    expect(chip.textContent).toContain('23/24')
    // Screen-reader users learn the cap too — it is state, not a live countdown.
    expect(chip.getAttribute('aria-label')).toBe('Goal active (cycle 23/24)')
  })

  it('renders a bare cycle count with no slash when max_cycles is 0, because an uncapped loop has no denominator to count toward', () => {
    renderChip(makeLoop({ cycle_count: 23, max_cycles: 0 }))
    const chip = screen.getByTitle('Goal active (cycle 23)')
    expect(chip.textContent).toContain('23')
    expect(chip.textContent).not.toContain('/')
    expect(chip.getAttribute('aria-label')).toBe('Goal active (cycle 23)')
  })

  it('carries the cap into the interrupted tooltip too, since an interrupted loop is still armed against that cap', () => {
    renderChip(makeLoop({ cycle_count: 12, max_cycles: 24 }), true)
    const chip = screen.getByTitle(/last turn was interrupted/)
    expect(chip.getAttribute('title')).toContain('cycle 12/24')
  })

  it('shows the capped readout in the popover header, not only on the chip', () => {
    renderPopover(makeLoop({ cycle_count: 3, max_cycles: 24 }))
    expect(screen.getByText('· cycle 3/24')).toBeTruthy()
  })

  it('keeps the capped aria-label static while the countdown ticks (a cap must not re-announce the button every second)', () => {
    // Pins the same contract as "keeps aria-label stable": the cap is derived
    // from cycle_count/max_cycles only, so an armed ticker changes the title and
    // leaves the label alone.
    vi.useFakeTimers()
    renderPopover(makeLoop({ cycle_count: 3, max_cycles: 24, next_due_ts: Date.now() / 1000 + 125 }))
    const trigger = screen.getByRole('button', { name: 'Goal active (cycle 3/24)' })
    expect(trigger.getAttribute('title')).toMatch(/Next cycle in/i)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(trigger.getAttribute('aria-label')).toBe('Goal active (cycle 3/24)')
    expect(trigger.getAttribute('aria-label')).not.toMatch(/Next cycle/i)
  })
})

describe('AutoNudgePopover Trigger nudge (#8212)', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  /** Local render helper: the shared one hardcodes no-op callbacks, and these
   *  tests are about what the press DOES to them.
   *
   *  `open` is CONTROLLED here, mirroring the real parent (ChatInput owns the
   *  flag and feeds it back). A fixed `open={true}` would make the harness pin
   *  the popover's presence, so "the edit survives" could not fail even if the
   *  code closed it -- the assertion would be about the fixture rather than the
   *  component. */
  const renderWith = (loop: AutoNudgeLoop | null, onChange = vi.fn()) => {
    const onOpenChange = vi.fn()
    const Harness = () => {
      const [open, setOpen] = useState(true)
      return (
        <AutoNudgePopover
          slotKey={SLOT}
          loop={loop}
          open={open}
          onOpenChange={v => { onOpenChange(v); setOpen(v) }}
          onChange={onChange}
        />
      )
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    )
    return { onChange, onOpenChange }
  }

  /** The Nudge-now button, by its test id: its NAME is state-aware (see the
   *  name test below), so a name query would pin one of its two readings. */
  const triggerButton = () => screen.queryByTestId('auto-nudge-trigger')
  /** The button is ICON-ONLY (product owner, 2026-09-30 23:22Z: the dashboard's
   *  toolbars are glyphs with hover text, and this popover follows them): its
   *  name is the `aria-label`, the same string is the `title` a hover shows,
   *  and it renders no visible text. Returns the name. */
  const triggerName = () => {
    const button = triggerButton()!
    expect(button.title).toBe(button.getAttribute('aria-label'))
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).toBeTruthy()
    return button.getAttribute('aria-label')
  }

  it('offers the button while a loop is active', () => {
    renderWith(makeLoop())
    expect(triggerButton()).toBeTruthy()
  })

  it('names itself for what the press will do: "Nudge now" on a pristine form, "Save edits and nudge now" once a field differs -- in aria-label and title, with no visible text', () => {
    // A static "Save edits and nudge now" promised a save that a pristine press
    // never makes (a pristine press writes nothing; see the writes-NOTHING test
    // below). The name follows `editedFields`: the same rule that decides
    // whether the press writes, so the two can never disagree. Both directions
    // asserted, and the way back -- an edit typed back to what the form showed
    // is not an edit.
    renderWith(makeLoop({ message: 'the armed goal' }))
    expect(triggerName()).toBe('Nudge now')
    expect(screen.getByRole('button', { name: 'Nudge now' })).toBe(triggerButton())
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'the armed goal, edited' } })
    expect(triggerName()).toBe('Save edits and nudge now')
    expect(screen.getByRole('button', { name: 'Save edits and nudge now' })).toBe(triggerButton())
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'the armed goal' } })
    expect(triggerName()).toBe('Nudge now')
    // A number field counts on its PARSED value: "090" is the seeded 90, not an edit.
    fireEvent.change(screen.getByLabelText('Seconds between nudges'), { target: { value: '090' } })
    expect(triggerName()).toBe('Nudge now')
    fireEvent.change(screen.getByLabelText('Seconds between nudges'), { target: { value: '60' } })
    expect(triggerName()).toBe('Save edits and nudge now')
  })

  it('offers it NOWHERE when no loop is running, so the affordance never appears without a subject', () => {
    renderWith(null)
    // Complement assertion rather than a bare negative on one node: a stale
    // render could leave the button somewhere else in the tree, and "the
    // button I looked for is absent" would still pass.
    expect(triggerButton()).toBeNull()
    expect(screen.queryAllByRole('button', { name: /Trigger/i })).toHaveLength(0)
  })

  it('offers it NOWHERE for a stopped loop, because the server refuses to fire one', () => {
    // Gated on `active`, not on `loop`: every terminal bound leaves the loop
    // inactive, so a button here could only ever produce a 409. (A loop the
    // user PAUSED keeps the control, disabled -- see the icon-controls block.)
    renderWith(makeLoop({ active: false }))
    expect(triggerButton()).toBeNull()
    expect(screen.queryAllByRole('button', { name: /Trigger/i })).toHaveLength(0)
  })

  it('disables itself once a cycle is due, so a press visibly acknowledges itself', () => {
    // The press used to leave the button re-enabled and unchanged, so a reader
    // could not tell whether pressing again would double the nudge. It would not:
    // the cycle is already armed. Both directions asserted -- a loop that is NOT
    // due must stay pressable, or this would disable the feature it guards.
    renderWith(makeLoop({ next_due_ts: 1_700_000_000 }))
    expect(triggerButton()).toBeTruthy()
    expect((triggerButton() as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    renderWith(makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 300 }))
    expect((triggerButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('names the way OUT of a stopped loop: one accented Play, and no Save to do it silently', () => {
    // A stopped loop's way back is its own control -- Play, labelled "Start
    // loop and nudge now" -- which saves the form, revives the loop and fires.
    // There is no separate Save on an inactive loop: the one control does it
    // all, in the accent the primary action wears. It used to be one button
    // reading "Save", which said nothing about resuming; a blind reader found
    // no resume path at all and called "Stop loop" risky as a result. Both
    // directions asserted: a running loop has Save and no Play, or this would
    // just move the confusion.
    renderWith(makeLoop({ active: false }))
    expect(screen.getByRole('button', { name: 'Start loop and nudge now' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start loop and nudge now' }).className).toContain('bg-accent')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    cleanup()
    renderWith(makeLoop({ active: true }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start loop and nudge now' })).toBeNull()
  })

  it('says the loop is stopped where the button would be, so the absence has a reason', () => {
    // Absence alone is ambiguous: an inactive loop looked identical to an active
    // one whose button failed to render, and a usability reader could not tell
    // the stopped screenshot was even the same loop. The state is the reason for
    // the absence, so it occupies the space the absence leaves.
    renderWith(makeLoop({ active: false }))
    expect(screen.getByTestId('auto-nudge-loop-paused')).toBeTruthy()
    // And it is genuinely conditional, not always-on decoration.
    cleanup()
    renderWith(makeLoop({ active: true }))
    expect(screen.queryByTestId('auto-nudge-loop-paused')).toBeNull()
    expect(triggerButton()).toBeTruthy()
  })

  it('saves an EDITED form first, then posts to the loop-scoped fire route with NO body -- so the form as it reads is what fires', async () => {
    const saved = makeLoop({ message: 'edited then triggered' })
    const fired = makeLoop({ message: 'edited then triggered', next_due_ts: 1_700_000_000 })
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          String(url).endsWith('/fire') ? { ok: true, loop: fired }
            : init?.method === 'PATCH' ? { ok: true, loop: saved }
              : { loop: null },
        ),
      }),
    ) as unknown as typeof fetch)
    const { onChange, onOpenChange } = renderWith(makeLoop())
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'edited then triggered' } })

    await act(async () => { fireEvent.click(triggerButton()!) })

    // Selected by URL, not by index: opening the popover also reads /api/crons.
    const calls = (fetch as unknown as { mock: { calls: [string, { method?: string, body?: string }?][] } }).mock.calls
    const patch = calls.find(c => String(c[0]) === '/api/autonudge/l1' && c[1]?.method === 'PATCH')
    const fire = calls.find(c => String(c[0]) === '/api/autonudge/l1/fire')
    expect(patch, 'no PATCH of the form was issued').toBeTruthy()
    expect(fire, 'no POST to the fire route was issued').toBeTruthy()
    // Every trigger implicitly saves: the fields the user EDITED -- here the
    // goal alone, so the untouched interval and cap are not written back --
    // and NEVER `active`: a running loop's save must not be able to revive a
    // loop another tab paused between render and press.
    expect(JSON.parse(patch![1]!.body!)).toEqual({ message: 'edited then triggered' })
    // The fire itself carries no body: what fires is what the loop now holds,
    // which the PATCH a moment earlier made the form's text.
    expect(fire![1]?.method).toBe('POST')
    expect(fire![1]?.body).toBeUndefined()
    expect(calls.indexOf(patch!)).toBeLessThan(calls.indexOf(fire!))
    // ONE hand-off, once the fire settled: the fired record -- which carries
    // the goal the PATCH a moment earlier saved -- with the armed deadline the
    // server no longer moves, so the component supplies it. A second hand-off
    // from this pressed render would be dropped by the bridge's identity guard
    // (see SessionAutomationPopover), which is why the written record is not
    // handed up on its own first.
    expect(onChange).toHaveBeenCalledTimes(1)
    const passed = onChange.mock.calls[0][0]
    expect(passed).toMatchObject({ ...fired, next_due_ts: expect.any(Number) })
    expect(passed.message).toBe('edited then triggered')
    expect(passed.next_due_ts).toBeGreaterThan(Date.now() / 1000 - 5)
    // Stays open, like every control that fires or changes the run state: the
    // outcome (the schedule line reading due) is visible in place, and a
    // refusal needs somewhere to land. Only Save closes.
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('after a write, the form and its pristine baseline hold what the server STORED, not what was sent: idle 1 goes out, 15 comes back, the field reads 15 and the form is pristine', async () => {
    // The service clamps the interval into its floor (15 s) and ceiling and the
    // cap to zero or more, and the write route returns the record as stored.
    // Seeding the baseline from the SENT values would leave the field showing
    // "1" over a record holding 15 while reading pristine -- a value the loop
    // does not run at, with no edit left to make the gap visible. So the fields
    // that went out re-sync from the returned record, and so does the baseline:
    // a second press with no further edit sends nothing again.
    const stored = makeLoop({ idle_secs: 15 })
    const fired = makeLoop({ idle_secs: 15, next_due_ts: 1_700_000_000 })
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          String(url).endsWith('/fire') ? { ok: true, loop: fired }
            : init?.method === 'PATCH' ? { ok: true, loop: stored }
              : { loop: null },
        ),
      }),
    ) as unknown as typeof fetch)
    renderWith(makeLoop({ idle_secs: 90 }))
    const idleField = () => (screen.getAllByRole('spinbutton') as HTMLInputElement[])[0]
    fireEvent.change(idleField(), { target: { value: '1' } })
    expect(triggerButton()!.getAttribute('aria-label')).toBe('Save edits and nudge now')

    await act(async () => { fireEvent.click(triggerButton()!) })

    const calls = () => (fetch as unknown as { mock: { calls: [string, { method?: string, body?: string }?][] } }).mock.calls
    const patches = () => calls().filter(c => String(c[0]) === '/api/autonudge/l1' && c[1]?.method === 'PATCH')
    expect(patches()).toHaveLength(1)
    expect(JSON.parse(patches()[0][1]!.body!)).toEqual({ idle_secs: 1 })
    // The field shows what the loop now runs at, and the form reads pristine
    // against it: the Nudge-now name is back to the no-save reading.
    expect(idleField().value).toBe('15')
    expect(triggerButton()!.getAttribute('aria-label')).toBe('Nudge now')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()

    // No phantom edit: a second press writes nothing and only fires.
    await act(async () => { fireEvent.click(triggerButton()!) })
    expect(patches()).toHaveLength(1)
    expect(calls().filter(c => String(c[0]) === '/api/autonudge/l1/fire')).toHaveLength(2)
  })

  it('writes NOTHING on a pristine form: the armed goal fires as the loop holds it, so a revision that landed while the popover sat open survives', async () => {
    // The fields seed on the open edge and never re-sync. A `monitor_update`
    // from the nudged agent (or another tab's save) that lands while the
    // popover sits open therefore changes the RECORD and not the form -- and a
    // Trigger that always wrote the form would write the stale text straight
    // back over it, then fire that. The rule: no edit, no write.
    const armed = makeLoop({ message: 'armed goal, as opened' })
    const revised = makeLoop({ message: 'revised by monitor_update while open' })
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(String(url).endsWith('/fire') ? { ok: true, loop: revised } : { loop: null }) }),
    ) as unknown as typeof fetch)
    const onChange = vi.fn()
    let revise: (loop: AutoNudgeLoop) => void = () => {}
    const Harness = () => {
      const [loop, setLoop] = useState<AutoNudgeLoop>(armed)
      revise = setLoop
      return <AutoNudgePopover slotKey={SLOT} loop={loop} open={true} onOpenChange={() => {}} onChange={onChange} />
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>)
    // The revision arrives over the websocket: the record moves, the form does not.
    act(() => revise(revised))
    expect((screen.getByLabelText('Goal description') as HTMLTextAreaElement).value).toBe('armed goal, as opened')

    await act(async () => { fireEvent.click(triggerButton()!) })

    const calls = (fetch as unknown as { mock: { calls: [string, { method?: string, body?: string }?][] } }).mock.calls
    expect(calls.filter(c => c[1]?.method === 'PATCH'), 'a pristine form was written back').toEqual([])
    const fire = calls.find(c => String(c[0]) === '/api/autonudge/l1/fire')
    expect(fire, 'no POST to the fire route was issued').toBeTruthy()
    expect(fire![1]?.body).toBeUndefined()
    // Only the due reading is handed up -- nothing was written -- and it
    // carries the revision, because that is what the loop holds and fired.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toMatchObject({ message: 'revised by monitor_update while open' })
  })

  it('a second press after a saved edit writes nothing again: the saved fields are the new pristine baseline', async () => {
    // Otherwise every press after the first would re-send the same fields,
    // and the second press is exactly the one that can land after a revision.
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          String(url).endsWith('/fire') || init?.method === 'PATCH' ? { ok: true, loop: makeLoop({ message: 'edited once' }) } : { loop: null },
        ),
      }),
    ) as unknown as typeof fetch)
    renderWith(makeLoop())
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'edited once' } })
    const patches = () => (fetch as unknown as { mock: { calls: [string, { method?: string }?][] } }).mock.calls.filter(c => c[1]?.method === 'PATCH')

    await act(async () => { fireEvent.click(triggerButton()!) })
    expect(patches()).toHaveLength(1)
    await act(async () => { fireEvent.click(triggerButton()!) })
    expect(patches()).toHaveLength(1)
  })

  it('keeps the typed goal in the textarea after a successful press (it is now saved, not lost)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          String(url).endsWith('/fire') || init?.method === 'PATCH' ? { ok: true, loop: makeLoop({ message: 'edited and saved' }) } : { loop: null },
        ),
      }),
    ) as unknown as typeof fetch)
    renderWith(makeLoop())
    const box = screen.getByLabelText('Goal description') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'edited and saved' } })

    await act(async () => { fireEvent.click(triggerButton()!) })

    expect((screen.getByLabelText('Goal description') as HTMLTextAreaElement).value)
      .toBe('edited and saved')
  })

  it('surfaces a refused fire inline and keeps the popover open; the save that preceded it stands', async () => {
    // The refusal names the outcome and the next step, not just the condition:
    // a reader must be able to tell a refusal from a delay, and the press was
    // refused rather than queued.
    const REFUSAL = 'nudge not sent: the agent is still working, so try again when it finishes'
    const saved = makeLoop({ message: 'edited, then refused' })
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      String(url).endsWith('/fire')
        ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: REFUSAL, code: 'session_busy' }) })
        : Promise.resolve({ ok: true, json: () => Promise.resolve(init?.method === 'PATCH' ? { ok: true, loop: saved } : { loop: null }) }),
    ) as unknown as typeof fetch)
    const { onChange, onOpenChange } = renderWith(makeLoop())
    // An edit, so there IS a save to precede the fire (a pristine form writes nothing).
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'edited, then refused' } })

    await act(async () => { fireEvent.click(triggerButton()!) })

    expect(screen.getByText(REFUSAL)).toBeTruthy()
    // The save landed and is handed up once; the fire's refusal does not undo it.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(saved)
    // A refusal must not report success by tearing the popover down.
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('names the object it clears once the loop is already stopped, and says the erase is final', async () => {
    // One button, two actions. On a live loop the press stops the loop and keeps
    // the record. On a stopped one there is nothing left to stop: the press
    // removes it, which is the only way the slot can watch something else -- a
    // stopped structured monitor blocks a re-arm until its row is gone.
    // "Clear record" failed a blind read (the popover shows nothing called a
    // "record"), so the label names the GOAL and the status reads Stopped rather
    // than the resumable-sounding Paused, and the help line under it names both
    // exits, because the erase has no undo (the removal of that line this PR
    // once made was dropped -- product owner, 2026-09-30). Both directions
    // asserted so this cannot just move the confusion.
    renderWith(makeLoop({ active: false }))
    const clear = screen.getByRole('button', { name: 'Clear stopped goal' })
    expect(clear).toBeTruthy()
    // Danger-coloured unconditionally, not on :hover -- a touch viewport never
    // produces hover, so a hover-only colour renders an irreversible erase
    // identically to the buttons beside it.
    expect(clear.className).toContain('text-danger')
    expect(screen.queryByRole('button', { name: 'Stop loop' })).toBeNull()
    expect(screen.getByTestId('auto-nudge-loop-paused').textContent).toBe('Stopped')
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent)
      .toBe('Start loop resumes this goal. Clear stopped goal removes it for good.')
    // The erase question renders only once the confirm is up.
    expect(screen.queryByTestId('auto-nudge-clear-question')).toBeNull()
    cleanup()
    // A running loop has NO Stop of either reading: Pause first, then Stop
    // (product owner, 2026-09-30), and no help line -- its exits are the
    // labelled controls.
    renderWith(makeLoop({ active: true }))
    expect(screen.queryByRole('button', { name: 'Stop loop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear stopped goal' })).toBeNull()
    expect(screen.queryByTestId('auto-nudge-stopped-help')).toBeNull()
    expect(screen.queryByTestId('auto-nudge-clear-question')).toBeNull()
  })

  it('asks before erasing a stopped goal: Cancel / Clear, with the question naming the goal on the schedule line', async () => {
    // Same two-step the monitor surface uses for its identical erase. The
    // confirm row is the one place this popover keeps VISIBLE text (product
    // owner, 2026-09-30 23:22Z: a confirm dialog, not the icon lane), and its
    // erase button is the bare verb -- "It's just clear" -- while the question
    // above the row names what is being cleared.
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') calls.push(String(url))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })
    }) as unknown as typeof fetch)

    renderWith(makeLoop({ active: false }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear stopped goal' })) })
    expect(calls).toEqual([])
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    // Two controls, not three: the confirmation replaces the primary CTA rather
    // than sitting beside it (website/AUTOSDE.yaml:230 caps a row at two). Its
    // back-out reads "Cancel", the same word the monitor surface's confirm uses
    // for the same act. Both are TEXT buttons, read here by their text.
    const row = screen.getByRole('button', { name: 'Cancel' }).parentElement!
    expect(Array.from(row.querySelectorAll('button')).map(b => b.textContent))
      .toEqual(['Cancel', 'Clear'])
    // And the question renders on the schedule line while the confirm is up:
    // the confirm row itself asks nothing.
    expect(screen.getByTestId('auto-nudge-clear-question').textContent)
      .toBe('Remove this goal for good?')
    // Cancelling erases nothing and restores the original control.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    expect(calls).toEqual([])
    expect(screen.getByRole('button', { name: 'Clear stopped goal' })).toBeTruthy()
    // Second press through the confirm performs it.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear stopped goal' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear' })) })
    expect(calls).toEqual(['/api/autonudge/l1?intent=clear'])
  })

  it('drops a primed confirmation when the record changes under the popover', async () => {
    // The popover re-renders from websocket state without closing, so another
    // tab can swap the record while a confirmation is primed: edit and restart
    // the same loop id, then a cycle cap stops it again. The press would then
    // erase a goal the confirmation never described, and the server sees no
    // mismatch because the record is inactive both times. Each of the three
    // changes that can arrive this way is asserted.
    // A harness that can swap the loop WITHOUT closing the popover, which is
    // what a websocket-driven re-render does.
    const Swappable = ({ next }: { next: Partial<AutoNudgeLoop> }) => {
      const [loop, setLoop] = useState<AutoNudgeLoop>(makeLoop({ active: false }))
      return (
        <>
          <button onClick={() => setLoop(current => ({ ...current, ...next }))}>swap</button>
          <AutoNudgePopover
            slotKey={SLOT}
            loop={loop}
            open={true}
            onOpenChange={() => {}}
            onChange={() => {}}
          />
        </>
      )
    }

    for (const next of [
      { id: 'l2' },
      { active: true },
      { message: 'a different goal entirely' },
    ]) {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
      render(
        <QueryClientProvider client={qc}>
          <Swappable next={next} />
        </QueryClientProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Clear stopped goal' }))
      expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'swap' }))
      expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
      cleanup()
    }
  })

  it('sends the pressed INTENT so a stale label cannot erase a record it did not mean to', async () => {
    // The server otherwise reads the operation off the record's state at arrival
    // time, so a "Stop loop" press against a record that went terminal in the
    // meantime would clear it. The intent travels with the request; the server
    // 409s on a mismatch. Stop is reachable from a PAUSED loop (a running one
    // is paused first), and it asks before it sends.
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') calls.push(String(url))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })
    }) as unknown as typeof fetch)

    renderWith(makeLoop({ active: false, stopped_reason: 'manual', next_due_ts: 0 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop loop' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear' })) })
    cleanup()
    renderWith(makeLoop({ active: false }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear stopped goal' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear' })) })

    expect(calls).toEqual([
      '/api/autonudge/l1?intent=stop',
      '/api/autonudge/l1?intent=clear',
    ])
  })

  it('sits on the schedule line, not in the action row (product owner, 2026-09-30: "Move trigger back to schedule line")', async () => {
    // The row below keeps to the two controls the rule allows
    // (`max-two-buttons-per-row`, website/AUTOSDE.yaml): a running loop's row
    // is Pause and Save, and Nudge now is the one button on the schedule line
    // it shortcuts. Asserted structurally and by ORDER, read by accessible
    // NAME: every control is icon-only, its name in `aria-label` (and `title`).
    renderWith(makeLoop())
    const row = screen.getByTestId('auto-nudge-actions')
    expect(Array.from(row.querySelectorAll('button')).map(b => b.getAttribute('aria-label')))
      .toEqual(['Pause loop', 'Save'])
    const schedule = screen.getByTestId('auto-nudge-schedule')
    expect(schedule.querySelectorAll('button')).toHaveLength(1)
    expect(schedule.contains(triggerButton())).toBe(true)
    expect(row.contains(triggerButton())).toBe(false)
    expect(schedule.textContent).toMatch(/Last fire:/)
    // Nothing destructive on a running loop's row or line.
    expect(screen.queryByRole('button', { name: 'Stop loop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear stopped goal' })).toBeNull()
  })
})

/** The rows by state (product owner, 2026-09-30: "Move trigger back to schedule
 *  line. Keep Pause and Save. Stop appears after hitting pause."). RUNNING:
 *  [Pause loop][Save], with Nudge now on the schedule line. PAUSED --
 *  `stopped_reason: 'manual'`, which is what a `PATCH active:false` records,
 *  and the only reason that reads "Paused": [Stop loop] .. [Resume loop and
 *  nudge now], and NO separate Save -- the one accented Play saves the edited
 *  fields, resumes and fires (product owner, 2026-09-30 23:22Z, against a
 *  "Save without resuming" control). STOPPED by a bound or a tool: the same
 *  shape, Stop reading "Clear stopped goal" and Play "Start loop and nudge
 *  now", the help line naming both exits. NO LOOP: one accented Play that
 *  creates the loop from the form and fires it. Every control is ICON-ONLY --
 *  a glyph, its name in `aria-label` and the same name in `title` as hover
 *  text, no visible label -- the dashboard's own toolbar convention (product
 *  owner, 2026-09-30 23:22Z); text stays only on the erase confirm's two
 *  buttons (Cancel / Clear). Every Stop asks before it erases; every fire on
 *  this surface persists the form first ("any Trigger implicitly calls the
 *  Save logic"). */
describe('AutoNudgePopover one-lane icon controls (Stop | Trigger Pause Save)', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  type Call = [string, { method?: string, body?: string }?]
  const calls = () => (fetch as unknown as { mock: { calls: Call[] } }).mock.calls
  const patchCalls = () => calls().filter(c => c[1]?.method === 'PATCH')
  const createCalls = () => calls().filter(c => String(c[0]) === '/api/autonudge' && c[1]?.method === 'POST')
  const fireCalls = (id = 'l1') => calls().filter(c => String(c[0]) === `/api/autonudge/${id}/fire`)
  const deleteCalls = () => calls().filter(c => c[1]?.method === 'DELETE').map(c => String(c[0]))
  const byLabel = (name: string) => screen.queryByRole('button', { name })
  /** The action rows' buttons in DOM order, by ACCESSIBLE NAME: the icon-only
   *  controls carry theirs in `aria-label`; the erase confirm's two text
   *  buttons (the one row with visible text) carry theirs as text. */
  const rowNames = () =>
    Array.from(screen.getByTestId('auto-nudge-actions').querySelectorAll('button'))
      .map(b => b.getAttribute('aria-label') ?? b.textContent)
  /** The Nudge-now button on the schedule line, by test id (its name is
   *  state-aware: "Nudge now" pristine, TRIGGER once the form is dirty). */
  const trigger = () => screen.queryByTestId('auto-nudge-trigger') as HTMLButtonElement | null
  /** Its name, read the icon-only way: `aria-label`, echoed as `title`, no text. */
  const triggerName = () => {
    const button = trigger()!
    expect(button.title).toBe(button.getAttribute('aria-label'))
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).toBeTruthy()
    return button.getAttribute('aria-label')
  }
  const PLAY_RESUME = 'Resume loop and nudge now'
  /** The STOPPED record's Play: revive on the same id, then fire. */
  const PLAY_START = 'Start loop and nudge now'
  /** The same two presses once the form is DIRTY: the press saves the edits
   *  first, and the name says so -- a reader of the pristine name on an edited
   *  form could not tell how the edit got kept (UX, A8). */
  const PLAY_RESUME_DIRTY = 'Save edits, resume loop and nudge now'
  const PLAY_START_DIRTY = 'Save edits, start loop and nudge now'
  /** Play under EITHER of its names on a record -- pristine, or dirty once a
   *  field differs -- for tests that edit the form and then reach for Play
   *  where the name is not the subject (its disablement is). */
  const resumePlay = () => (byLabel(PLAY_RESUME) ?? byLabel(PLAY_RESUME_DIRTY)) as HTMLButtonElement
  const startPlay = () => (byLabel(PLAY_START) ?? byLabel(PLAY_START_DIRTY)) as HTMLButtonElement
  /** The two names a SAVE control can carry; the dirty Play names its save
   *  too ("Save edits, ...") and must not count as one. */
  const SAVE_NAMES = /^(save|save without nudging)$/i
  /** Play with NO loop: main's own name -- it creates and starts the loop and
   *  does NOT fire (product owner, 2026-10-01 00:35Z). */
  const PLAY_CREATE = 'Start loop'
  const TRIGGER = 'Save edits and nudge now'
  /** The schedule line of a loop stopped on its wall-clock budget: the bound,
   *  then the field that holds it, where it is set (the arming call -- this form
   *  has no field for it) and the call that raises it (UX, A10). */
  const BUDGET_SPENT = 'Runtime budget spent — max_runtime_secs is set when the loop is armed (monitor_start); raise it with monitor_update'
  /** The running-at-cap countdown: TWO sentences -- what the tick does, then
   *  the bound and what lifts it -- so the line is not one run-together
   *  sentence (UX, A10). */
  const CAPPED_TICK_IN = /^Next cycle in .+ stops the loop\. Cycle cap reached: raise Max cycles\.$/
  const CAPPED_TICK_DUE = 'The next cycle stops the loop. Cycle cap reached: raise Max cycles.'
  const NUDGE_NOW = 'Nudge now'
  const SAVE_DIRTY = 'Save without nudging'

  /** Controlled `open`, as the real parent wires it, so "stays open" is a
   *  statement about the component and not about a fixed prop. */
  const renderWith = (loop: AutoNudgeLoop | null, onChange = vi.fn(), writeDisabled = false) => {
    const onOpenChange = vi.fn()
    const Harness = () => {
      const [open, setOpen] = useState(true)
      return (
        <AutoNudgePopover
          slotKey={SLOT}
          loop={loop}
          open={open}
          onOpenChange={v => { onOpenChange(v); setOpen(v) }}
          onChange={onChange}
          writeDisabled={writeDisabled}
        />
      )
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    )
    return { onChange, onOpenChange }
  }

  /** Answer the PATCH with the record the server would return, so the
   *  component's `onChange` hand-off can be asserted on real data. */
  function stubPatch(returned: AutoNudgeLoop) {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          init?.method === 'PATCH' && String(url) === '/api/autonudge/l1' ? { ok: true, loop: returned } : { loop: null },
        ),
      }),
    ) as unknown as typeof fetch)
  }

  type Refusal = { status: number, error: string }
  type FireAnswer = { ok: true, loop: AutoNudgeLoop } | { ok: false, status: number, error: string }
  /** Both legs of a Play or Trigger press: the WRITE (PATCH on `/api/autonudge/l1`,
   *  or the POST create on `/api/autonudge`) answers `written` (or a refusal),
   *  the fire route answers `fire`. Everything else (the crons read) stays inert. */
  function stubWriteThenFire(written: AutoNudgeLoop | Refusal, fire: FireAnswer) {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const isWrite = (init?.method === 'PATCH' && String(url) === '/api/autonudge/l1')
        || (init?.method === 'POST' && String(url) === '/api/autonudge')
      if (isWrite) {
        return 'status' in written
          ? Promise.resolve({ ok: false, status: written.status, json: () => Promise.resolve({ error: written.error }) })
          : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, loop: written }) })
      }
      if (/\/api\/autonudge\/[^/]+\/fire$/.test(String(url))) {
        return fire.ok
          ? Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, loop: fire.loop }) })
          : Promise.resolve({ ok: false, status: fire.status, json: () => Promise.resolve({ error: fire.error }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })
    }) as unknown as typeof fetch)
  }

  const paused = (over: Partial<AutoNudgeLoop> = {}) =>
    makeLoop({ active: false, stopped_reason: 'manual', next_due_ts: 0, ...over })
  const stoppedBy = (reason: string) => makeLoop({ active: false, next_due_ts: 0, stopped_reason: reason })
  const running = () => makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 300 })

  /** Every button in the action rows is ICON-ONLY (product owner, 2026-09-30
   *  23:22Z): a glyph, its name in `aria-label` -- the accessible name, which
   *  is what `icon-buttons-need-labels` asks for -- and the SAME name in
   *  `title`, the hover text the dashboard's toolbars teach; no visible label
   *  text. Asserted per button, so a control can neither lose its hover text
   *  nor grow a text label back. */
  function expectIconRow(expected: string[]) {
    expect(rowNames()).toEqual(expected)
    for (const name of expected) {
      const button = byLabel(name)!
      expect(button, `${name} is missing`).toBeTruthy()
      expect(button.getAttribute('aria-label')).toBe(name)
      expect(button.title, `${name} has no hover text`).toBe(name)
      expect(button.textContent, `${name} renders visible text`).toBe('')
      expect(button.querySelector('svg')).toBeTruthy()
    }
  }
  /** The erase confirm is the one row with VISIBLE text (a confirm dialog, not
   *  the icon lane): Cancel, and the bare verb Clear. */
  function expectConfirmRow() {
    expect(rowNames()).toEqual(['Cancel', 'Clear'])
    for (const name of ['Cancel', 'Clear']) {
      expect(byLabel(name)!.textContent).toBe(name)
    }
  }

  it('RUNNING: one row of two -- Pause and Save -- with Nudge now on the schedule line and NO Stop anywhere (product owner, 2026-09-30)', () => {
    renderWith(running())
    expectIconRow(['Pause loop', 'Save'])
    // Primary reads at rest, not on hover: a touch viewport never hovers.
    expect(byLabel('Save')!.className).toContain('bg-accent')
    // Stop is two steps away: Pause first. Complement assertion on both of its
    // readings, so a stale render could not hide one elsewhere in the tree.
    expect(byLabel('Stop loop')).toBeNull()
    expect(byLabel('Clear stopped goal')).toBeNull()
    expect(screen.queryByTestId('auto-nudge-save-row')).toBeNull()
    // Nudge now is the schedule line's one button, back where the pre-icon
    // popover kept it, and pristine it promises no save.
    const schedule = screen.getByTestId('auto-nudge-schedule')
    expect(schedule.querySelectorAll('button')).toHaveLength(1)
    expect(schedule.contains(trigger())).toBe(true)
    expect(triggerName()).toBe(NUDGE_NOW)
    expect(trigger()!.disabled).toBe(false)
    // An empty goal disables it exactly like Save: a dirty press would write it.
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: '  ' } })
    expect(triggerName()).toBe(TRIGGER)
    expect(trigger()!.disabled).toBe(true)
    expect((byLabel(SAVE_DIRTY) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    // The row's Save is named for what it does NOT do once the schedule line
    // offers "Save edits and nudge now": beside that button a bare "Save" left
    // a reader unable to tell the two writes apart. Both names flip on the
    // same reading (`formDirty`), so the pair can never disagree, and typing
    // the edit back restores both -- pristine, the row keeps its bare Save.
    // The names live in aria-label and title now; the flip is the same.
    renderWith(running())
    expect(byLabel('Save')).toBeTruthy()
    expect(byLabel(SAVE_DIRTY)).toBeNull()
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'active loop goal, edited' } })
    expect(triggerName()).toBe(TRIGGER)
    expectIconRow(['Pause loop', SAVE_DIRTY])
    expect(byLabel(SAVE_DIRTY)!.className).toContain('bg-accent')
    expect(byLabel('Save')).toBeNull()
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'active loop goal' } })
    expect(triggerName()).toBe(NUDGE_NOW)
    expectIconRow(['Pause loop', 'Save'])
    expect(byLabel(SAVE_DIRTY)).toBeNull()
    cleanup()
    // Already due: the press would do nothing, so Nudge now is disabled.
    renderWith(makeLoop({ next_due_ts: 1_700_000_000 }))
    expect(trigger()!.disabled).toBe(true)
  })

  it('Pause sends PATCH active:false and nothing else, keeps the popover open, and hands the paused record up', async () => {
    const pausedRecord = paused()
    stubPatch(pausedRecord)
    const { onChange, onOpenChange } = renderWith(running())

    await act(async () => { fireEvent.click(byLabel('Pause loop')!) })

    expect(patchCalls()).toHaveLength(1)
    const [url, init] = patchCalls()[0]
    expect(url).toBe('/api/autonudge/l1')
    // ONLY `active`: a pause must not also persist whatever sits in the
    // fields, and it must never fire anything.
    expect(JSON.parse(init!.body!)).toEqual({ active: false })
    expect(fireCalls()).toHaveLength(0)
    expect(onChange).toHaveBeenCalledWith(pausedRecord)
    // Like Trigger, and unlike Stop/Save: closing would drop an unsaved edit
    // in the textarea, and the state change is visible in place.
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('PAUSED: [Stop] .. [Play] -- one accented control, no Pause, no Nudge now, the status reads Paused; an edit brings NO separate Save (Play carries it)', () => {
    renderWith(paused())
    expectIconRow(['Stop loop', PLAY_RESUME])
    // Play IS the primary here, in the accent Save wears on a running loop;
    // Stop is danger at rest, pinned left of it.
    expect(byLabel(PLAY_RESUME)!.className).toContain('bg-accent')
    expect(byLabel('Stop loop')!.className).toContain('text-danger')
    expect(byLabel('Stop loop')!.compareDocumentPosition(byLabel(PLAY_RESUME)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(byLabel('Save')).toBeNull()
    expect(screen.queryByTestId('auto-nudge-save-row')).toBeNull()
    expect(byLabel('Pause loop')).toBeNull()
    expect(trigger()).toBeNull()
    // Complement assertion, not a bare negative on one node: a stale render
    // could leave the trigger somewhere else in the tree.
    expect(screen.queryAllByRole('button', { name: /nudge now/i })).toHaveLength(1)
    expect(screen.getByTestId('auto-nudge-loop-paused-manually').textContent).toBe('Paused')
    // No helper sentence and no question until the confirm is up: the status
    // word and the named controls say what this state is.
    expect(screen.queryByTestId('auto-nudge-clear-question')).toBeNull()
    expect(screen.queryByTestId('auto-nudge-stopped-help')).toBeNull()
    // NOT the stopped path: no "Stopped", no Clear stopped goal, no Start loop.
    expect(screen.queryByTestId('auto-nudge-loop-paused')).toBeNull()
    expect(byLabel('Clear stopped goal')).toBeNull()
    expect(byLabel(PLAY_START)).toBeNull()
    // An edit brings NO third control: the row stays Stop + Play, and Play
    // saves the edited fields, resumes and fires (see the EDITED-loop Play
    // test) -- the product owner's intent (2026-09-17), restated 2026-09-30
    // 23:22Z against a separate "Save without resuming" control. Complement
    // assertion on every Save reading, so no standalone Save hides anywhere.
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'edited while paused' } })
    // ... and Play now NAMES the save it will make (UX, A8).
    expectIconRow(['Stop loop', PLAY_RESUME_DIRTY])
    expect(screen.queryByTestId('auto-nudge-save-row')).toBeNull()
    expect(screen.queryAllByRole('button', { name: SAVE_NAMES })).toHaveLength(0)
    expect(byLabel(PLAY_RESUME_DIRTY)!.className).toContain('bg-accent')
    expect((byLabel(PLAY_RESUME_DIRTY) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Play on a PRISTINE paused loop is resume + run-now: PATCH {active:true} alone -- no field written back -- then POST fire, popover left open', async () => {
    const resumed = makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 90 })
    stubWriteThenFire(resumed, { ok: true, loop: resumed })
    const { onChange, onOpenChange } = renderWith(paused())

    await act(async () => { fireEvent.click(byLabel(PLAY_RESUME)!) })

    // Leg 1: the loop goes back to work. Nothing was edited, so the PATCH
    // carries `active` and NOTHING else: the fields seed on open and never
    // re-sync, and writing them back here would revert a revision that landed
    // while the loop sat paused -- what resumes is what the record holds.
    expect(patchCalls()).toHaveLength(1)
    expect(JSON.parse(patchCalls()[0][1]!.body!)).toEqual({ active: true })
    // Leg 2: the fire, with NO body, AFTER the PATCH -- `fire_now` refuses an
    // inactive loop with 409, so the order is load-bearing.
    expect(fireCalls()).toHaveLength(1)
    expect(fireCalls()[0][1]?.method).toBe('POST')
    expect(fireCalls()[0][1]?.body).toBeUndefined()
    const order = calls().map(c => `${c[1]?.method ?? 'GET'} ${c[0]}`)
    expect(order.indexOf('PATCH /api/autonudge/l1')).toBeLessThan(order.indexOf('POST /api/autonudge/l1/fire'))
    // ONE hand-off, after the fire: the resumed record with the due reading the
    // fire arms. Not the resumed record first and the due one second -- the
    // bridge's identity guard drops a second hand-off from the pressed render.
    expect(onChange).toHaveBeenCalledTimes(1)
    const due = onChange.mock.calls[0][0] as AutoNudgeLoop
    expect(due).toMatchObject({ id: 'l1', active: true })
    expect(Math.abs(due.next_due_ts - Date.now() / 1000)).toBeLessThan(5)
    // Stays open: the outcome is visible in place (Pause is back, the schedule
    // line reads due), and a fire refusal needs somewhere to land.
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it.each([
    ['paused', () => paused(), PLAY_RESUME, PLAY_RESUME_DIRTY],
    ['stopped', () => stoppedBy('cycle_cap'), PLAY_START, PLAY_START_DIRTY],
  ])('Play on an EDITED %s loop sends the form as it reads with active:true: an edited goal, interval and cap ride the resume, then the fire', async (_state, loop, playPristine, play) => {
    // The other half of the rule: an edit IS saved by Play -- pause, edit the
    // goal, interval or cap, press Play, no separate Save -- and a cap raised
    // in the form travels with the revive instead of the loop re-stopping a
    // tick later on the spent cap.
    const resumed = makeLoop({ message: 'edited before play', idle_secs: 120, max_cycles: 50 })
    stubWriteThenFire(resumed, { ok: true, loop: resumed })
    renderWith(loop())
    // Pristine, the name promises no save; once a field differs it names the
    // save first, on the same `formDirty` reading as Nudge now and Save, so a
    // reader of the edited form can tell how the edit gets kept.
    expect(byLabel(playPristine)).toBeTruthy()
    expect(byLabel(play)).toBeNull()
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'edited before play' } })
    fireEvent.change(screen.getByLabelText('Seconds between nudges'), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '50' } })
    expect(byLabel(playPristine)).toBeNull()
    expect(byLabel(play)!.getAttribute('title')).toBe(play)

    await act(async () => { fireEvent.click(byLabel(play)!) })

    expect(patchCalls()).toHaveLength(1)
    expect(JSON.parse(patchCalls()[0][1]!.body!)).toEqual({ message: 'edited before play', idle_secs: 120, max_cycles: 50, active: true })
    expect(fireCalls()).toHaveLength(1)
    const order = calls().map(c => `${c[1]?.method ?? 'GET'} ${c[0]}`)
    expect(order.indexOf('PATCH /api/autonudge/l1')).toBeLessThan(order.indexOf('POST /api/autonudge/l1/fire'))
  })

  it('a 409 on the fire leg leaves the loop RESUMED and shows the refusal inline; nothing is rolled back', async () => {
    const REFUSAL = 'loop is already firing'
    const resumed = makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 90 })
    stubWriteThenFire(resumed, { ok: false, status: 409, error: REFUSAL })
    const { onChange, onOpenChange } = renderWith(paused())

    await act(async () => { fireEvent.click(byLabel(PLAY_RESUME)!) })

    expect(patchCalls()).toHaveLength(1)
    expect(fireCalls()).toHaveLength(1)
    // The resume stands: the record handed up is the resumed one, once.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(resumed)
    expect(screen.getByText(REFUSAL)).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('a refused resume fires nothing: no POST follows a failed PATCH', async () => {
    const REFUSAL = 'audit log unavailable — nudge loop not updated'
    stubWriteThenFire({ status: 503, error: REFUSAL }, { ok: true, loop: makeLoop() })
    const { onChange } = renderWith(paused())

    await act(async () => { fireEvent.click(byLabel(PLAY_RESUME)!) })

    expect(patchCalls()).toHaveLength(1)
    expect(fireCalls()).toHaveLength(0)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(REFUSAL)).toBeTruthy()
  })

  it.each([
    ['cycle_cap', 'a spent cycle cap'],
    ['runtime_budget', 'a spent wall-clock budget'],
    ['approval_stalled', 'an approval stall'],
    ['autonudge_stop', 'the autonudge_stop tombstone'],
    ['', 'a stop with no recorded reason'],
  ])('STOPPED by %s keeps the same shape -- Stop is the two-step erase, Play reads Start loop, the help line names both exits, no Save until an edit -- and still says Stopped, never Paused', async (reason) => {
    renderWith(stoppedBy(reason))
    expect(screen.getByTestId('auto-nudge-loop-paused').textContent).toBe('Stopped')
    // The help names both exits -- except while a bound holds Play: the
    // budget-stopped loop's Play is switched off for good, so its help keeps
    // only the Clear sentence (the bound line above names the budget). The
    // `stoppedBy` fixture's cap is unspent, so the cycle_cap row has a live
    // Play and the full help.
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent)
      .toBe(reason === 'runtime_budget'
        ? 'Clear stopped goal removes it for good.'
        : 'Start loop resumes this goal. Clear stopped goal removes it for good.')
    expect(screen.queryByTestId('auto-nudge-clear-question')).toBeNull()
    expectIconRow(['Clear stopped goal', PLAY_START])
    expect(byLabel(PLAY_START)!.className).toContain('bg-accent')
    expect(byLabel('Clear stopped goal')!.className).toContain('text-danger')
    // None of the running/paused-only controls leak into a stopped loop, and
    // the status is not the resumable one.
    for (const name of ['Pause loop', PLAY_RESUME, TRIGGER, NUDGE_NOW, 'Stop loop', 'Save']) {
      expect(byLabel(name), `${name} rendered on a stopped loop`).toBeNull()
    }
    expect(trigger()).toBeNull()
    expect(screen.queryByTestId('auto-nudge-loop-paused-manually')).toBeNull()

    // Stop here is the erase of the retained record, and it asks first: the
    // rows become the confirm (Cancel / Clear -- the one row with visible
    // text), the help line becomes the question, and nothing has been sent yet.
    await act(async () => { fireEvent.click(byLabel('Clear stopped goal')!) })
    expect(deleteCalls()).toEqual([])
    expectConfirmRow()
    expect(screen.getByTestId('auto-nudge-clear-question').textContent).toBe('Remove this goal for good?')
    expect(screen.queryByTestId('auto-nudge-stopped-help')).toBeNull()
    await act(async () => { fireEvent.click(byLabel('Cancel')!) })
    expectIconRow(['Clear stopped goal', PLAY_START])
    expect(screen.getByTestId('auto-nudge-stopped-help')).toBeTruthy()

    // An edit brings no Save here either, as on a paused loop: the raised cap
    // that lifts a bound rides the one accented Play, which writes it with
    // the revive and fires (product owner, 2026-09-30 23:22Z).
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '9' } })
    expectIconRow(['Clear stopped goal', PLAY_START_DIRTY])
    expect(screen.queryByTestId('auto-nudge-save-row')).toBeNull()
    expect(screen.queryAllByRole('button', { name: SAVE_NAMES })).toHaveLength(0)
  })

  it('a record that never carried stopped_reason at all is still Stopped, never Paused', () => {
    // `undefined` is "not known here", and an unknown reason must fail toward
    // the non-resumable reading: only an explicit `manual` earns Resume.
    const loop = makeLoop({ active: false, next_due_ts: 0 })
    delete (loop as Partial<AutoNudgeLoop>).stopped_reason
    renderWith(loop)
    expect(screen.getByTestId('auto-nudge-loop-paused').textContent).toBe('Stopped')
    expect(byLabel(PLAY_RESUME)).toBeNull()
    expect(byLabel(PLAY_START)).toBeTruthy()
  })

  it('NO LOOP: a single accented Play, named Start loop, that creates and starts the loop from the form and does NOT fire -- no Stop, no Save', async () => {
    const created = makeLoop({ id: 'l-new', message: 'brand new goal', idle_secs: 60, max_cycles: 0, cycle_count: 0, next_due_ts: Math.floor(Date.now() / 1000) + 60 })
    stubWriteThenFire(created, { ok: true, loop: created })
    const { onChange, onOpenChange } = renderWith(null)
    expectIconRow([PLAY_CREATE])
    // The accent today's "Start loop" text button wore, so the one control on
    // an empty popover still reads as the primary action. Its name is main's
    // "Start loop", not the stopped record's "Start loop and nudge now": this
    // press does not nudge (product owner, 2026-10-01 00:35Z).
    expect(byLabel(PLAY_CREATE)!.className).toContain('bg-accent')
    for (const name of ['Stop loop', 'Clear stopped goal', 'Save', 'Pause loop', PLAY_RESUME, PLAY_START, TRIGGER, NUDGE_NOW]) {
      expect(byLabel(name), `${name} rendered with no loop`).toBeNull()
    }
    expect(trigger()).toBeNull()
    expect(screen.queryByTestId('auto-nudge-schedule')).toBeNull()
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'brand new goal' } })

    await act(async () => { fireEvent.click(byLabel(PLAY_CREATE)!) })

    // Today's create, from the form -- and NOTHING else: no fire follows a
    // create (product owner, 2026-10-01 00:35Z). The first nudge goes out at
    // the interval, or when the user presses Nudge now on the running loop,
    // exactly main's Start loop -> Trigger nudge flow. Complement assertion
    // on every fire route, not only the created id's.
    expect(createCalls()).toHaveLength(1)
    expect(JSON.parse(createCalls()[0][1]!.body!)).toEqual({ slot_key: SLOT, message: 'brand new goal', idle_secs: 60, max_cycles: 0 })
    expect(calls().filter(c => /\/fire$/.test(String(c[0])))).toHaveLength(0)
    // ONE hand-off: the created record as the server returned it, deadline
    // and all -- the parent re-keys the popover on it, and with no fire leg
    // behind the hand-off there is nothing a remount could lose.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(created)
    // Stays open like every other control that changes the run state: the
    // created loop's row (Pause, Save) and its countdown appear in place.
    // Only Save closes the popover.
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('a refused create hands nothing up and shows the refusal inline; no fire is attempted', async () => {
    const REFUSAL = 'audit log unavailable — nudge loop not armed'
    stubWriteThenFire({ status: 503, error: REFUSAL }, { ok: true, loop: makeLoop({ id: 'l-new' }) })
    const { onChange, onOpenChange } = renderWith(null)

    await act(async () => { fireEvent.click(byLabel(PLAY_CREATE)!) })

    expect(createCalls()).toHaveLength(1)
    expect(calls().filter(c => /\/fire$/.test(String(c[0])))).toHaveLength(0)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(REFUSAL)).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('the no-loop Play is disabled on an empty goal, like the Save it replaces', () => {
    renderWith(null)
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: '   ' } })
    expect((byLabel(PLAY_CREATE) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Save on a running loop: a plain PATCH of the fields, never active, never a fire, and it closes the popover as it always did', async () => {
    const saved = makeLoop({ message: 'edited' })
    stubPatch(saved)
    const { onChange, onOpenChange } = renderWith(running())
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'edited' } })

    await act(async () => { fireEvent.click(byLabel(SAVE_DIRTY)!) })

    expect(patchCalls()).toHaveLength(1)
    const body = JSON.parse(patchCalls()[0][1]!.body!)
    // The edited field only: the untouched interval and cap are not written
    // back (see the concurrent-revision test below).
    expect(body).toEqual({ message: 'edited' })
    // Load-bearing both ways: `active: true` would silently revive a loop
    // another tab paused between render and press, and `active: false` would
    // pause a running one.
    expect(body).not.toHaveProperty('active')
    expect(fireCalls()).toHaveLength(0)
    expect(onChange).toHaveBeenCalledWith(saved)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Save writes ONLY the field the user edited, so a cap another writer raised while the popover sat open survives the save', async () => {
    // The fields seed from the record on the open edge and never re-sync, so
    // a revision that lands while the popover sits open -- a `monitor_update`
    // from the nudged agent, another tab's save -- is not in the form. A save
    // that sent every field would write the seeded cap (3) back over the
    // raised one (10): the edit the user made was to the goal alone.
    const opened = running()
    const revisedElsewhere = { ...opened, max_cycles: 10 }
    const saved = { ...revisedElsewhere, message: 'edited' }
    stubPatch(saved)
    const onChange = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const view = (loop: AutoNudgeLoop) => (
      <QueryClientProvider client={qc}>
        <AutoNudgePopover slotKey={SLOT} loop={loop} open={true} onOpenChange={() => {}} onChange={onChange} />
      </QueryClientProvider>
    )
    const { rerender } = render(view(opened))
    // The websocket frame carrying the other writer's revision.
    rerender(view(revisedElsewhere))
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'edited' } })

    await act(async () => { fireEvent.click(byLabel(SAVE_DIRTY)!) })

    expect(patchCalls()).toHaveLength(1)
    // Exactly the edited field: no `idle_secs`, no `max_cycles`, no `active`.
    expect(JSON.parse(patchCalls()[0][1]!.body!)).toEqual({ message: 'edited' })
    expect(onChange).toHaveBeenCalledWith(saved)
  })

  it.each([
    ['Trigger on a running loop', () => running(), TRIGGER, {}],
    ['Play on a paused loop', () => paused(), PLAY_RESUME_DIRTY, { active: true }],
  ])('%s writes only the edited field: an untouched field is never written back', async (_control, loop, label, extra) => {
    // Same rule as Save, on the write leg of the fire controls: a field the
    // user did not touch is not in the body, so it cannot overwrite a revision
    // that landed on it. Play still carries its `active: true`.
    const written = makeLoop({ idle_secs: 45 })
    stubWriteThenFire(written, { ok: true, loop: written })
    renderWith(loop())
    fireEvent.change(screen.getByLabelText('Seconds between nudges'), { target: { value: '45' } })

    await act(async () => { fireEvent.click(byLabel(label)!) })

    expect(patchCalls()).toHaveLength(1)
    expect(JSON.parse(patchCalls()[0][1]!.body!)).toEqual({ idle_secs: 45, ...extra })
    expect(fireCalls()).toHaveLength(1)
  })

  it('Stop is two steps from a running loop: none on its row (Pause is the way); on a paused loop it asks first and the stop intent travels only after the confirm', async () => {
    // Nothing on a running loop's row erases the goal, in one press or two:
    // the destructive control appears once the loop is paused (product owner,
    // 2026-09-30: "Stop appears after hitting pause"). Complement assertion on
    // every button in the tree, not a bare negative on one name.
    renderWith(running())
    expect(screen.getAllByRole('button').filter(b => /stop loop|clear/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))).toHaveLength(0)
    expect(deleteCalls()).toEqual([])
    cleanup()

    // A paused loop exists to KEEP its goal, and its Stop removes that goal
    // for good -- so one press asks, exactly as the stopped state's erase
    // does: the rows become Cancel / Clear, the question
    // appears on the schedule line, and nothing has been sent.
    renderWith(paused())
    await act(async () => { fireEvent.click(byLabel('Stop loop')!) })
    expect(deleteCalls()).toHaveLength(0)
    expectConfirmRow()
    expect(screen.getByTestId('auto-nudge-clear-question').textContent).toBe('Remove this goal for good?')
    // Cancel puts the pair back, Play included, takes the question with it,
    // and still nothing was sent.
    await act(async () => { fireEvent.click(byLabel('Cancel')!) })
    expect(rowNames()).toEqual(['Stop loop', PLAY_RESUME])
    expect(screen.queryByTestId('auto-nudge-clear-question')).toBeNull()
    expect(deleteCalls()).toHaveLength(0)
    // The confirmed press carries the intent the label meant: a paused loop is
    // a live goal being STOPPED, not a terminal record being cleared, so a
    // record that went terminal in between draws the server's 409 instead of
    // a silent erase.
    await act(async () => { fireEvent.click(byLabel('Stop loop')!) })
    await act(async () => { fireEvent.click(byLabel('Clear')!) })
    expect(deleteCalls()).toEqual(['/api/autonudge/l1?intent=stop'])
    cleanup()

    renderWith(stoppedBy('cycle_cap'))
    await act(async () => { fireEvent.click(byLabel('Clear stopped goal')!) })
    await act(async () => { fireEvent.click(byLabel('Clear')!) })
    expect(deleteCalls().at(-1)).toBe('/api/autonudge/l1?intent=clear')
  })

  it('surfaces a refused pause inline and keeps the popover open', async () => {
    const REFUSAL = 'audit log unavailable — nudge loop not updated'
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: REFUSAL }) })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) }),
    ) as unknown as typeof fetch)
    const { onChange, onOpenChange } = renderWith(makeLoop())

    await act(async () => { fireEvent.click(byLabel('Pause loop')!) })

    expect(screen.getByText(REFUSAL)).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('while writes are disabled a RUNNING loop offers only Stop, behind its confirm (the two-step route is dead with Pause); Play stays dead, Stop live, on a paused one', async () => {
    // Every control that writes the record follows one gate -- and every fire
    // writes first, so Nudge now and Play are in it. Pause is a write too, so
    // the two-step Stop cannot be reached that way; a stale running record in
    // a crew or member session could otherwise never be cleared from here. So
    // that row holds the one control that still works -- Stop, a DELETE --
    // behind the same confirm every other Stop asks first, and the dead Pause
    // and Save are not drawn beside it (the reason line says why writes are
    // off). Not a one-press erase even here.
    renderWith(running(), vi.fn(), true)
    expectIconRow(['Stop loop'])
    expect(byLabel('Pause loop')).toBeNull()
    expect(byLabel('Save')).toBeNull()
    expect(trigger()!.disabled).toBe(true)
    expect((byLabel('Stop loop') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(byLabel('Stop loop')!) })
    expect(deleteCalls()).toEqual([])
    expectConfirmRow()
    // The question takes the schedule line's button slot while the confirm is up.
    expect(screen.getByTestId('auto-nudge-clear-question').textContent).toBe('Remove this goal for good?')
    expect(trigger()).toBeNull()
    await act(async () => { fireEvent.click(byLabel('Clear')!) })
    // A running loop is a live goal being stopped: the stop intent travels.
    expect(deleteCalls()).toEqual(['/api/autonudge/l1?intent=stop'])
    cleanup()
    renderWith(paused(), vi.fn(), true)
    expect((byLabel(PLAY_RESUME) as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel('Stop loop') as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    renderWith(null, vi.fn(), true)
    expect((byLabel(PLAY_CREATE) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a loop stopped on its cycle cap keeps Play disabled until the cap in the form clears the bound the timer would reject it on', () => {
    // Play sends `active: true` and then fires, but the fire runs through the
    // timer, whose cap check comes first: with `cycle_count >= max_cycles` it
    // deactivates the loop again (`cycle_cap`) before any nudge goes out. A
    // Play that cannot fire is disabled -- the existing disabled state, no new
    // copy -- and comes back the moment the form's cap is one the timer would
    // let through: above the count, or 0 (no cap). The bound is the RECORD's
    // (its own cap, reached); the form's cap can only LIFT it, because Play
    // writes that field on the way to the fire. The schedule line says which
    // bound holds the loop and what lifts it, and keeps saying so while the
    // record stands, whatever the form holds.
    renderWith(makeLoop({ active: false, next_due_ts: 0, stopped_reason: 'cycle_cap', cycle_count: 3, max_cycles: 3 }))
    const play = () => startPlay()
    expect(play().disabled).toBe(true)
    expect(screen.getByTestId('auto-nudge-loop-paused').textContent).toBe('Stopped')
    expect(screen.getByTestId('auto-nudge-bound-reason').textContent).toBe('Cycle cap reached — raise Max cycles')
    // While the bound holds Play, the help line must not promise that "Start
    // loop resumes this goal" above a switched-off Start: the bound line
    // already says what lifts it, so the help keeps only the Clear sentence.
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent).toBe('Clear stopped goal removes it for good.')
    // An edit that leaves the bound spent changes nothing.
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '2' } })
    expect(play().disabled).toBe(true)
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent).toBe('Clear stopped goal removes it for good.')
    // Editing another field does not clear a spent cap either.
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'a new goal' } })
    expect(play().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '5' } })
    expect(play().disabled).toBe(false)
    expect(screen.getByTestId('auto-nudge-bound-reason').textContent).toBe('Cycle cap reached — raise Max cycles')
    // Play is live again, so the sentence that describes it is true again.
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent).toBe('Start loop resumes this goal. Clear stopped goal removes it for good.')
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '0' } })
    expect(play().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '3' } })
    expect(play().disabled).toBe(true)
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent).toBe('Clear stopped goal removes it for good.')
    // Stop (the erase) stays reachable: a record nobody can revive from here
    // must still be clearable.
    expect((byLabel('Clear stopped goal') as HTMLButtonElement).disabled).toBe(false)
  })

  it('the bound on the schedule line follows the RECORD, not the reason string: a cycle-cap stop whose cap was raised since shows no bound and Play is live', () => {
    // Another writer (a `monitor_update`, another tab) can raise `max_cycles`
    // on a record the timer stopped on `cycle_cap`. The count is then under
    // the cap, the timer would let a revive through, and a line still reading
    // "cap reached" would be false -- so both the gate and the line read the
    // record's own numbers.
    renderWith(makeLoop({ active: false, next_due_ts: 0, stopped_reason: 'cycle_cap', cycle_count: 3, max_cycles: 5 }))
    expect((byLabel(PLAY_START) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('auto-nudge-loop-paused').textContent).toBe('Stopped')
    expect(screen.queryByTestId('auto-nudge-bound-reason')).toBeNull()
  })

  it('a loop stopped on its wall-clock budget says so on the schedule line, and the line stays whatever the form holds', () => {
    renderWith(stoppedBy('runtime_budget'))
    expect(screen.getByTestId('auto-nudge-loop-paused').textContent).toBe('Stopped')
    // The line names the budget's field, where it is set (the arming call --
    // this form has no field for it) and the call that raises it, so a reader
    // held here is told what the budget is and how to refill it.
    expect(screen.getByTestId('auto-nudge-bound-reason').textContent).toBe(BUDGET_SPENT)
    // Nothing in this form lifts the budget, so the resume sentence is never
    // true here: the help keeps only the Clear sentence.
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent).toBe('Clear stopped goal removes it for good.')
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '0' } })
    expect(screen.getByTestId('auto-nudge-bound-reason').textContent).toBe(BUDGET_SPENT)
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent).toBe('Clear stopped goal removes it for good.')
  })

  it.each([
    ['an approval stall', () => stoppedBy('approval_stalled')],
    ['a tool stop', () => stoppedBy('autonudge_stop')],
    ['a stop with no recorded reason', () => stoppedBy('')],
    ['a manual pause', () => paused()],
  ])('no bound line after %s with the cap unspent: only a bound that holds Play is named', (_what, loop) => {
    renderWith(loop())
    expect(screen.queryByTestId('auto-nudge-bound-reason')).toBeNull()
  })

  it.each([
    ['an approval stall', () => stoppedBy('approval_stalled')],
    ['a tool stop', () => stoppedBy('autonudge_stop')],
    ['a stop with no recorded reason', () => stoppedBy('')],
  ])('after %s Play is live, so the stopped help keeps its resume sentence', (_what, loop) => {
    renderWith(loop())
    expect(screen.getByTestId('auto-nudge-stopped-help').textContent).toBe('Start loop resumes this goal. Clear stopped goal removes it for good.')
  })

  it('a PAUSED loop whose count sits at its cap names the bound beside Paused, since its Play is held by it too', () => {
    renderWith(paused({ cycle_count: 3, max_cycles: 3 }))
    expect(screen.getByTestId('auto-nudge-loop-paused-manually').textContent).toBe('Paused')
    expect(screen.getByTestId('auto-nudge-bound-reason').textContent).toBe('Cycle cap reached — raise Max cycles')
    expect((byLabel(PLAY_RESUME) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a PAUSED loop whose count sits at its cap is the same timer rejection: Resume waits for a raised cap too', () => {
    // The timer's cap check reads the record, not the stop reason: a loop
    // paused by hand with `cycle_count` already at `max_cycles` would resume,
    // then deactivate on `cycle_cap` before the nudge. Same rule, same field.
    renderWith(paused({ cycle_count: 3, max_cycles: 3 }))
    const play = () => resumePlay()
    expect(play().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '4' } })
    expect(play().disabled).toBe(false)
    expect((byLabel('Stop loop') as HTMLButtonElement).disabled).toBe(false)
  })

  it('a loop stopped on its wall-clock budget has no Play here: nothing in this form can clear that bound', () => {
    // `runtime_budget` is measured from the record's creation against
    // `max_runtime_secs`, and neither is a field of this popover, so a revive
    // is rejected by the timer every time. Editing the goal or the cap does
    // not change that.
    renderWith(stoppedBy('runtime_budget'))
    const play = () => startPlay()
    expect(play().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'a new goal' } })
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '0' } })
    expect(play().disabled).toBe(true)
    expect((byLabel('Clear stopped goal') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Pause stays LIVE on a RUNNING loop whose count sits at its cap, the schedule line names the bound, and the pause is sent -- Pause is the route to Stop', async () => {
    // After the capping fire the loop stays active until its next tick, when
    // the timer's cap check stops it as `cycle_cap` -- up to a whole
    // `idle_secs` (24h at most). Stop is two steps away (Pause first), so a
    // Pause that is dead here would leave the owner NO working control on the
    // running row, and nothing said why. So Pause stays live: the paused record
    // it produces still reads its bound off its own numbers (`cycle_count >=
    // max_cycles`), so "Paused · Cycle cap reached" is what comes back and Play
    // stays held until the cap is raised -- nothing is lost by the pause. The
    // cap reading renders on the running loop too, beside the countdown, so the
    // one interval the loop sits at its cap is not silent either. The budget
    // reason keeps its gate (see below): nothing in this form clears it.
    const pausedAtCap = paused({ cycle_count: 3, max_cycles: 3 })
    stubPatch(pausedAtCap)
    const { onChange } = renderWith(makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 300, cycle_count: 3, max_cycles: 3 }))
    const pause = () => byLabel('Pause loop') as HTMLButtonElement
    expect(pause().disabled).toBe(false)
    // The line says what the tick it counts to DOES at a spent cap: the timer's
    // cap check runs before any nudge and deactivates the loop (`cycle_cap`),
    // so "Next cycle in 24s · Cycle cap reached" read as a contradiction --
    // a countdown to a nudge that will not happen. Two sentences -- what the
    // tick does, then the bound and what lifts it -- and no separate bound
    // span on the running line.
    const cappedTick = () => screen.getByTestId('auto-nudge-capped-tick').textContent
    expect(cappedTick()).toMatch(CAPPED_TICK_IN)
    expect(screen.queryByTestId('auto-nudge-bound-reason')).toBeNull()
    // ONE countdown: the capped line is the countdown, not a countdown beside it.
    expect(screen.getByTestId('auto-nudge-schedule').textContent!.match(/Next cycle in/g)).toHaveLength(1)
    // The line is about the record: typing a cap moves nothing here.
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '9' } })
    expect(cappedTick()).toMatch(CAPPED_TICK_IN)
    expect(pause().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(pause()) })
    expect(patchCalls()).toHaveLength(1)
    expect(JSON.parse(patchCalls()[0][1]!.body!)).toEqual({ active: false })
    expect(onChange).toHaveBeenCalledWith(pausedAtCap)
    // A tick already due at the cap: the same two sentences without a time.
    cleanup()
    renderWith(makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) - 5, cycle_count: 3, max_cycles: 3 }))
    expect(cappedTick()).toBe(CAPPED_TICK_DUE)
    expect(screen.getByTestId('auto-nudge-schedule').textContent).not.toMatch(/Next cycle due/)
    // No bound, no line: a running loop under its cap, or uncapped, reads its
    // countdown alone.
    cleanup()
    renderWith(makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 300, cycle_count: 3, max_cycles: 5 }))
    expect(pause().disabled).toBe(false)
    expect(screen.queryByTestId('auto-nudge-bound-reason')).toBeNull()
    expect(screen.queryByTestId('auto-nudge-capped-tick')).toBeNull()
    expect(screen.getByTestId('auto-nudge-schedule').textContent).toMatch(/Next cycle in/)
    cleanup()
    renderWith(makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 300, cycle_count: 3, max_cycles: 0 }))
    expect(pause().disabled).toBe(false)
    expect(screen.queryByTestId('auto-nudge-bound-reason')).toBeNull()
  })

  it('an unsaved cap below the count spends NO bound: on a running uncapped loop, typing a lower cap leaves Pause live and the pause is sent', async () => {
    // The finding's sequence: `max_cycles: 0` on the record, five cycles done,
    // `3` typed into the field. Nothing has been written -- the field governs
    // what the next Save sends, not what the loop is bound by -- so Pause
    // stays enabled and its press sends the pause. Read off the persisted
    // record, a bound the input alone describes does not exist.
    stubPatch(paused({ max_cycles: 0, cycle_count: 5 }))
    const { onChange } = renderWith(makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 300, cycle_count: 5, max_cycles: 0 }))
    const pause = () => byLabel('Pause loop') as HTMLButtonElement
    expect(pause().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '3' } })
    expect(pause().disabled).toBe(false)
    await act(async () => { fireEvent.click(pause()) })
    expect(patchCalls()).toHaveLength(1)
    expect(JSON.parse(patchCalls()[0][1]!.body!)).toEqual({ active: false })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('an unsaved cap below the count spends no bound for Play either: on a stopped uncapped loop, typing a lower cap leaves Play live', () => {
    // Same rule on the revive: the persisted cap is 0, so no bound holds the
    // record. The typed cap rides Play's own write, and whether THAT cap stops
    // the loop is the service's call on the fire (it answers with the stopped
    // record and the line below says why) -- the same footing Trigger has on a
    // running loop. The input can lift a spent cap for Play; it never spends one.
    renderWith(makeLoop({ active: false, next_due_ts: 0, stopped_reason: 'approval_stalled', cycle_count: 5, max_cycles: 0 }))
    const play = () => startPlay()
    expect(play().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '3' } })
    expect(play().disabled).toBe(false)
    expect(screen.queryByTestId('auto-nudge-bound-reason')).toBeNull()
  })

  it('Pause is disabled on a record that carries the wall-clock budget reason, whatever the form holds', async () => {
    // The frame contract lets a record carry `runtime_budget` beside
    // `active`; nothing in this form clears that bound, so a pause written
    // over it could only hide it. Nothing is sent.
    stubPatch(paused())
    renderWith(makeLoop({ next_due_ts: Math.floor(Date.now() / 1000) + 300, stopped_reason: 'runtime_budget' }))
    const pause = () => byLabel('Pause loop') as HTMLButtonElement
    expect(pause().disabled).toBe(true)
    await act(async () => { fireEvent.click(pause()) })
    expect(patchCalls()).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'a new goal' } })
    fireEvent.change(screen.getByLabelText('Max cycles (0 = infinite)'), { target: { value: '0' } })
    expect(pause().disabled).toBe(true)
    expect((byLabel(SAVE_DIRTY) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a Pause the server answers with the bound that stopped the loop first hands THAT record up, so the popover reads Stopped', async () => {
    // The race this surface cannot see: the frame carrying a `runtime_budget`
    // stop has not arrived when Pause is pressed. The service keeps the bound
    // on a reasonless deactivation of an inactive loop and returns the record
    // as it stands; the hand-off carries it, and the paused reading never
    // shows.
    const stopped = stoppedBy('runtime_budget')
    stubPatch(stopped)
    const { onChange } = renderWith(running())
    await act(async () => { fireEvent.click(byLabel('Pause loop')!) })
    expect(patchCalls()).toHaveLength(1)
    expect(onChange).toHaveBeenCalledWith(stopped)
  })

  it.each([
    ['a manual pause', () => paused(), PLAY_RESUME],
    ['an approval stall', () => stoppedBy('approval_stalled'), PLAY_START],
    ['a tool stop', () => stoppedBy('autonudge_stop'), PLAY_START],
  ])('Play stays enabled after %s with the cap unspent: a revive clears those, so the timer fires', (_reason, loop, play) => {
    // Only the two BOUNDS are re-checked by the timer on the way to a fire; a
    // revive clears the stall flag and a tool's tombstone.
    renderWith(loop())
    expect((byLabel(play) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('AutoNudgePopover {{STOP_FILE}} help line (#10458)', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTests()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ loop: null }) })) as unknown as typeof fetch)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const goalBox = () => screen.getByPlaceholderText(/Describe what you want the agent to accomplish/i) as HTMLTextAreaElement
  const helpLine = () => screen.queryByText(/is filled in when each nudge is sent/i)
  const noneLine = () => screen.queryByText(/armed without a stop file/i)

  it('explains the raw token under the default template and names it verbatim', () => {
    renderPopover(null)
    // The stored template is untouched: the server substitutes the token at
    // fire time, so the textarea must still carry it.
    expect(goalBox().value).toContain(STOP_FILE_TOKEN)
    const help = helpLine()
    expect(help, 'no help line rendered under the goal textarea').toBeTruthy()
    // The token is interpolated as text, not left as an i18next placeholder
    // that would have been dropped or rendered as `{{token}}`.
    expect(help!.textContent).toContain(STOP_FILE_TOKEN)
    expect(help!.textContent).not.toContain('{{token}}')
    // Screen readers get the same explanation as sighted readers.
    expect(goalBox().getAttribute('aria-describedby')).toBe(help!.id)
  })

  it('does not render the help line for a goal that carries no token', () => {
    renderPopover(null)
    fireEvent.change(goalBox(), { target: { value: 'Ship the BYOA gate harness' } })
    expect(helpLine()).toBeNull()
    expect(noneLine()).toBeNull()
    expect(goalBox().hasAttribute('aria-describedby')).toBe(false)
    // Typing the token back brings the line back: it tracks the live text, not the template.
    fireEvent.change(goalBox(), { target: { value: `Do the thing. Halt via ${STOP_FILE_TOKEN}` } })
    expect(helpLine()).toBeTruthy()
  })

  it('Start loop posts the message with the token intact (display never rewrites what is stored)', async () => {
    renderPopover(null)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start loop/i })) })
    const calls = (fetch as unknown as { mock: { calls: [string, { body?: string }?][] } }).mock.calls
    const save = calls.find(c => String(c[0]).startsWith('/api/autonudge') && c[1]?.body)
    expect(save, 'no /api/autonudge write was issued').toBeTruthy()
    const body = JSON.parse(save![1]!.body!)
    expect(body.message).toContain(STOP_FILE_TOKEN)
  })

  it('an armed loop with an explicitly empty sentinel says the token goes out blank', () => {
    renderPopover(makeLoop({ message: `Keep going. To halt, create ${STOP_FILE_TOKEN}`, stop_sentinel_path: '' }))
    expect(noneLine()).toBeTruthy()
    expect(noneLine()!.textContent).toContain(STOP_FILE_TOKEN)
    expect(helpLine()).toBeNull()
  })

  it('an armed loop with a sentinel keeps the generic line and never renders the path', () => {
    renderPopover(makeLoop({ message: `Keep going. To halt, create ${STOP_FILE_TOKEN}`, stop_sentinel_path: '/home/someone/.stop-chat-1-100' }))
    expect(helpLine()).toBeTruthy()
    expect(noneLine()).toBeNull()
    expect(screen.queryByText(/\.stop-chat-1-100/)).toBeNull()
  })

  it('a loop record that does not carry the sentinel field (websocket frame) gets the generic line', () => {
    renderPopover(makeLoop({ message: `Keep going. To halt, create ${STOP_FILE_TOKEN}` }))
    expect(helpLine()).toBeTruthy()
    expect(noneLine()).toBeNull()
  })
})
