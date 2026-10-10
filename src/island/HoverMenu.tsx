import { useRef, type ReactNode } from 'react'

export interface MenuOption<T extends string> { value: T; label: string; disabled?: boolean; title?: string }

/**
 * A button whose choices open on hover (or a click): the language and audio-source buttons.
 * `open` is controlled so subtitle mode can also open it from its pointer polling, where the
 * window gets no hover events. Without `onClick`, clicking the button toggles the menu.
 */
export function HoverMenu<T extends string>({ name, value, options, icon, title, on = false, disabled = false, open, onOpen, onChange, onClick, below = false }: {
  name: string; value: T | null; options: MenuOption<T>[]; icon: ReactNode; title: string; on?: boolean; disabled?: boolean
  open: boolean; onOpen: (open: boolean) => void; onChange: (value: T) => void; onClick?: () => void; below?: boolean
}) {
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keep = () => { clearTimeout(closing.current); onOpen(true) }
  const leave = () => { clearTimeout(closing.current); closing.current = setTimeout(() => onOpen(false), 300) }
  return <span className="hover-menu" data-menu={name} onMouseEnter={keep} onMouseLeave={leave}>
    <button className={`island-icon ${on ? 'on' : ''}`} disabled={disabled} onClick={() => { if (onClick) { onOpen(false); onClick() } else onOpen(!open) }} aria-haspopup="true" aria-expanded={open} title={title}>{icon}</button>
    {open && <span className={`menu-options ${below ? 'below' : ''}`} role="menu">
      {options.map(option => <button key={option.value} role="menuitemradio" aria-checked={value === option.value} className={value === option.value ? 'selected' : ''}
        disabled={option.disabled} title={option.title} onClick={() => { onChange(option.value); onOpen(false) }}>{option.label}</button>)}
    </span>}
  </span>
}
