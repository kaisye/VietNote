import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface ChoiceOption<T extends string | number> { value: T; label: string }

/**
 * A themed replacement for `<select>`: WebView2 on Windows draws native option lists
 * with system colors and offsets them from the control.
 */
export function Choice<T extends string | number>({ value, options, onChange, icon, disabled, className = '', label, chevron = 17 }: {
  value: T; options: ChoiceOption<T>[]; onChange: (value: T) => void
  icon?: ReactNode; disabled?: boolean; className?: string; label?: string; chevron?: number
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const index = Math.max(0, options.findIndex(option => option.value === value))
  const current = options[index]

  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus() }
  const choose = (option: ChoiceOption<T>) => { if (option.value !== value) onChange(option.value); close() }
  const show = () => { if (disabled || !options.length) return; setActive(index); setOpen(true) }

  // Open below the control, or above it when there is more room there.
  useLayoutEffect(() => {
    if (!open || !root.current) return
    const rect = root.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const wanted = Math.min(options.length * 38 + 10, 320)
    const up = below < wanted && above > below
    setPlace({ left: rect.left, width: rect.width, maxHeight: Math.min(320, up ? above : below) - 6, ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) })
  }, [open, options.length])
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !list.current?.contains(target)) close(false)
    }
    const onMove = (event: Event) => { if (!list.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [open, active])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const onKeyDown = (event: KeyboardEvent) => {
    const last = options.length - 1
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show() }
      return
    }
    const move = (next: number) => { event.preventDefault(); setActive(Math.min(last, Math.max(0, next))) }
    if (event.key === 'ArrowDown') move(active + 1)
    else if (event.key === 'ArrowUp') move(active - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(last)
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(options[active]) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    else if (event.key === 'Tab') close(false)
  }

  return <div ref={root} className={`meeting-choice choice ${open ? 'open' : ''} ${disabled ? 'disabled' : ''} ${className}`}>
    <button ref={trigger} type="button" className="choice-trigger" disabled={disabled} onClick={() => open ? close() : show()} onKeyDown={onKeyDown}
      role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label}
      aria-activedescendant={open ? `${id}-${active}` : undefined}>
      {icon}<span className="choice-value">{current?.label ?? ''}</span><ChevronDown size={chevron} className="choice-chevron"/>
    </button>
    {open && place && createPortal(<div ref={list} id={id} role="listbox" className={`choice-list ${place.bottom !== undefined ? 'up' : ''}`} aria-label={label}
      style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
      onPointerDown={event => event.preventDefault()}>
      {options.map((option, i) => <div key={String(option.value)} id={`${id}-${i}`} data-index={i} role="option" aria-selected={option.value === value}
        className={`choice-option ${i === active ? 'active' : ''}`} onPointerEnter={() => setActive(i)} onClick={() => choose(option)}>
        <span>{option.label}</span>{option.value === value && <Check size={15}/>}
      </div>)}
    </div>, document.body)}
  </div>
}
