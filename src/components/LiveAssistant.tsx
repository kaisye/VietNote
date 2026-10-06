import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Bot, ChevronDown, CircleAlert, Languages, Lightbulb, MessageCircle, MessageSquareReply, RotateCcw, Send, Sparkles, Trash2, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Subtitle } from '../services/types'
import { liveActions, type LiveQuestion } from '../services/liveChat'
import { formatTime } from '../services/notes'
import { ChatMarkdown } from './ChatMarkdown'

interface Pick { text: string; ids: string[]; x: number; top: number; bottom: number }
const actionIcons = { explain: Lightbulb, translate: Languages, reply: MessageSquareReply }
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent)

function Wave() {
  return <span className="island-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span>
}

const wordChar = /[\p{L}\p{N}\p{M}'’-]/u
/** Drag selections often start or stop mid-word; quote whole words. */
function wholeWords(range: Range): Range {
  const snapped = range.cloneRange()
  if (snapped.startContainer.nodeType === Node.TEXT_NODE) {
    const text = snapped.startContainer.textContent ?? ''
    let start = snapped.startOffset
    while (start > 0 && wordChar.test(text[start - 1])) start--
    snapped.setStart(snapped.startContainer, start)
  }
  if (snapped.endContainer.nodeType === Node.TEXT_NODE) {
    const text = snapped.endContainer.textContent ?? ''
    let end = snapped.endOffset
    while (end > 0 && end < text.length && wordChar.test(text[end - 1]) && wordChar.test(text[end])) end++
    snapped.setEnd(snapped.endContainer, end)
  }
  return snapped
}

/** The selected passage, if the selection sits inside one of `roots` (transcript or summary). */
function readSelection(roots: (HTMLElement | null)[]): Pick | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const root = roots.find(element => element?.contains(range.commonAncestorContainer))
  if (!root) return null
  const text = wholeWords(range).toString().replace(/\s+/g, ' ').trim()
  if (text.length < 2) return null
  const ids = [...root.querySelectorAll<HTMLElement>('[data-entry-id]')].filter(element => range.intersectsNode(element)).map(element => element.dataset.entryId!)
  const rect = range.getBoundingClientRect()
  return { text: text.slice(0, 2000), ids, x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }
}

interface Size { width: number; height: number }
/** The content area beside the sidebar; the island centers on it. */
interface Bounds extends Size { column: number }
const sameSize = <T extends object>(a: T | null, b: T) => a !== null && (Object.keys(b) as (keyof T)[]).every(key => a[key] === b[key])

/**
 * Real-time Q&A on the transcript being recorded, in the same Dynamic Island as the
 * notes chatbot: a pill centered at the bottom of the content area that opens on hover,
 * click or ⌘J. Selecting transcript or summary text shows a small action bar
 * (Hỏi · Giải thích · Dịch · Gợi ý trả lời). `onHold` pauses auto-scroll while the
 * user is picking or quoting a passage.
 */
