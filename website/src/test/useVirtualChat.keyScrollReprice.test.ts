/**
 * GUARD for kirodotdev/KiroCrew#15297: a pending native key scroll (PageDown /
 * arrows / space) is DROPPED when the reprice-above-the-fold compensation writes
 * `scrollTop` in the same frame.
 *
 * On Firefox a native key scroll reaches the focused scroller with
 * `defaultPrevented === false` and its scroll step is applied AFTER the keydown
 * dispatch returns, on the way to paint. When a mounted row wholly above the
 * viewport grows, the ResizeObserver fires `compensateAboveFold`, which writes
 * `scrollTop` -- and Firefox discards the pending key step wholesale: the reader
 * presses PageDown and travels zero pixels, where the same key without the
 * growth moves the measured 866px.
 *
 * The reprice correction is a RELATIVE shift of content above the fold, so it
 * COMPOSES with the key scroll when applied AFTER it. The fix defers the
 * compensation past the pending key step (to the next frame) instead of writing
 * synchronously, so both land: the key's 866px, then the reprice delta on top.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { keyScrollPending, KEY_SCROLL_PENDING_MS } from '../hooks/virtualizer/FollowController'
import { useShiftCompensation } from '../hooks/virtualizer/shiftCompensation'
import type { WriteScrollTop } from '../hooks/virtualizer/followPolicy'

describe('keyScrollPending', () => {
  it('is false when no key scroll has been seen this session (sentinel -1)', () => {
    expect(keyScrollPending(1000, -1)).toBe(false)
  })

  it('is true within the pending window of the last key scroll', () => {
    expect(keyScrollPending(1000, 1000)).toBe(true)
    expect(keyScrollPending(1000 + KEY_SCROLL_PENDING_MS - 1, 1000)).toBe(true)
  })

  it('is false once the window has fully elapsed (the step has landed)', () => {
    expect(keyScrollPending(1000 + KEY_SCROLL_PENDING_MS, 1000)).toBe(false)
    expect(keyScrollPending(5000, 1000)).toBe(false)
  })
})

/**
 * Behavioural reproduction. A fake scroller and a fake `writeScrollTop` that
 * EMULATES Firefox: an absolute scrollTop write issued while a key scroll is
 * still pending discards the pending key delta (the browser drops the step).
 * Once the key step has landed (the pending window has passed), a write no
 * longer discards anything -- it composes.
 */
