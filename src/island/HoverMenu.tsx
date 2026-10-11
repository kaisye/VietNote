import { useLayoutEffect, useRef, type ReactNode } from 'react'

export interface MenuOption<T extends string> { value: T; label: string; disabled?: boolean; title?: string }

/**
 * A button whose choices open on hover (or a click): the language and audio-source buttons.
 * `open` is controlled so subtitle mode can also open it from its pointer polling, where the
 * window gets no hover events. Without `onClick`, clicking the button toggles the menu.
 * Picking a choice leaves the menu open, so the result shows; it closes once the pointer leaves.
 * With `caption`, the open menu is headed by `title`, since a window behind another app shows no native tooltips.
 */
export function HoverMenu<T extends string>({ name, value, options, icon, title, on = false, disabled = false, open, onOpen, onChange, onClick, below = false, caption = false, children }: {
  name: string; value: T | null; options: MenuOption<T>[]; icon: ReactNode; title: string; on?: boolean; disabled?: boolean
  open: boolean; onOpen: (open: boolean) => void; onChange: (value: T) => void; onClick?: () => void; below?: boolean; caption?: boolean
  /** Shown under the choices, e.g. the apps system audio listens to. */
  children?: ReactNode
}) {
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const menu = useRef<HTMLSpanElement>(null)
  // Centred on the button, then nudged back inside the island (or window) if it would spill out.
  useLayoutEffect(() => {
    const element = menu.current
    if (!open || !element) return
    element.style.setProperty('--menu-shift', '0px')
    const box = element.getBoundingClientRect()
    const area = element.closest('.island-shape, .subtitle-box')?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth }
    const margin = 6
    const shift = box.left < area.left + margin ? area.left + margin - box.left : box.right > area.right - margin ? area.right - margin - box.right : 0
    element.style.setProperty('--menu-shift', `${shift}px`)
  })
  const keep = () => { clearTimeout(closing.current); onOpen(true) }
  const leave = () => { clearTimeout(closing.current); closing.current = setTimeout(() => onOpen(false), 300) }
  return <span className="hover-menu" data-menu={name} onMouseEnter={keep} onMouseLeave={leave}>
    <button className={`island-icon ${on ? 'on' : ''}`} disabled={disabled} onClick={() => { if (onClick) { onOpen(false); onClick() } else onOpen(!open) }} aria-haspopup="true" aria-expanded={open} aria-label={title}>{icon}</button>
    {open && <span ref={menu} className={`menu-options ${below ? 'below' : ''}`} role="menu" aria-label={title}>
      {caption && <span className="menu-caption">{title}</span>}
      <span className="menu-choices">{options.map(option => <button key={option.value} role="menuitemradio" aria-checked={value === option.value} className={value === option.value ? 'selected' : ''}
        disabled={option.disabled} title={option.title} onClick={() => onChange(option.value)}>{option.label}</button>)}</span>
      {children}
    </span>}
  </span>
}
