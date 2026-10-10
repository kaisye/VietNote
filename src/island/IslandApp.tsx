import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AppWindow, ArrowDown, BookA, Captions, ChevronDown, ChevronUp, CircleAlert, Languages, Lightbulb, Mic, Pin, Send, Square, X } from 'lucide-react'
import { BrandIcon } from '../components/BrandIcon'
import { ChatMarkdown } from '../components/ChatMarkdown'
import { SubtitleView } from './SubtitleView'
import { HoverMenu } from './HoverMenu'
import { SpeechMenu } from './SpeechMenu'
import { useStickToBottom } from '../hooks/useStickToBottom'
import {
  atNotch, displayOptions, shortcutLabel, islandActions, sourceOptions, islandEnabled, islandEvents, islandMode, saveIslandMode, islandPinned, islandDisplay, LEVEL_SIZE, loadPlacements, openFrame, PILL, pillForPanel, pillRect,
  saveIslandPinned, saveIslandDisplay, savePlacement, shownDisplay, screenAt, snapPlacement, startScreen,
  type Display, type IslandAsk, type IslandLine, type IslandMode, type IslandScreen, type IslandState, type Level, type Placement, type Rect,
} from '../services/island'

/** The window frame and, inside it, the island's shape — both in screen coordinates. */
interface View { level: Level; frame: Rect; shape: Rect; animate: boolean; open: boolean; growsUp: boolean }
/** `panel`: an opened island dragged by its header keeps its size; otherwise it shrinks to the pill. */
interface Drag { id: number; panel: boolean; screenX: number; screenY: number; cursorX: number; cursorY: number; grabX: number; grabY: number; moved: boolean; rect?: Rect }

const MORPH_MS = 240
const actionIcons = { explain: Lightbulb, translate: Languages, vocab: BookA }
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1
const sameScreens = (a: IslandScreen[], b: IslandScreen[]) => JSON.stringify(a) === JSON.stringify(b)
const round = (rect: Rect): Rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })
const setFrame = (rect: Rect) => invoke<void>('island_set_frame', { ...round(rect) }).catch(() => {})
const toMain = (event: string, payload?: unknown) => void emitTo('main', event, payload).catch(() => {})

function Wave() {
  return <span className="island-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span>
}

function Line({ line, display, selected, onPick, onAsk }: { line: IslandLine; display: Display; selected?: boolean; onPick?: () => void; onAsk?: () => void }) {
  const translation = display !== 'source' ? line.translation : undefined
  // Vietnamese only: the spoken words stand in, dimmed, until their translation arrives.
  const text = display === 'vietnamese' && translation ? '' : line.text
  if (!text && !translation) return null
  return <div className={`island-line ${line.interim ? 'interim' : ''} ${selected ? 'selected' : ''}`} onClick={onPick} onDoubleClick={onAsk} role={onPick ? 'button' : undefined}>
    {text && <p className={display === 'vietnamese' ? 'island-awaiting' : undefined}>{text}</p>}
    {translation && <p className="island-translation">{translation}</p>}
  </div>
}

/**
 * VietNote Island: a pill at the notch (or wherever it is dragged) that hovering or a click opens
 * into the transcript with questions. Subtitle mode is the glanceable view of the latest sentence.
 */
