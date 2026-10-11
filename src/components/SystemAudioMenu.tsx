import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Volume2, VolumeX } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import { appChoiceAvailable, useAudioApps } from '../services/audioApps'
import { SystemAudioToggle } from './MeetingControls'

/** A whole row toggles, so the switch is easy to hit. */
function SwitchRow({ title, detail, checked, disabled = false, onChange }: { title: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`app-audio-row ${disabled ? 'disabled' : ''}`}>
    <span><b>{title}</b><small>{detail}</small></span>
    <span className="translate-switch"><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span aria-hidden="true"/></span>
  </label>
}

/**
 * System audio with a choice of apps: YouTube in a browser can be left out while the meeting
 * runs in its own app. Tabs of one browser are one app, so they go together. Outside macOS
 * this is the plain on/off button.
 */
export function SystemAudioMenu({ model }: { model: AppModel }) {
  const [open, setOpen] = useState(false)
  const { apps, excluded, isPlaying, listening, setListening, listenToAll } = useAudioApps(open)
  const root = useRef<HTMLSpanElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  // The toolbar's frosted glass is its own stacking layer, so the menu is drawn on the body,
  // pinned under the button.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = root.current?.getBoundingClientRect()
      if (rect) setAnchor({ top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) })
    }
    place()
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !popover.current?.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  if (!appChoiceAvailable) return <SystemAudioToggle model={model}/>

  // Turning everything on listens to every app again; off stops system audio.
  const toggleAll = (on: boolean) => {
    if (on && excluded.length) listenToAll()
    if (on !== model.systemAudioOn) model.toggleSystemAudio()
  }
  const label = !model.systemAudioOn ? 'Âm thanh máy đang tắt' : excluded.length ? `Âm thanh máy · bỏ qua ${excluded.length}` : 'Âm thanh máy'

  return <span className="app-audio" ref={root}>
    <button type="button" className={`pill-btn mic-toggle ${model.systemAudioOn ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog"
      title="Bật, tắt âm thanh máy và chọn ứng dụng được nghe">{model.systemAudioOn ? <Volume2 size={16}/> : <VolumeX size={16}/>}{label}<ChevronDown size={14}/></button>
    {open && anchor && createPortal(<div className="app-audio-popover" ref={popover} style={{ top: anchor.top, left: anchor.left }} role="dialog" aria-label="Âm thanh máy">
      <SwitchRow title="Tất cả âm thanh máy" detail={model.systemAudioOn ? (excluded.length ? `Đang bỏ qua ${excluded.length} ứng dụng · bật lại để nghe tất cả` : 'Đang nghe mọi ứng dụng') : 'Đang tắt'}
        checked={model.systemAudioOn && !excluded.length} onChange={toggleAll}/>
      <div className="app-audio-divider"/>
      {apps.length === 0 ? <p className="app-audio-empty">Chưa có ứng dụng nào đang phát tiếng.</p>
        : <div className="app-audio-list">{apps.map(app => <SwitchRow key={app.id} title={app.name} detail={isPlaying(app) ? 'Đang phát' : 'Im lặng'}
          checked={listening(app)} disabled={!model.systemAudioOn} onChange={listen => setListening(app, listen)}/>)}</div>}
      <small className="app-audio-note">Các tab trong cùng một trình duyệt được tính chung là một ứng dụng.</small>
    </div>, document.body)}
  </span>
}
