/**
 * Git Studio shared primitives — windowing, tri-states, confirm dialog.
 *
 * Visual chrome comes from the app's UI kit like the rest of the dashboard
 * (`ErrorNotice`, `EmptyState`, `Modal`, `Btn`); only the app-specific pieces
 * live here: `useWindow` (fixed-height row windowing, rAF-coalesced),
 * `TriState` (one shape for every list's empty/loading/error contract), and a
 * `ConfirmDialog` that keeps the simple `{title, body, danger, run}` prop
 * shape the call sites already use while rendering through the shared modal.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Inbox, Loader2 } from 'lucide-react'
import { i18nT } from '../../../i18n/t'
import { Btn, EmptyState } from '../../../components/ui'
import ErrorNotice from '../../../components/ErrorNotice'
import Modal from '../../../components/Modal'

export type LoadState = 'idle' | 'loading' | 'error' | 'ready'

/** Fixed-height row windowing over a scroll container. */
export function useWindow(opts: {
  rowHeight: number
  count: number
  overscan?: number
  onNearEnd?: () => void
}) {
  const { rowHeight, count, overscan = 12, onNearEnd } = opts
  const ref = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)
  const nearEndFired = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setHeight(el.clientHeight)
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    // layout reads are synchronous (scroll events already arrive once per
    // frame); only the re-render is coalesced into the next animation frame
    const st = el.scrollTop
    requestAnimationFrame(() => setScrollTop(st))
    if (onNearEnd && el.scrollHeight - (st + el.clientHeight) < rowHeight * 30) {
      const now = Date.now()
      if (now - nearEndFired.current > 400) {
        nearEndFired.current = now
        onNearEnd()
      }
    }
  }, [onNearEnd, rowHeight])

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan)

  return {
    ref,
    onScroll,
    first,
    last,
    totalHeight: count * rowHeight,
    scrollToIndex: (i: number) => {
      if (ref.current) ref.current.scrollTop = Math.max(0, i * rowHeight - 40)
    },
  }
}

/** Empty / loading / error tri-state wrapper — the app kit does the looks. */
export function TriState(props: {
  state: LoadState
  error?: string | null
  empty?: boolean
  emptyText?: string
  loadingText?: string
  children: React.ReactNode
}) {
  if (props.state === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 p-4 text-[12px] text-muted">
        <Loader2 size={14} className="animate-spin" />
        {props.loadingText ?? i18nT('apps.gitStudio.common.loading')}
      </div>
    )
  }
  if (props.state === 'error') {
    return <ErrorNotice message={props.error || i18nT('apps.gitStudio.common.error')} />
  }
  if (props.empty) {
    return (
      <div className="py-2">
        <EmptyState icon={<Inbox size={22} />} title={props.emptyText ?? i18nT('apps.gitStudio.common.empty')} testId="gitstudio-empty" />
      </div>
    )
  }
  return <>{props.children}</>
}

/** Blocking confirmation for destructive git operations (shared modal skin). */
export function ConfirmDialog(props: {
  open: boolean
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={props.open} onClose={props.onCancel} title={props.title} maxWidth={440}>
      <div className="text-[12.5px] leading-relaxed text-text">{props.body}</div>
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={props.onCancel}>{i18nT('apps.gitStudio.common.cancel')}</Btn>
        <Btn
          danger={props.danger}
          primary={!props.danger}
          onClick={props.onConfirm}
          data-testid="confirm-ok"
        >
          {props.confirmLabel ?? i18nT('apps.gitStudio.common.confirm')}
        </Btn>
      </div>
    </Modal>
  )
}

/** Small inline prompt (used for new branch/tag names inside rows). */
export function InlineInput(props: {
  placeholder: string
  onSubmit: (value: string) => void
  className?: string
  testId?: string
}) {
  const [value, setValue] = useState('')
  return (
    <input
      data-testid={props.testId}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={props.placeholder}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) {
          props.onSubmit(value.trim())
          setValue('')
        }
        if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
      }}
      className={`h-7 rounded-md border border-border bg-bg px-2 text-[11px] text-text outline-none placeholder:text-muted focus-visible:border-accent ${props.className ?? ''}`}
    />
  )
}