export function IslandApp() {
  const [state, setState] = useState<IslandState | null>(null)
  const [enabled, setEnabled] = useState(islandEnabled)
  const [screen, setScreen] = useState<IslandScreen | null>(null)
  const [placement, setPlacement] = useState<Placement>({ anchor: 'notch' })
  const [view, setView] = useState<View | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pinned, setPinned] = useState(islandPinned)
  const [display, setDisplay] = useState<Display>(islandDisplay)
  const [menu, setMenu] = useState<string | null>(null)
  const menuRef = useRef<string | null>(null)
  menuRef.current = menu
  const menuProps = (name: string) => ({ name, open: menu === name, onOpen: (open: boolean) => setMenu(current => open ? name : current === name ? null : current) })
  /** The control under the pointer: its description, placed under it in panel coordinates. */
  const [tip, setTip] = useState<{ text: string; top: number; left?: number; right?: number } | null>(null)
  const hovered = useRef<Element | null>(null)
  const menuClosing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [selected, setSelected] = useState<IslandLine | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setModeState] = useState<IslandMode>(islandMode)
  const modeRef = useRef(mode)
  const subtitleMode = () => modeRef.current === 'subtitle'
  // Bumped when the displays change, so the subtitle band re-places itself.
  const [layout, setLayout] = useState(0)
  // How the latest answer is shown; a new question opens it again.
  const [answerView, setAnswerView] = useState<{ key: string; mode: 'open' | 'collapsed' | 'hidden' }>({ key: '', mode: 'open' })
  const viewRef = useRef<View | null>(null)
  const levelRef = useRef<Level>('collapsed')
  const screensRef = useRef<IslandScreen[]>([])
  const screenRef = useRef<IslandScreen | null>(null)
  const selectedRef = useRef<IslandLine | null>(null)
  selectedRef.current = selected
  const placementRef = useRef<Placement>({ anchor: 'notch' })
  const pinnedRef = useRef(pinned)
  const drag = useRef<Drag | null>(null)
  const pressed = useRef<Element | null>(null)
  const received = useRef(false)
  const timers = useRef<Record<'shrink' | 'click' | 'hover' | 'leave', ReturnType<typeof setTimeout> | undefined>>({ shrink: undefined, click: undefined, hover: undefined, leave: undefined })
  const hovering = useRef(false)
  /** At its home spot (the notch, or top centre) an opened island closes once the pointer leaves; moved elsewhere it stays open. */
  const atHome = () => placementRef.current.anchor === 'notch'
  /** Typing a question keeps it open even if the pointer wanders off. */
  const typing = () => document.activeElement === input.current && Boolean(input.current?.value.trim())
  const input = useRef<HTMLInputElement>(null)
  const answer = useRef<HTMLDivElement>(null)
  const lines = state?.lines ?? []
  const chat = state?.chat ?? null
  const notchShaped = Boolean(screen && atNotch(screen, placement) && !dragging)
  const scroll = useStickToBottom([lines, view?.open, display], Boolean(selected))

  const update = (next: View) => { viewRef.current = next; setView(next) }
  const clear = (...names: (keyof typeof timers.current)[]) => names.forEach(name => clearTimeout(timers.current[name]))
  const place = (nextScreen: IslandScreen, nextPlacement: Placement) => {
    screenRef.current = nextScreen; placementRef.current = nextPlacement
    setScreen(nextScreen); setPlacement(nextPlacement)
  }

  const geometry = (target: Level) => {
    const pill = pillRect(screenRef.current!, placementRef.current)
    if (target === 'collapsed') return { frame: pill, growsUp: viewRef.current?.growsUp ?? false }
    return openFrame(screenRef.current!, pill, LEVEL_SIZE[target])
  }

  /** Snaps straight to `target` with no animation, e.g. after a drag or a display change. */
  const settle = (target: Level = levelRef.current) => {
    if (!screenRef.current) return
    clear('shrink')
    levelRef.current = target
    const { frame, growsUp } = geometry(target)
    void setFrame(frame)
    update({ level: target, frame, shape: frame, animate: false, open: target !== 'collapsed', growsUp })
  }

  /**
   * Opening: the window takes its new size first, then the shape grows inside it.
   * Closing: the shape shrinks inside the window, which then takes its new size.
   */
  const go = (target: Level) => {
    const current = viewRef.current
    if (!screenRef.current || !current) return
    if (target === levelRef.current && !current.animate) return
    clear('shrink')
    levelRef.current = target
    const { frame, growsUp } = geometry(target)
    if (contains(frame, current.shape)) {
      void setFrame(frame).then(() => {
        if (levelRef.current !== target) return
        update({ level: target, frame, shape: current.shape, animate: false, open: false, growsUp })
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (levelRef.current === target) update({ ...viewRef.current!, shape: frame, animate: true, open: target !== 'collapsed' })
        }))
      })
    } else {
      update({ ...current, level: target, shape: frame, animate: true, open: false })
      timers.current.shrink = setTimeout(() => {
        void setFrame(frame)
        update({ level: target, frame, shape: frame, animate: false, open: target !== 'collapsed', growsUp })
      }, MORPH_MS)
    }
  }

  /** Subtitle mode takes over the window; going back restores the pill where it was. */
  const setMode = (next: IslandMode) => {
    modeRef.current = next; setModeState(next); saveIslandMode(next)
    clear('shrink', 'click', 'hover', 'leave')
    hovering.current = false
    if (next === 'subtitle') { setSelected(null); levelRef.current = 'collapsed' }
    else settle('collapsed')
  }
  // Closing hands the keyboard back to the app underneath, so typing carries on there. On macOS
  // that briefly orders the panel out, which would stall the shrink, so it waits for the morph.
  const collapse = () => {
    setSelected(null); go('collapsed')
    setTimeout(() => { if (levelRef.current === 'collapsed') void invoke('island_release').catch(() => {}) }, MORPH_MS + 60)
  }
  const expand = (focusInput = false) => {
    go('expanded')
    if (focusInput) { void invoke('island_focus').catch(() => {}); setTimeout(() => input.current?.focus(), 80) }
  }

  // Displays: read at start and re-read every few seconds so plugging in a monitor moves the pill.
  useEffect(() => {
    let stopped = false
    const refresh = async () => {
      const next = await invoke<IslandScreen[]>('island_screens').catch(() => null)
      if (stopped || !next?.length || sameScreens(screensRef.current, next)) return
      screensRef.current = next
      const current = next.find(item => item.key === screenRef.current?.key) ?? startScreen(next, loadPlacements().last)
      place(current, loadPlacements().screens[current.key] ?? { anchor: 'notch' })
      setLayout(value => value + 1)
      if (drag.current?.moved || (modeRef.current === 'subtitle' && viewRef.current)) return
      settle(viewRef.current ? levelRef.current : pinnedRef.current ? 'expanded' : 'collapsed')
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 4000)
    return () => { stopped = true; clearInterval(interval) }
  }, [])

  useEffect(() => {
    if (view) void invoke('island_set_visible', { visible: enabled }).catch(() => {})
  }, [enabled, Boolean(view)]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const subscriptions = [
      listen<IslandState>(islandEvents.state, event => { received.current = true; setState(event.payload) }),
      listen<boolean>(islandEvents.enabled, event => setEnabled(event.payload)),
      listen(islandEvents.shortcut, () => {
        if (modeRef.current === 'subtitle') { setMode('island'); expand(true); return }
        if (levelRef.current === 'expanded' && document.hasFocus()) collapse()
        else expand(true)
      }),
      getCurrentWindow().onFocusChanged(event => {
        // Lost the keyboard to another app: a later click on the island must not take it back.
        if (!event.payload) void invoke('island_release').catch(() => {})
        if (!event.payload && modeRef.current === 'island' && levelRef.current === 'expanded' && atHome() && !pinnedRef.current && !drag.current) { setSelected(null); go('collapsed') }
      }),
    ]
    // The main window may still be loading; keep asking until its first update arrives.
    toMain(islandEvents.hello)
    const hello = setInterval(() => { if (!received.current) toMain(islandEvents.hello) }, 1000)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || modeRef.current === 'subtitle') return
      if (selectedRef.current) setSelected(null)
      else collapse()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearInterval(hello)
      subscriptions.forEach(subscription => void subscription.then(unlisten => unlisten()))
      Object.values(timers.current).forEach(clearTimeout)
    }
  }, [])

  useLayoutEffect(() => { if (answer.current) answer.current.scrollTop = answer.current.scrollHeight }, [chat?.answer, chat?.error, chat?.pending, answerView])
  // A picked line that scrolled out of the history is dropped.
  useEffect(() => { if (selected && !lines.some(line => line.id === selected.id)) setSelected(null) }, [lines]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Hover feedback for the panel's controls, driven by the polled pointer: highlight, menus and descriptions. */
  const pointAt = (element: Element | null) => {
    const control = element?.closest('.island-panel button, .island-panel [data-menu]') ?? null
    if (control !== hovered.current) {
      hovered.current?.removeAttribute('data-hover')
      const button = control?.matches('button') ? control : control?.querySelector('button')
      button?.setAttribute('data-hover', '')
      hovered.current = button ?? null
    }
    const menuName = element?.closest<HTMLElement>('[data-menu]')?.dataset.menu ?? null
    if (menuName) { clearTimeout(menuClosing.current); menuClosing.current = undefined; if (menuRef.current !== menuName) setMenu(menuName) }
    else if (menuRef.current && !menuClosing.current) menuClosing.current = setTimeout(() => { menuClosing.current = undefined; setMenu(null) }, 300)
    const target = menuName ? null : element?.closest<HTMLElement>('[data-tip]')
    const panel = target?.closest('.island-panel')
    if (!target || !panel) { setTip(current => current ? null : current); return }
    const box = target.getBoundingClientRect(), area = panel.getBoundingClientRect(), text = target.dataset.tip!
    const top = box.bottom - area.top + 6
    // Right-hand buttons anchor the tip by its right edge so it stays inside the panel.
    const next = box.left - area.left > area.width / 2 ? { text, top, right: area.right - box.right } : { text, top, left: box.left - area.left }
    setTip(current => current && current.text === next.text && current.top === next.top && current.left === next.left && current.right === next.right ? current : next)
  }

  // At its home spot, hovering opens the island and leaving closes it again. A panel behind
  // another app's window gets no mouse events, so the pointer is polled.
  useEffect(() => {
    let busy = false
    const poll = setInterval(async () => {
      if (busy || !viewRef.current || drag.current || subtitleMode()) return
      busy = true
      const point = await invoke<[number, number]>('island_cursor').catch(() => null)
      busy = false
      const current = viewRef.current
      if (!point || !current || subtitleMode()) return
      const [x, y] = point, shape = current.shape
      const inside = x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height
      pointAt(inside && levelRef.current === 'expanded' && current.open ? document.elementFromPoint(x - current.frame.x, y - current.frame.y) : null)
      if (inside === hovering.current) return
      hovering.current = inside
      if (inside) {
        clear('leave')
        // Moved off its home spot, the pill opens on a click instead, so it can sit by content without popping up.
        if (levelRef.current === 'collapsed' && atHome()) timers.current.hover = setTimeout(() => {
          if (levelRef.current !== 'collapsed' || drag.current || !atHome()) return
          go('expanded')
        }, 160)
      } else {
        clear('hover')
        if (levelRef.current === 'expanded' && atHome() && !pinnedRef.current) timers.current.leave = setTimeout(() => {
          if (levelRef.current === 'expanded' && atHome() && !pinnedRef.current && !hovering.current && !drag.current && !typing()) collapse()
        }, 380)
      }
    }, 90)
    return () => clearInterval(poll)
  }, [])


  /** Where an opened panel can be grabbed: its header bar, or the strip above it at the notch. */
  const panelGrip = (target: Element) => Boolean(target.closest('.island-header')) || !target.closest('.island-panel')
  // Dragging the pill: it follows the cursor and snaps to the notch, a corner or a side when dropped near one.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = viewRef.current
    const target = event.target as Element
    pressed.current = target
    const panel = levelRef.current === 'expanded'
    // An opened island moves by its header (or the strip beside the notch above it); buttons and the text keep their own clicks.
    if (event.button !== 0 || !current || target.closest('button, input') || (panel && !panelGrip(target))) return
    const cursorX = current.frame.x + event.clientX, cursorY = current.frame.y + event.clientY
    const keepGrab = panel || (levelRef.current === 'collapsed' && !notchShaped)
    drag.current = {
      id: event.pointerId, panel, screenX: event.screenX, screenY: event.screenY, cursorX, cursorY, moved: false,
      grabX: keepGrab ? cursorX - current.frame.x : PILL.width / 2, grabY: keepGrab ? cursorY - current.frame.y : PILL.height / 2,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.screenX - active.screenX, dy = event.screenY - active.screenY
    if (!active.moved && Math.hypot(dx, dy) < 4) return
    if (!active.moved) {
      active.moved = true; clear('shrink', 'click', 'hover', 'leave'); setDragging(true)
      if (!active.panel) levelRef.current = 'collapsed'
    }
    const size = active.panel ? { width: viewRef.current!.frame.width, height: viewRef.current!.frame.height } : PILL
    const rect = { x: active.cursorX + dx - active.grabX, y: active.cursorY + dy - active.grabY, ...size }
    active.rect = rect
    void setFrame(rect)
    update(active.panel
      ? { ...viewRef.current!, frame: rect, shape: rect, animate: false }
      : { level: 'collapsed', frame: rect, shape: rect, animate: false, open: false, growsUp: false })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    drag.current = null
    if (!active.moved || !active.rect) {
      // Moved off its home spot, the open panel closes on a click on its header, as it opened.
      // Wait for a possible double-click, which switches to subtitles instead.
      if (active.panel) { if (!atHome() && !pinnedRef.current) timers.current.click = setTimeout(collapse, 220); return }
      // Wait for a possible double-click, which sends the pill back to the notch instead.
      timers.current.click = setTimeout(() => expand(), 220)
      return
    }
    setDragging(false)
    const rect = active.rect
    const target = screenAt(screensRef.current, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }) ?? screenRef.current!
    // A dragged panel is placed by the pill it opens from, so it can snap back to the notch too.
    const next = snapPlacement(target, active.panel ? pillForPanel(target, rect) : rect)
    savePlacement(target.key, next)
    place(target, next)
    settle(active.panel ? 'expanded' : 'collapsed')
  }
  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // On the open panel, double-clicking the header bar (logo included, controls aside) switches to subtitles.
    if (levelRef.current === 'expanded') {
      clear('click')
      // Pointer capture retargets the click to the shape, so judge by where the press landed.
      const target = pressed.current ?? (event.target as Element)
      if (panelGrip(target) && !target.closest('button, [data-menu]')) setMode('subtitle')
      return
    }
    if (!screenRef.current) return
    clear('click')
    const next: Placement = { anchor: 'notch' }
    savePlacement(screenRef.current.key, next)
    place(screenRef.current, next)
    settle('collapsed')
  }

  const togglePinned = () => { const next = !pinned; pinnedRef.current = next; setPinned(next); saveIslandPinned(next) }
  const answerKey = chat ? `${chat.question ?? ''}\u0000${chat.quote ?? ''}` : ''
  const answerMode = answerView.key === answerKey ? answerView.mode : 'open'
  const setAnswerMode = (mode: 'open' | 'collapsed' | 'hidden') => setAnswerView({ key: answerKey, mode })
  const shown = shownDisplay(display, state?.translation)
  const translationAvailable = state?.translation !== 'unavailable'
  // Picking Vietnamese or both turns translation on in the meeting when it is off.
  const chooseDisplay = (next: Display) => {
    if (next !== 'source' && state?.translation === 'off') toMain(islandEvents.translate, true)
    setDisplay(next); saveIslandDisplay(next)
  }
  const canAsk = lines.some(line => !line.interim) && !chat?.pending
  const ask = (question: string, label?: string) => {
    if (!canAsk || !question.trim()) return
    const request: IslandAsk = selected
      ? { question, label, quote: [selected.text, selected.translation].filter(Boolean).join('\n'), focusIds: [selected.id] }
      : { question, label }
    toMain(islandEvents.ask, request)
    setDraft('')
    setSelected(null)
  }

  if (!view) return null
  if (mode === 'subtitle' && screen) return <SubtitleView screen={screen} screens={screensRef.current} layout={layout} lines={lines} status={state?.active ? 'Đang chờ lời nói…' : 'VietNote chưa nghe · rê chuột vào đây và bấm nút ghi để nghe âm thanh máy'}
    active={Boolean(state?.active)} canStart={Boolean(state?.canStart)} onStop={() => toMain(islandEvents.stop)}
    // Subtitles are for videos: the record button listens to the computer's sound, not the microphone.
    onStart={() => toMain(islandEvents.source, 'system')}
    audioSource={state?.source ?? null} onSource={value => toMain(islandEvents.source, value)}
    display={shown} translationAvailable={translationAvailable} onDisplay={chooseDisplay} onExit={() => setMode('island')}
    onDock={target => { const home: Placement = { anchor: 'notch' }; savePlacement(target.key, home); place(target, home); setMode('island') }}
    speech={state?.speech ?? null} onSpeech={enabled => toMain(islandEvents.speech, enabled)} onVoice={voice => toMain(islandEvents.voice, voice)}/>
  const shapeStyle: CSSProperties = {
    left: view.shape.x - view.frame.x, top: view.shape.y - view.frame.y, width: view.shape.width, height: view.shape.height,
    ['--notch-height' as string]: `${screen?.notch?.height ?? 0}px`,
  }
  const listening = Boolean(state?.capturing)
  const status = state?.active ? (listening ? 'Đang nghe' : 'Tạm dừng') : 'Chưa nghe'

  return <div className={`island-root ${notchShaped ? 'at-notch' : ''} ${view.growsUp ? 'grows-up' : ''}`}>
    <div className={`island-shape level-${view.level} ${view.animate ? 'animate' : ''} ${view.open ? 'open' : ''} ${dragging ? 'dragging' : ''}`} style={shapeStyle}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}>
      {!view.open && <div className="island-handle" title={`VietNote · bấm để mở, kéo để di chuyển, nhấp đúp để về ${screen?.notch ? 'notch' : 'giữa cạnh trên'}`}>
        <span className="island-logo"><BrandIcon size={notchShaped ? 18 : 20}/></span>
        {!notchShaped && <span className="island-handle-label">{listening && lines.length ? lines.at(-1)!.text || lines.at(-1)!.translation : status}</span>}
        {listening ? <Wave/> : <i className={`island-led ${state?.active ? 'paused' : ''}`}/>}
      </div>}


      {view.open && view.level === 'expanded' && <div className="island-panel">
        <header className="island-header" title={atHome() ? 'Kéo để di chuyển · nhấp đúp để chuyển sang phụ đề' : 'Bấm để thu nhỏ · kéo để di chuyển · nhấp đúp để chuyển sang phụ đề'}>
          <span className="island-header-logo"><BrandIcon size={20}/></span>
          <div className="island-title"><strong>VietNote</strong><small>{listening && <Wave/>}{status}</small></div>
          <span className="row-spacer"/>
          <HoverMenu {...menuProps('display')} below value={shown} options={displayOptions.map(option => ({ ...option, disabled: option.value !== 'source' && !translationAvailable }))}
            onChange={chooseDisplay} icon={<Languages size={15}/>} title="Hiển thị" caption on={shown !== 'source'}/>
          {state?.speech && <SpeechMenu {...menuProps('speech')} below caption size={15} speech={state.speech}
            onToggle={enabled => toMain(islandEvents.speech, enabled)} onVoice={voice => toMain(islandEvents.voice, voice)}/>}
          <button className={`island-icon ${pinned ? 'on' : ''}`} onClick={togglePinned} data-tip={pinned ? 'Bỏ ghim: tự thu gọn khi bấm ra ngoài' : 'Ghim: luôn mở'} aria-pressed={pinned}><Pin size={15}/></button>
          <HoverMenu {...menuProps('source')} below caption value={state?.source ?? null} options={sourceOptions.map(option => ({ ...option, disabled: !state?.active && !state?.canStart }))}
            onChange={value => toMain(islandEvents.source, value)} disabled={!state?.active && !state?.canStart} title={state?.active ? 'Dừng nghe và lưu' : 'Bắt đầu nghe'}
            icon={state?.active ? <Square size={12} fill="currentColor"/> : <Mic size={15}/>} onClick={() => toMain(state?.active ? islandEvents.stop : islandEvents.start)}/>
          <button className="island-icon" onClick={() => setMode('subtitle')} data-tip="Chế độ phụ đề: chỉ hiện câu đang nói · hoặc nhấp đúp thanh trên"><Captions size={15}/></button>
          <button className="island-icon" onClick={() => void invoke('island_open_main').catch(() => {})} data-tip="Mở cửa sổ VietNote"><AppWindow size={15}/></button>
          <button className="island-icon" onClick={collapse} data-tip="Thu gọn (Esc)"><ChevronUp size={16}/></button>
        </header>
        {tip && <span className="island-tip" role="tooltip" style={{ top: tip.top, left: tip.left, right: tip.right }}>{tip.text}</span>}

        {state?.active || lines.length ? <div className="island-lines" ref={scroll.ref} onScroll={scroll.onScroll}>
          {lines.map(line => <Line key={line.id} line={line} display={shown} selected={selected?.id === line.id}
            onPick={line.interim ? undefined : () => setSelected(previous => previous?.id === line.id ? null : line)}
            onAsk={line.interim ? undefined : () => { setSelected(line); expand(true) }}/>)}
          {!lines.length && <p className="island-hint">Lời nói sẽ hiện ở đây ngay khi nhận diện được…</p>}
        </div> : <div className="island-idle">
          <p>VietNote chưa nghe. Bắt đầu để xem bản ghi và hỏi đáp ngay tại đây.</p>
          <div className="island-idle-actions">
            <button className="island-button primary" disabled={!state?.canStart} onClick={() => toMain(islandEvents.start)}><Mic size={15}/>Bắt đầu nghe</button>
            <button className="island-button" onClick={() => void invoke('island_open_main').catch(() => {})}><AppWindow size={15}/>Mở VietNote</button>
          </div>
          {state && !state.canStart && <small>{state.status}</small>}
        </div>}
        {!scroll.following && lines.length > 0 && <button className="island-button island-latest" onClick={scroll.resume}><ArrowDown size={13}/>Mới nhất</button>}

        {chat && answerMode !== 'hidden' && <div className={`island-answer ${answerMode === 'collapsed' ? 'collapsed' : ''}`}>
          <div className="island-answer-head" onClick={() => setAnswerMode(answerMode === 'collapsed' ? 'open' : 'collapsed')} title={answerMode === 'collapsed' ? 'Mở câu trả lời' : 'Thu gọn câu trả lời'}>
            <p className="island-question">{chat.question ?? 'Câu trả lời'}</p>
            {chat.pending && answerMode === 'collapsed' && <Wave/>}
            <button className="island-icon" aria-label={answerMode === 'collapsed' ? 'Mở câu trả lời' : 'Thu gọn câu trả lời'}>{answerMode === 'collapsed' ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}</button>
            <button className="island-icon" aria-label="Ẩn câu trả lời" title="Ẩn câu trả lời"
              onClick={event => { event.stopPropagation(); if (chat.error) toMain(islandEvents.dismiss); else setAnswerMode('hidden') }}><X size={13}/></button>
          </div>
          {answerMode === 'open' && <div className="island-answer-body" ref={answer}>
            {chat.error ? <p className="island-error"><CircleAlert size={14}/>{chat.error}</p>
              : chat.answer ? <ChatMarkdown content={chat.answer} streaming={chat.pending}/>
              : chat.pending && <p className="island-hint">Đang trả lời…</p>}
          </div>}
        </div>}

        {selected && <div className="island-quote"><span>“{selected.text || selected.translation}”</span><button className="island-icon" onClick={() => setSelected(null)} title="Bỏ chọn"><X size={13}/></button></div>}
        {selected && <div className="island-actions">{islandActions.map(action => {
          const Icon = actionIcons[action.id]
          return <button key={action.id} className="island-button" disabled={!canAsk} onClick={() => ask(action.question, action.label)}><Icon size={14}/>{action.label}</button>
        })}</div>}
        <form className="island-composer" onSubmit={event => { event.preventDefault(); ask(draft) }}>
          <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} disabled={!lines.length}
            onFocus={() => { if (!document.hasFocus()) void invoke('island_focus').catch(() => {}) }}
            placeholder={lines.length ? (selected ? 'Hỏi về câu đã chọn…' : `Hỏi về nội dung đang nghe… (${shortcutLabel})`) : 'Chưa có lời nói để hỏi'}/>
          <button className="island-send" type="submit" disabled={!canAsk || !draft.trim()} aria-label="Gửi câu hỏi"><Send size={15}/></button>
        </form>
      </div>}
    </div>
  </div>
}