export function LiveAssistant({ chat, entries, transcript, summary, onHold }: {
  chat: AppModel['liveChat']; entries: Subtitle[]; transcript: RefObject<HTMLElement | null>; summary?: RefObject<HTMLElement | null>; onHold?: (hold: boolean) => void
}) {
  const [pick, setPick] = useState<Pick | null>(null)
  const [open, setOpen] = useState(false)
  const [quote, setQuote] = useState<{ text: string; ids: string[] } | null>(null)
  const [draft, setDraft] = useState('')
  const [unseen, setUnseen] = useState(false)
  const [stage, setStage] = useState<HTMLElement | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const { messages, status } = chat
  const pending = status?.pending ?? false
  const streamed = Boolean(status?.answer?.answer)
  const canAsk = entries.length > 0
  const shell = useRef<HTMLElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const follow = useRef(true)
  const seen = useRef(messages.length)
  const autoOpen = useRef(false)
  // Hovering opens the island as a peek; it closes on leave unless the user engaged with it.
  const peek = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selected = () => readSelection([transcript.current, summary?.current ?? null])

  useLayoutEffect(() => { setStage(anchor.current?.closest<HTMLElement>('.main-stage') ?? null) }, [])

  const collapse = () => { setOpen(false); peek.current = false }
  const engage = () => { peek.current = false; clearTimeout(hoverTimer.current) }
  const focusInput = () => requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
  const openFor = (how: 'peek' | 'focus', next?: { text: string; ids: string[] } | null) => {
    clearTimeout(hoverTimer.current)
    peek.current = how === 'peek'
    if (next) setQuote(next)
    setOpen(true)
    if (how === 'focus') focusInput()
  }
  const onPointerEnter = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse') return
    clearTimeout(hoverTimer.current)
    if (!open && !pending && (canAsk || messages.length)) hoverTimer.current = setTimeout(() => openFor('peek'), 140)
  }
  const onPointerLeave = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse') return
    clearTimeout(hoverTimer.current)
    if (open && peek.current && !draft && !quote && shell.current?.ownerDocument.activeElement !== input.current) hoverTimer.current = setTimeout(collapse, 380)
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  // The shell takes the size of whichever layer is showing, so CSS can spring between them.
  useLayoutEffect(() => {
    if (!stage || !pill.current || !card.current) return
    const measure = () => {
      const layer = open ? card.current : pill.current
      if (!layer) return
      const next = { width: layer.offsetWidth, height: layer.offsetHeight }
      setSize(previous => sameSize(previous, next) ? previous : next)
      const area = { width: stage.clientWidth, height: stage.clientHeight, column: Math.min(680, stage.clientWidth - 48) }
      setBounds(previous => sameSize(previous, area) ? previous : area)
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const element of [stage, pill.current, card.current]) observer.observe(element)
    return () => observer.disconnect()
  }, [open, stage])

  // Show the action bar once a selection settles (pointer or keyboard), and keep it on the text while scrolling.
  useEffect(() => {
    const root = transcript.current
    const update = () => setPick(selected())
    const onChange = () => { if (document.getSelection()?.isCollapsed) setPick(null) }
    const onScroll = () => setPick(previous => previous && selected())
    document.addEventListener('pointerup', update)
    document.addEventListener('keyup', update)
    document.addEventListener('selectionchange', onChange)
    root?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerup', update)
      document.removeEventListener('keyup', update)
      document.removeEventListener('selectionchange', onChange)
      root?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [transcript, summary]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onHold?.(Boolean(pick || quote)) }, [pick, quote]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onHold?.(false), []) // eslint-disable-line react-hooks/exhaustive-deps
  // After sending, the island shrinks to a busy pill and opens again once the answer starts.
  useEffect(() => {
    if (autoOpen.current && (streamed || status?.error || !pending)) { autoOpen.current = false; openFor('focus') }
  }, [streamed, status?.error, pending]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (messages.length > seen.current && !open) setUnseen(true)
    seen.current = messages.length
  }, [messages.length, open])
  useEffect(() => {
    if (!open) return
    setUnseen(false)
    // The selection action bar lives outside the island; using it must not close the card.
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element
      if (!shell.current?.contains(target) && !target.closest?.('.live-ask-bar')) collapse()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])
  useLayoutEffect(() => {
    if (scroll.current && follow.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages.length, open, pending, status?.error, status?.answer?.answer])

  const clearSelection = () => { document.getSelection()?.removeAllRanges(); setPick(null) }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        const passage = selected()
        if (open && !passage) { collapse(); return }
        if (passage) clearSelection()
        openFor('focus', passage)
        return
      }
      if (event.key !== 'Escape') return
      if (pick) { event.stopPropagation(); clearSelection() }
      else if (open) { event.stopPropagation(); collapse() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, pick]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = (request: LiveQuestion) => {
    if (pending || !request.question.trim()) return
    follow.current = true
    autoOpen.current = true
    setOpen(false)
    void chat.ask(request)
  }
  const submit = () => {
    if (!draft.trim()) return
    send({ question: draft, quote: quote?.text, focusIds: quote?.ids })
    setDraft(''); setQuote(null)
  }
  const runAction = (id: typeof liveActions[number]['id']) => {
    if (!pick) return
    const action = liveActions.find(item => item.id === id)!
    send({ question: action.question, label: action.label, quote: pick.text, focusIds: pick.ids })
    clearSelection()
  }
  const showEvidence = (id: string) => {
    const element = transcript.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`)
    if (!element) return
    collapse()
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element.classList.remove('evidence-flash')
    void element.offsetWidth
    element.classList.add('evidence-flash')
    setTimeout(() => element.classList.remove('evidence-flash'), 1800)
  }

  const last = messages[messages.length - 1]
  const followUps = !status?.error && last?.role === 'assistant' ? last.followUps ?? [] : []
  const pillLabel = pending ? (streamed ? 'Đang viết câu trả lời…' : 'Đang đọc transcript…')
    : status?.error ? 'Chưa trả lời được · mở để thử lại'
    : unseen ? 'Có câu trả lời mới'
    : canAsk ? 'Hỏi AI về cuộc họp' : 'Hỏi AI khi có lời nói'
  const cardStyle: CSSProperties | undefined = bounds ? { width: bounds.column, maxHeight: Math.min(540, Math.round(bounds.height * 0.72)) } : undefined
  const bar = pick && !pending && createPortal(<div className={`live-ask-bar ${pick.top < 64 ? 'below' : ''}`} role="toolbar" aria-label="Hỏi AI về đoạn đã chọn"
    style={{ left: Math.min(Math.max(pick.x, 170), window.innerWidth - 170), top: pick.top < 64 ? pick.bottom + 8 : pick.top - 8 }}
    onPointerDown={event => event.preventDefault()}>
    <button type="button" className="primary" onClick={() => { const selected = { text: pick.text, ids: pick.ids }; clearSelection(); openFor('focus', selected) }}><Bot size={14}/>Hỏi</button>
    {liveActions.map(action => { const Icon = actionIcons[action.id]; return <button key={action.id} type="button" onClick={() => runAction(action.id)}><Icon size={14}/>{action.label}</button> })}
  </div>, document.body)

  const island = <section ref={shell} aria-label="Hỏi đáp trực tiếp" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onPointerDown={engage} onFocus={() => { if (open) engage() }}
    className={`note-chat island live-chat ${open ? 'open' : ''} ${pending ? 'busy' : ''} ${size && bounds ? 'ready' : ''}`}
    style={size && bounds ? { width: size.width, height: size.height, left: bounds.width / 2 - size.width / 2 } : undefined}>
    <button ref={pill} type="button" className="island-pill" inert={open} aria-hidden={open} aria-expanded={open}
      disabled={!open && !canAsk && !messages.length && !pending} onClick={() => openFor('focus')} title={`Hỏi AI (${isMac ? '⌘' : 'Ctrl+'}J) · hoặc bôi đen một đoạn transcript hay tóm tắt`}>
      {pending ? <Wave/> : status?.error && <CircleAlert size={16} className="island-error-icon"/>}
      <span className="island-label">{pillLabel}</span>
      {unseen && !pending && <span className="island-dot" aria-hidden="true"/>}
    </button>

    <div ref={card} className="island-card note-chat-body" inert={!open} aria-hidden={!open} style={cardStyle}>
      <header className="island-header">
        <span>{pending ? <Wave/> : <Bot size={15}/>}Hỏi đáp trực tiếp</span>
        <div className="note-chat-controls">
          <button type="button" className="chat-control chat-delete" disabled={pending || (!messages.length && !status?.error)} onClick={chat.reset} title="Xóa hội thoại" aria-label="Xóa hội thoại"><Trash2 size={15}/></button>
          <button type="button" className="chat-control" onClick={collapse} title="Thu nhỏ (Esc)" aria-label="Thu nhỏ khung chat"><ChevronDown size={16}/></button>
        </div>
      </header>
      {(messages.length > 0 || pending || status?.error) ? <div className="note-chat-messages" ref={scroll} role="log" aria-label="Lịch sử hỏi đáp" aria-live="polite" aria-busy={pending}
        onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60 }}>
        {messages.map(message => <article key={message.id} className={`chat-message ${message.role}`}>
          {message.role === 'user' ? <>{message.quote && <blockquote className="chat-quote">{message.quote}</blockquote>}<p>{message.content}</p></>
            : <><ChatMarkdown content={message.content}/>{Boolean(message.evidenceIds?.length) && <details className="chat-evidence"><summary>Căn cứ · {message.evidenceIds!.length}</summary><div>{message.evidenceIds!.map(id => { const entry = entries.find(item => item.id === id); return entry && <button key={id} type="button" onClick={() => showEvidence(id)} title={entry.sourceText}>{formatTime(entry.timestamp, false)}{entry.speaker ? ` · ${entry.speaker}` : ''}</button> })}</div></details>}</>}
        </article>)}
        {status && (pending || status.error) && <article className="chat-message user">{status.request.quote && <blockquote className="chat-quote">{status.request.quote}</blockquote>}<p>{status.request.label ?? status.request.question}</p></article>}
        {pending && streamed && <article className="chat-message assistant streaming"><ChatMarkdown content={status!.answer!.answer} streaming/><span className="chat-stream-caret" aria-hidden="true"/></article>}
        {pending && <div className="chat-thinking" role="status"><Wave/>{streamed ? 'AI đang viết…' : 'Đang đọc transcript và trả lời…'}</div>}
        {status?.error && <div className="chat-error" role="alert"><p>{status.error}</p><button type="button" className="copy-btn" onClick={() => send(status.request)}><RotateCcw size={14}/>Thử lại</button><button type="button" className="copy-btn" onClick={chat.dismissError}>Bỏ qua</button></div>}
      </div> : !quote && <p className="live-ask-hint">Bôi đen một đoạn transcript hoặc tóm tắt để <strong>Hỏi</strong>, <strong>Giải thích</strong>, <strong>Dịch</strong> hoặc <strong>Gợi ý trả lời</strong>, hoặc gõ câu hỏi bên dưới.</p>}
      {!pending && !quote && followUps.length > 0 && <div className="note-chat-prompts follow-ups" aria-label="Câu hỏi gợi ý">{followUps.map((question, index) => <button key={question} type="button" style={{ '--i': index } as CSSProperties} onClick={() => send({ question })}><Sparkles size={13}/>{question}</button>)}</div>}
      {quote && <div className="live-ask-quote"><span>“{quote.text}”</span><button type="button" onClick={() => { setQuote(null); focusInput() }} aria-label="Bỏ đoạn trích"><X size={13}/></button></div>}
      <form className="note-chat-form" onSubmit={event => { event.preventDefault(); submit() }}>
        <MessageCircle size={18} className="chat-input-icon" aria-hidden="true"/>
        <textarea ref={input} rows={1} maxLength={4000} value={draft} aria-label="Câu hỏi" disabled={!canAsk || pending}
          placeholder={quote ? 'Hỏi về đoạn này…' : canAsk ? 'Hỏi về những gì đang được nói…' : 'Chờ có lời nói để hỏi…'}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }}/>
        <button className="pill-btn primary" type="submit" disabled={pending || !canAsk || !draft.trim()} aria-label="Gửi câu hỏi"><Send size={16}/></button>
      </form>
    </div>
  </section>

  // The island sits on the content stage, not inside the page, so it stays centered at the bottom while the page scrolls.
  return <span ref={anchor} hidden>{bar}{stage && createPortal(island, stage)}</span>
}
