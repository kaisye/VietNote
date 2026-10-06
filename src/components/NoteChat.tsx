import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { MessageCircle, Send, Sparkles, RotateCcw, ChevronDown, Maximize2, Minimize2, Trash2, CircleAlert } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { MeetingNote } from '../services/types'
import { noteChatPrompts } from '../services/noteChat'
import { ChatMarkdown } from './ChatMarkdown'
import { formatTime } from '../services/notes'

interface Size { width: number; height: number }
/** The editor area plus the note's text column, which the open card lines up with. */
interface Bounds extends Size { column: number; center: number }
const sameSize = <T extends object>(a: T | null, b: T) => a !== null && (Object.keys(b) as (keyof T)[]).every(key => a[key] === b[key])

function Wave() {
  return <span className="island-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span>
}

/**
 * A Dynamic Island–style assistant: a small pill at rest that morphs into a card.
 * Both layers stay mounted; the shell animates between their measured sizes.
 * `left` moves with `width` on the same curve, so the island grows equally to both sides.
 */
export function NoteChat({ note, chat, onEvidence }: {
  note: MeetingNote; chat: AppModel['noteChat']; onEvidence: (ids: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const [size, setSize] = useState<Size | null>(null)
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const messages = note.chatMessages ?? []
  const status = chat.statuses[note.id]
  const pending = status?.pending ?? false
  const last = messages[messages.length - 1]
  const followUps = !status?.error && last?.role === 'assistant' ? last.followUps ?? [] : []
  const streamed = Boolean(status?.answer?.answer)
  const hasContent = Boolean(note.summary.trim() || note.transcript.trim() || note.transcriptSegments?.some(segment => segment.cleanText.trim()))
  const disabled = pending || note.saving || !hasContent
  const followOutput = useRef(true)
  const autoOpen = useRef(false)
  // Hovering opens the island as a peek; it closes on leave unless the user engaged with it.
  const peek = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seenCount = useRef(messages.length)
  const shell = useRef<HTMLElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const collapse = () => { setOpen(false); setFull(false); setConfirmClear(false); peek.current = false }
  const engage = () => { peek.current = false; clearTimeout(hoverTimer.current) }
  const openFor = (how: 'peek' | 'focus') => { clearTimeout(hoverTimer.current); peek.current = how === 'peek'; setOpen(true) }
  const onPointerEnter = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse') return
    clearTimeout(hoverTimer.current)
    if (!open && !pending && (hasContent || messages.length)) hoverTimer.current = setTimeout(() => openFor('peek'), 140)
  }
  const onPointerLeave = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse') return
    clearTimeout(hoverTimer.current)
    if (open && peek.current && !draft && !full && !confirmClear && shell.current?.ownerDocument.activeElement !== input.current) hoverTimer.current = setTimeout(collapse, 380)
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  // The shell takes the size of whichever layer is showing, so CSS can spring between them.
  useLayoutEffect(() => {
    const editor = shell.current?.closest<HTMLElement>('.note-editor')
    if (!editor || !pill.current || !card.current) return
    const measure = () => {
      const layer = open ? card.current : pill.current
      if (!layer) return
      const next = { width: layer.offsetWidth, height: layer.offsetHeight }
      setSize(previous => sameSize(previous, next) ? previous : next)
      const column = editor.querySelector<HTMLElement>('.note-editor-scroll')
      const style = column && getComputedStyle(column)
      const left = style ? parseFloat(style.paddingLeft) : 28
      const width = column && style ? column.clientWidth - left - parseFloat(style.paddingRight) : editor.clientWidth - 56
      const area = { width: editor.clientWidth, height: editor.clientHeight, column: width, center: left + width / 2 }
      setBounds(previous => sameSize(previous, area) ? previous : area)
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const element of [editor, editor.querySelector('.note-editor-scroll'), pill.current, card.current]) if (element) observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  // After sending, the island shrinks to a busy pill and opens again once the answer starts.
  useEffect(() => {
    if (autoOpen.current && (streamed || status?.error || !pending)) { autoOpen.current = false; openFor('focus') }
  }, [streamed, status?.error, pending])
  useEffect(() => {
    if (messages.length > seenCount.current && !open) setUnseen(true)
    seenCount.current = messages.length
  }, [messages.length, open])
  useEffect(() => {
    if (!open) return
    setUnseen(false)
    if (!pending && !peek.current) input.current?.focus({ preventScroll: true })
    const onDown = (event: PointerEvent) => { if (!shell.current?.contains(event.target as Node)) collapse() }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (scroll.current && followOutput.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages.length, pending, open, full, status?.error, status?.answer?.answer])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !open) return
      event.stopPropagation()
      if (confirmClear) setConfirmClear(false); else if (full) setFull(false); else setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, full, confirmClear])

  const send = (question: string) => {
    if (disabled || !question.trim()) return
    followOutput.current = true
    autoOpen.current = true
    setConfirmClear(false)
    setDraft('')
    if (!full) setOpen(false)
    void chat.ask(note.id, question)
  }

  const pillLabel = pending ? (streamed ? 'Đang viết câu trả lời…' : 'Đang đọc transcript…')
    : status?.error ? 'Chưa trả lời được · mở để thử lại'
    : unseen ? 'Có câu trả lời mới'
    : !hasContent && !messages.length ? 'Ghi chú chưa có nội dung để hỏi'
    : 'Hỏi về cuộc họp này'
  const cardStyle: CSSProperties | undefined = bounds ? full
    ? { width: bounds.width - 24, height: bounds.height - 24 }
    : { width: bounds.column, maxHeight: Math.min(560, Math.round(bounds.height * 0.72)) }
    : undefined

  return <section ref={shell} aria-label="Hỏi đáp cuộc họp" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onPointerDown={engage} onFocus={() => { if (open) engage() }}
    className={`note-chat island ${open ? 'open' : ''} ${full ? 'full' : ''} ${pending ? 'busy' : ''} ${size && bounds ? 'ready' : ''}`}
    style={size && bounds ? { width: size.width, height: size.height, left: (full ? bounds.width / 2 : bounds.center) - size.width / 2 } : undefined}>
    <button ref={pill} type="button" className="island-pill" inert={open} aria-hidden={open} aria-expanded={open}
      disabled={!open && !hasContent && !messages.length && !pending} onClick={() => openFor('focus')}>
      {pending ? <Wave/> : status?.error ? <CircleAlert size={16} className="island-error-icon"/> : <Sparkles size={16} className="island-spark"/>}
      <span className="island-label">{pillLabel}</span>
      {unseen && !pending && <span className="island-dot" aria-hidden="true"/>}
    </button>

    <div ref={card} id={`chat-${note.id}`} className="island-card note-chat-body" inert={!open} aria-hidden={!open} style={cardStyle}>
      <header className="island-header">
        <span>{pending ? <Wave/> : <Sparkles size={14}/>}Hỏi đáp cuộc họp</span>
        <div className="note-chat-controls">
          <button type="button" className="chat-control chat-delete" disabled={pending || (!messages.length && !status?.error)} onClick={() => setConfirmClear(value => !value)} aria-label="Xóa lịch sử chat" title={pending ? 'Chờ AI trả lời xong để xóa lịch sử' : 'Xóa lịch sử chat'} aria-expanded={confirmClear} aria-controls={`chat-clear-${note.id}`}><Trash2 size={15}/></button>
          <button type="button" className="chat-control" onClick={() => setFull(value => !value)} aria-pressed={full} aria-label={full ? 'Khôi phục kích thước chat' : 'Phóng to chat'} title={full ? 'Khôi phục kích thước (Esc)' : 'Phóng to chat'}>{full ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>
          <button type="button" className="chat-control" onClick={collapse} aria-label="Thu nhỏ khung chat" title="Thu nhỏ (Esc)"><ChevronDown size={16}/></button>
        </div>
      </header>
      {confirmClear && <div id={`chat-clear-${note.id}`} className="chat-clear-confirm" role="group" aria-label="Xác nhận xóa lịch sử chat"><span>Xóa toàn bộ lịch sử chat của ghi chú này?</span><button type="button" className="copy-btn" onClick={() => setConfirmClear(false)}>Hủy</button><button type="button" className="copy-btn danger" disabled={pending} onClick={() => { chat.clear(note.id); setConfirmClear(false); followOutput.current = true }}>Xóa lịch sử</button></div>}
      {(messages.length > 0 || pending || status?.error) && <div className="note-chat-messages" ref={scroll} onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80 }} role="log" aria-label="Lịch sử hỏi đáp" aria-live="polite" aria-relevant="additions text" aria-busy={pending}>
        {messages.map(message => <article key={message.id} className={`chat-message ${message.role}`}>{message.role === 'assistant' ? <ChatMarkdown content={message.content} streaming={message.incomplete}/> : <>{message.quote && <blockquote className="chat-quote">{message.quote}</blockquote>}<p>{message.content}</p></>}{message.role === 'assistant' && Boolean(message.evidenceIds?.length) && <details className="chat-evidence"><summary>Căn cứ · {message.evidenceIds!.length}</summary><div>{message.evidenceIds?.map(id => { const segment = note.transcriptSegments?.find(item => item.id === id); return segment && <button key={id} onClick={() => { collapse(); onEvidence([id]) }} title={segment.cleanText}>{formatTime(segment.timestamp, false)}{segment.speaker ? ` · ${segment.speaker}` : ''}</button> })}</div></details>}{message.incomplete && <div className="chat-incomplete"><small>Câu trả lời chưa hoàn tất. Bạn có thể yêu cầu AI viết tiếp.</small>{message.id === messages.at(-1)?.id && <button className="copy-btn" disabled={disabled} onClick={() => send('Tiếp tục câu trả lời vừa bị ngắt, hoàn thành phần còn lại của yêu cầu trước đó. Không lặp lại những nội dung đã trả lời.')}>Viết tiếp</button>}</div>}</article>)}
        {pending && <><article className="chat-message user"><p>{status.question}</p></article>{streamed && <article className="chat-message assistant streaming"><ChatMarkdown content={status.answer!.answer} streaming/><span className="chat-stream-caret" aria-hidden="true"/></article>}<div className="chat-thinking" role="status"><Wave/>{streamed ? 'AI đang viết…' : 'Đang đọc nội dung và trả lời…'}</div></>}
        {status?.error && <div className="chat-error" role="alert"><p><strong>Chưa trả lời được:</strong> {status.question}</p><p>{status.error}</p><button className="copy-btn" disabled={disabled} onClick={() => send(status.question)}><RotateCcw size={14}/>Thử lại</button><button className="copy-btn" disabled={disabled} onClick={() => { setDraft(status.question); input.current?.focus() }}>Sửa câu hỏi</button></div>}
      </div>}
      {!pending && followUps.length > 0 && <div className="note-chat-prompts follow-ups" aria-label="Câu hỏi gợi ý">{followUps.map((question, index) => <button key={question} type="button" style={{ '--i': index } as CSSProperties} disabled={disabled} onClick={() => send(question)}><Sparkles size={13}/>{question}</button>)}</div>}
      {!pending && !followUps.length && <div className="note-chat-prompts">{noteChatPrompts.map((prompt, index) => <button key={prompt.label} type="button" style={{ '--i': index } as CSSProperties} disabled={disabled} onClick={() => send(prompt.question)}><Sparkles size={13}/>{prompt.label}</button>)}</div>}
      <form className="note-chat-form" onSubmit={event => { event.preventDefault(); send(draft) }}><MessageCircle size={18} className="chat-input-icon" aria-hidden="true"/><textarea ref={input} aria-label="Câu hỏi về cuộc họp" placeholder="Hỏi bất cứ điều gì về cuộc họp…" rows={1} maxLength={4000} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(draft) } }}/><button className="pill-btn primary" type="submit" disabled={disabled || !draft.trim()} aria-label="Gửi câu hỏi"><Send size={16}/></button></form>
    </div>
  </section>
}
