import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Languages, Mic, PanelTop, Square } from 'lucide-react'
import { HoverMenu } from './HoverMenu'
import { SpeechMenu } from './SpeechMenu'
import type { SpeechVoice } from '../hooks/useSpeech'
import type { AudioInput } from '../services/types'
import { saveSubtitleOffset, screenAt, subtitleFor, subtitleOffsets, subtitleRect, displayOptions, sourceOptions, type Display, type IslandLine, type IslandScreen, type IslandState, type Rect } from '../services/island'

const setFrame = (rect: Rect) => invoke<void>('island_set_frame', { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }).catch(() => {})
const ignoreCursor = (ignore: boolean) => void invoke('island_ignore_cursor', { ignore }).catch(() => {})

/**
 * Recognition arrives in bursts of words; this lets the text run out evenly instead, catching up
 * within about a third of a second. A revised word rewinds to what still matches.
 */
function useSmoothText(target: string) {
  const [shown, setShown] = useState(target)
  const shownRef = useRef(target)
  useEffect(() => {
    let frame = 0
    const step = () => {
      let current = shownRef.current
      if (!target.startsWith(current)) {
        let common = 0
        while (common < current.length && current[common] === target[common]) common++
        current = target.slice(0, common)
      }
      const remaining = target.length - current.length
      if (remaining > 0) current = target.slice(0, current.length + Math.max(1, Math.ceil(remaining / 18)))
      if (current !== shownRef.current) { shownRef.current = current; setShown(current) }
      if (current !== target) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return shown
}

interface Drag { id: number; screenX: number; screenY: number; from: Rect; rect?: Rect }

/**
 * Subtitle mode: a caption band over the video with just the sentence being spoken and its
 * translation. Clicks pass through to the video except over the caption, which can be dragged
 * and shows its controls on hover.
 */
export function SubtitleView({ screen, screens, layout, lines, status, active, canStart, onStart, onStop, audioSource, onSource, display, translationAvailable, onDisplay, onExit, speech, onSpeech, onVoice }: {
  screen: IslandScreen; screens: IslandScreen[]; layout: number; lines: IslandLine[]; status: string
  active: boolean; canStart: boolean; onStart: () => void; onStop: () => void; audioSource: AudioInput | null; onSource: (source: AudioInput) => void
  display: Display; translationAvailable: boolean; onDisplay: (display: Display) => void; onExit: () => void
  speech: IslandState['speech']; onSpeech: (enabled: boolean) => void; onVoice: (voice: SpeechVoice) => void
}) {
  const [frame, setFrameState] = useState(() => subtitleRect(screen, subtitleOffsets()[screen.key]))
  const [hover, setHover] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const menuProps = (name: string) => ({ name, open: menu === name, onOpen: (open: boolean) => setMenu(current => open ? name : current === name ? null : current) })
  const frameRef = useRef(frame)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const caption = subtitleFor(lines.filter(line => line.text || line.translation), display !== 'source')
  const source = useSmoothText(caption?.source ?? '')
  const translated = useSmoothText(caption?.translation ?? '')
  // Short text sits at the top of its two lines; longer text keeps its newest line in view.
  const sourceClip = useRef<HTMLDivElement>(null)
  const translationClip = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    for (const clip of [sourceClip.current, translationClip.current]) if (clip) clip.scrollTop = clip.scrollHeight
  }, [source, translated])

  const move = (rect: Rect) => { frameRef.current = rect; setFrameState(rect); void setFrame(rect) }
  useEffect(() => { move(subtitleRect(screen, subtitleOffsets()[screen.key])) }, [screen.key, layout])

  // The window only takes the mouse while the pointer is over the caption.
  useEffect(() => {
    let busy = false, inside = true
    const poll = setInterval(async () => {
      if (busy || drag.current || !box.current) return
      busy = true
      const point = await invoke<[number, number]>('island_cursor').catch(() => null)
      busy = false
      if (!point || !box.current) return
      const origin = frameRef.current
      const hit = (element: Element | null | undefined) => {
        if (!element) return false
        const bounds = element.getBoundingClientRect()
        return point[0] >= origin.x + bounds.left && point[0] <= origin.x + bounds.right && point[1] >= origin.y + bounds.top && point[1] <= origin.y + bounds.bottom
      }
      // Menus open above the caption, so they count as part of it.
      const hovered = [...box.current.querySelectorAll<HTMLElement>('[data-menu]')].find(menu => hit(menu.querySelector('button')))
      if (hovered) setMenu(hovered.dataset.menu!)
      const over = hit(box.current) || hit(box.current.querySelector('.menu-options'))
      if (over === inside) return
      inside = over
      setHover(over)
      if (!over) setMenu(null)
      ignoreCursor(!over)
    }, 90)
    return () => { clearInterval(poll); ignoreCursor(false) }
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    drag.current = { id: event.pointerId, screenX: event.screenX, screenY: event.screenY, from: frameRef.current }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    active.rect = { ...active.from, x: active.from.x + event.screenX - active.screenX, y: active.from.y + event.screenY - active.screenY }
    move(active.rect)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    drag.current = null
    if (!active.rect) return
    const target = screenAt(screens, { x: active.rect.x + active.rect.width / 2, y: active.rect.y + active.rect.height / 2 }) ?? screen
    const placed = subtitleRect(target, { dx: active.rect.x - target.frame.x, dy: active.rect.y - target.frame.y })
    saveSubtitleOffset(target.key, placed.x - target.frame.x, placed.y - target.frame.y)
    move(placed)
  }

  return <div className="subtitle-root">
    <div className={`subtitle-box ${hover ? 'hover' : ''}`} ref={box} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="subtitle-controls">
        <HoverMenu {...menuProps('source')} value={audioSource} options={sourceOptions.map(option => ({ ...option, disabled: !active && !canStart }))} onChange={onSource}
          icon={active ? <Square size={12} fill="currentColor"/> : <Mic size={14}/>} title={active ? 'Dừng nghe và lưu' : 'Nghe âm thanh máy · rê chuột để chọn micro'} disabled={!active && !canStart} onClick={active ? onStop : onStart}/>
        <HoverMenu {...menuProps('display')} value={display} options={displayOptions.map(option => ({ ...option, disabled: option.value !== 'source' && !translationAvailable }))} onChange={onDisplay}
          icon={<Languages size={14}/>} title="Hiển thị: tiếng gốc, tiếng Việt hoặc song ngữ" on={display !== 'source'}/>
        {speech && <SpeechMenu {...menuProps('speech')} size={14} speech={speech} onToggle={onSpeech} onVoice={onVoice}/>}
        <button className="island-icon" onClick={onExit} title="Quay lại island"><PanelTop size={14}/></button>
      </div>
      {/* Both rows always keep their height, so the band never changes size while text streams in. */}
      {!caption ? <div className="subtitle-clip source"><p className="subtitle-hint">{status}</p></div>
        : display === 'vietnamese'
          // Vietnamese only: the translation takes the main row, with the spoken words dimmed until it arrives.
          ? <div className="subtitle-clip source" ref={sourceClip}>{translated ? <p className={`subtitle-source ${caption.translationLags ? 'lagging' : ''}`}>{translated}</p> : <p className="subtitle-source awaiting">{source}</p>}</div>
          : <>
            <div className="subtitle-clip source" ref={sourceClip}><p className="subtitle-source">{source}</p></div>
            {display === 'both' && <div className="subtitle-clip translation" ref={translationClip}><p className={`subtitle-translation ${caption.translationLags ? 'lagging' : ''}`}>{translated}</p></div>}
          </>}
    </div>
  </div>
}
