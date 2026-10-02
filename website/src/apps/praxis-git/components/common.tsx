/** Git Studio shared primitives — windowing, tri-states, confirm dialog.

`useWindow` is the same idea as the chat virtualizer (fixed row height,
rAF-throttled scroll, overscan) reduced to its reusable core: the graph and
the working-directory list both render 10k+ rows without a dependency.
*/
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { i18nT } from '../../../i18n/t'

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

  return { ref, onScroll, first, last, totalHeight: count * rowHeight, scrollToIndex: (i: number) => { if (ref.current) ref.current.scrollTop = Math.max(0, i * rowHeight - 40) } }
}

/** Empty / loading / error tri-state wrapper for any list or panel. */
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
    return (
      <div className="flex items-start gap-2 rounded border border-danger bg-danger-subtle p-3 text-[12px] text-danger">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-all">{props.error || i18nT('apps.gitStudio.common.error')}</span>
      </div>
    )
  }
  if (props.empty) {
    return <div className="p-4 text-center text-[12px] text-muted">{props.emptyText ?? i18nT('apps.gitStudio.common.empty')}</div>
  }
  return <>{props.children}</>
}

/** Blocking confirmation for destructive git operations. */
export function ConfirmDialog(props: {
  open: boolean
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!props.open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-text-strong">
          {props.danger && <AlertTriangle size={16} className="text-danger" />}
          {props.title}
        </div>
        <div className="mb-4 text-[12.5px] leading-relaxed text-text">{props.body}</div>
        <div className="flex justify-end gap-2">
          <button
            className="rounded border border-border px-3 py-1.5 text-[12px] text-text hover:bg-bg-hover"
            onClick={props.onCancel}
          >
            {i18nT('apps.gitStudio.common.cancel')}
          </button>
          <button
            className={`rounded px-3 py-1.5 text-[12px] ${props.danger ? 'bg-danger text-danger-fg hover:opacity-90' : 'bg-accent text-accent-fg hover:opacity-90'}`}
            onClick={props.onConfirm}
            data-testid="confirm-ok"
          >
            {props.confirmLabel ?? i18nT('apps.gitStudio.common.confirm')}
          </button>
        </div>
      </div>
    </div>
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
      className={`h-7 rounded border border-border bg-bg px-2 text-[11px] text-text outline-none placeholder:text-muted focus:border-accent ${props.className ?? ''}`}
    />
  )
}

/** Toast area for operation results (bounded, auto-dismiss). */
export type Notice = { id: number; kind: 'ok' | 'error' | 'info'; text: string }

export function Notices(props: { notices: Notice[]; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (!props.notices.length) return
    const timers = props.notices.map((n) => setTimeout(() => props.onDismiss(n.id), n.kind === 'error' ? 8000 : 4000))
    return () => timers.forEach(clearTimeout)
  }, [props.notices, props.onDismiss])
  if (!props.notices.length) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-80 flex-col gap-2">
      {props.notices.map((n) => (
        <button
          key={n.id}
          onClick={() => props.onDismiss(n.id)}
          className={`pointer-events-auto rounded border px-3 py-2 text-left text-[12px] shadow-lg ${
            n.kind === 'error'
              ? 'border-danger bg-danger-subtle text-danger'
              : n.kind === 'ok'
                ? 'border-ok bg-ok-subtle text-ok'
                : 'border-border bg-card text-text'
          }`}
        >
          {n.text}
        </button>
      ))}
    </div>
  )
}