describe('compensateAboveFold preserves a pending native key scroll (#15297)', () => {
  const KEY_SCROLL_PX = 866
  const REPRICE_PX = 400

  let rafQueue: Array<() => void>
  let now: number

  beforeEach(() => {
    rafQueue = []
    now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const flushRaf = () => {
    const q = rafQueue
    rafQueue = []
    for (const cb of q) cb()
  }

  /** Build a fake scroller. The Firefox drop is modelled by the test bodies
   *  driving scrollTop directly, not here: this only supplies a writable
   *  scrollTop and a scrollTo that assigns it. */
  function makeScroller() {
    const el = {
      scrollTop: 0,
      isConnected: true,
      scrollTo({ top }: { top: number }) {
        this.scrollTop = top
      },
    } as unknown as HTMLDivElement
    return el
  }

  function harness(el: HTMLDivElement, keyRef: { current: number }, writeScrollTop: WriteScrollTop) {
    return renderHook(() => {
      const stickRef = useRef(false)
      const scrollerRef = useRef<HTMLDivElement | null>(el)
      const elIndexRef = useRef(new Map<Element, number>())
      const itemsRef = useRef<unknown[]>([])
      const settleMeasuringRef = useRef(false)
      const lastKeyScrollAtRef = keyRef
      const shiftAnchorRef = useRef(null)
      const shiftStageRef = useRef(null)
      const prependCountRef = useRef(0)
      const shiftInsertedRef = useRef(0)
      const prependPreScrollTopRef = useRef(-1)
      const prependNetRef = useRef(0)
      const rebaseScheduledRef = useRef(false)
      const heightAnchorPendingRef = useRef(null)
      const retiredKeysRef = useRef(null)
      const renamedKeysRef = useRef(null)
      return useShiftCompensation<unknown>({
        itemCount: 0,
        windowRange: { start: 0, end: 0 },
        heightCommit: 0,
        offsetIndex: { getHeight: () => 0 } as never,
        scrollerRef,
        elIndexRef,
        itemsRef,
        anchorIdOf: () => '',
        setWindowRange: () => {},
        shift: {
          shiftAnchorRef, shiftStageRef, prependCountRef, shiftInsertedRef, prependPreScrollTopRef,
          prependNetRef, rebaseScheduledRef, heightAnchorPendingRef, spliceCommit: 0,
          retiredKeysRef, renamedKeysRef,
          captureAnchorCands: () => [],
          captureHeightSyncAnchor: () => {},
          dropShiftCapture: () => {},
        } as never,
        follow: {
          stickRef,
          writeScrollTop,
          lastKeyScrollAtRef,
        } as never,
        pinning: { prePaintRepin: () => {} } as never,
        reading: { settleMeasuringRef } as never,
        ops: { recomputeWindow: () => {} } as never,
      })
    })
  }

  it('defers the write AND its row-top accounting past a pending key scroll, then composes', () => {
    // The reader pressed PageDown 5ms ago; its 866px step is queued but not
    // applied. scrollTop still reads 0.
    const el = makeScroller()
    const keyRef = { current: now - 5 }
    const write: WriteScrollTop = (target, top) => {
      target.scrollTo({ top, behavior: 'auto' })
    }
    const shiftRowTops = vi.fn()
    const { result } = harness(el, keyRef, write)

    result.current.compensateAboveFold(el, REPRICE_PX, shiftRowTops)

    // A synchronous write would have clobbered the pending key: nothing written
    // yet, and crucially the row-top accounting has NOT run — shifting the
    // record before the write lands would corrupt the baseline a later fire of
    // the same layout measures against.
    expect(el.scrollTop).toBe(0)
    expect(shiftRowTops).not.toHaveBeenCalled()
    expect(rafQueue.length).toBe(1)

    // The browser applies the key scroll first (866px), then the deferred frame
    // writes the reprice on top AND accounts for it in the same turn.
    now += 20
    el.scrollTop = KEY_SCROLL_PX
    flushRaf()

    expect(el.scrollTop).toBe(KEY_SCROLL_PX + REPRICE_PX)
    expect(shiftRowTops).toHaveBeenCalledTimes(1)
    expect(shiftRowTops).toHaveBeenCalledWith(REPRICE_PX)
  })

  it('coalesces repeated fires inside the window into one write and one accounting', () => {
    const el = makeScroller()
    const keyRef = { current: now - 5 }
    const write: WriteScrollTop = (target, top) => {
      target.scrollTo({ top, behavior: 'auto' })
    }
    const shiftRowTops = vi.fn()
    const { result } = harness(el, keyRef, write)

    // Two fires of the same layout arrive before the deferred frame runs (the
    // observer delivers one layout over several callbacks). They must not stack
    // a write + a double accounting each — they accumulate into one.
    result.current.compensateAboveFold(el, 100, shiftRowTops)
    result.current.compensateAboveFold(el, 300, shiftRowTops)
    expect(rafQueue.length).toBe(1)

    now += 20
    el.scrollTop = KEY_SCROLL_PX
    flushRaf()

    expect(el.scrollTop).toBe(KEY_SCROLL_PX + 400)
    expect(shiftRowTops).toHaveBeenCalledTimes(1)
    expect(shiftRowTops).toHaveBeenCalledWith(400)
  })

  it('re-queues one more frame when a NEWER key scroll is pending at rAF time', () => {
    const el = makeScroller()
    const keyRef = { current: now - 5 }
    const write: WriteScrollTop = (target, top) => {
      target.scrollTo({ top, behavior: 'auto' })
    }
    const shiftRowTops = vi.fn()
    const { result } = harness(el, keyRef, write)

    result.current.compensateAboveFold(el, REPRICE_PX, shiftRowTops)
    expect(rafQueue.length).toBe(1)

    // A held PageDown repeats: a fresh key arrives just as the deferred frame
    // is about to run. Writing now would land in the newer key's gap and drop
    // it, so the frame must re-queue instead of writing.
    now += 20
    keyRef.current = now - 1
    el.scrollTop = KEY_SCROLL_PX
    flushRaf()

    expect(el.scrollTop).toBe(KEY_SCROLL_PX) // not written yet
    expect(shiftRowTops).not.toHaveBeenCalled()
    expect(rafQueue.length).toBe(1) // re-queued

    // The newer key's window elapses; the next frame writes.
    now += KEY_SCROLL_PENDING_MS
    el.scrollTop = KEY_SCROLL_PX * 2
    flushRaf()

    expect(el.scrollTop).toBe(KEY_SCROLL_PX * 2 + REPRICE_PX)
    expect(shiftRowTops).toHaveBeenCalledWith(REPRICE_PX)
  })

  it('writes AND accounts synchronously when no key scroll is pending (ordinary path unchanged)', () => {
    const el = makeScroller()
    el.scrollTop = 1200
    const keyRef = { current: -1 }
    const write: WriteScrollTop = (target, top) => {
      target.scrollTo({ top, behavior: 'auto' })
    }
    const shiftRowTops = vi.fn()
    const { result } = harness(el, keyRef, write)

    result.current.compensateAboveFold(el, REPRICE_PX, shiftRowTops)

    expect(rafQueue.length).toBe(0)
    expect(el.scrollTop).toBe(1200 + REPRICE_PX)
    expect(shiftRowTops).toHaveBeenCalledTimes(1)
    expect(shiftRowTops).toHaveBeenCalledWith(REPRICE_PX)
  })
})
