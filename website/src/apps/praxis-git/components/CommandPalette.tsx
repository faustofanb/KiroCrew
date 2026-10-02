/**
 * CommandPalette — ⌘K quick actions over Git Studio's surface.
 *
 * The palette is the keyboard entry to everything the sidebar offers plus
 * commit-context actions (cherry-pick / revert / checkout-detached of the
 * selected commit). Fuzzy filter on label + keywords.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, CornerDownLeft } from 'lucide-react'
import { i18nT } from '../../../i18n/t'

export type PaletteAction = {
  /** also the English search key — the label may be translated */
  id: string
  label: string
  danger?: boolean
  run: () => void
}

export function CommandPalette(props: { open: boolean; actions: PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (props.open) {
      setQuery('')
      setActive(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [props.open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return props.actions.slice(0, 30)
    return props.actions
      .filter((a) => (a.label + ' ' + a.id).toLowerCase().includes(q))
      .slice(0, 30)
  }, [props.actions, query])

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  if (!props.open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onClick={props.onClose} role="dialog" aria-modal="true" data-testid="command-palette">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Command size={14} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const action = filtered[active]
                if (action) {
                  props.onClose()
                  action.run()
                }
              } else if (e.key === 'Escape') {
                props.onClose()
              }
            }}
            placeholder={i18nT('apps.gitStudio.palette.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-muted"
            data-testid="palette-input"
          />
          <span className="shrink-0 rounded border border-border px-1 font-mono text-[9px] text-muted">esc</span>
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 && <div className="p-4 text-center text-[12px] text-muted">{i18nT('apps.gitStudio.palette.none')}</div>}
          {filtered.map((a, i) => (
            <button
              key={a.id}
              className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12.5px] ${i === active ? 'bg-accent-subtle text-accent' : a.danger ? 'text-danger hover:bg-bg-hover' : 'text-text hover:bg-bg-hover'}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                props.onClose()
                a.run()
              }}
              data-testid={`palette-${a.id}`}
            >
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {i === active && <CornerDownLeft size={12} className="shrink-0 opacity-60" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
