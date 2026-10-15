import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, LoaderCircle, MessageCircle, Send, Sparkles, X } from 'lucide-react'
import { ChatMarkdown } from './ChatMarkdown'
import { desktop, type NoteChatAnswer } from '../services/desktop'
import { watchChatHistory, watchChatSegments, type WatchChatTurn } from '../services/watchChat'
import { clock, type WatchLine } from '../services/youtube'

interface Evidence { id: string; time: number; label: string; source: string }
interface Message extends WatchChatTurn { evidence?: Evidence[]; quote?: string }
export interface ScriptQuote { text: string; time: number; prompt?: string }

/** A compact video Q&A island. Nothing is saved to notes; each video keeps its own session. */
export function WatchChat({ title, lines, recent, quote, onClearQuote, onSeek }: { title: string; lines: WatchLine[]; recent: WatchLine | null; quote: ScriptQuote | null; onClearQuote: () => void; onSeek: (time: number) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [pending, setPending] = useState(false)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState('')
  const [failed, setFailed] = useState<{ question: string; quote?: string } | null>(null)
  const [unseen, setUnseen] = useState(false)
  const shell = useRef<HTMLElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const run = useRef(0)
  const openRef = useRef(false)
  const actionSent = useRef<ScriptQuote | null>(null)
  const peek = useRef(false)
  const hoverOpen = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverClose = useRef<ReturnType<typeof setTimeout> | null>(null)
  const segments = useMemo(() => watchChatSegments(lines), [lines])
  const clearHoverTimers = () => { if (hoverOpen.current) clearTimeout(hoverOpen.current); if (hoverClose.current) clearTimeout(hoverClose.current) }
  const close = () => { clearHoverTimers(); peek.current = false; openRef.current = false; setOpen(false) }
  const engage = () => { clearHoverTimers(); peek.current = false }
  const enter = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    clearHoverTimers()
    if (!open) hoverOpen.current = setTimeout(() => { peek.current = true; openRef.current = true; setOpen(true) }, 140)
  }
  const leave = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    if (hoverOpen.current) clearTimeout(hoverOpen.current)
    if (open && peek.current) hoverClose.current = setTimeout(close, 260)
  }

  useEffect(() => () => { run.current++; clearHoverTimers() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (quote) { engage(); openRef.current = true; setOpen(true) } }, [quote]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    openRef.current = true
    setUnseen(false)
    if (!peek.current) input.current?.focus({ preventScroll: true })
    const reveal = peek.current ? null : window.setTimeout(() => shell.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 520)
    const outside = (event: PointerEvent) => { if (!shell.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => { if (reveal !== null) window.clearTimeout(reveal); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true) }
  }, [open])
  useEffect(() => { if (open && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [open, messages, partial, pending, error])

  const ask = async (question: string, retry = false) => {
    const text = question.trim()
    if (!text || pending) return
    const id = ++run.current
    const history = watchChatHistory(retry ? messages.slice(0, -1) : messages)
    const chosen = retry ? null : quote
    const requestQuote = retry ? failed?.quote : chosen
      ? `Đoạn trích đã chọn lúc ${clock(chosen.time)}: ${chosen.text}`
      : recent ? `Phụ đề vừa xem lúc ${clock(recent.start)} — Lời gốc: ${recent.source}${recent.translation ? `; Tiếng Việt: ${recent.translation}` : ''}` : undefined
    if (!retry) setMessages(previous => [...previous, { role: 'user', content: text, quote: chosen?.text }])
    setDraft(''); setError(''); setFailed(null); onClearQuote(); setPartial(''); setPending(true); openRef.current = true; setOpen(true)
    try {
      const answer = await desktop.askNote({
        title, summary: '', transcript: '', segments, history, question: text, videoMode: 'flexible',
        quote: requestQuote,
      }, (progress: NoteChatAnswer) => { if (run.current === id) setPartial(progress.answer) })
      if (run.current !== id) return
      const evidence = answer.evidenceIds.flatMap(evidenceId => {
        const segment = segments.find(item => item.id === evidenceId)
        return segment ? [{ id: evidenceId, time: segment.startedAt, label: segment.timestamp, source: segment.rawText }] : []
      })
      setMessages(previous => [...previous, { role: 'assistant', content: answer.answer, evidence }])
      setPartial(''); setUnseen(!openRef.current)
    } catch (failure) {
      if (run.current !== id) return
      setError(String(failure)); setFailed({ question: text, quote: requestQuote })
    } finally { if (run.current === id) setPending(false) }
  }

  useEffect(() => {
    if (quote?.prompt && actionSent.current !== quote) { actionSent.current = quote; void ask(quote.prompt) }
  }, [quote]) // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(<div className="watch-chat-dock"><section ref={shell} className={`watch-chat-island ${open ? 'open' : ''} ${pending ? 'busy' : ''}`} aria-label="Hỏi AI về video" onPointerEnter={enter} onPointerLeave={leave} onPointerDown={engage} onFocus={() => { if (open) engage() }}>
    <button type="button" className="watch-chat-pill" aria-expanded={open} tabIndex={open ? -1 : 0} onClick={() => { engage(); openRef.current = true; setOpen(true) }}>
      {pending ? <LoaderCircle size={16} className="speech-loading"/> : <Sparkles size={16}/>}
      {pending ? 'AI đang trả lời…' : unseen ? 'Có câu trả lời mới' : 'Hỏi AI về video'}
      {unseen && !pending && <span className="island-dot" aria-hidden="true"/>}
    </button>
    <div className="watch-chat-card" role="dialog" aria-label="Hỏi đáp video" aria-hidden={!open} inert={!open}>
      <header className="island-header"><span><Sparkles size={14}/>Hỏi AI về video</span><button type="button" className="chat-control" onClick={close} aria-label="Thu nhỏ hỏi đáp" title="Thu nhỏ (Esc)"><ChevronDown size={17}/></button></header>
      <p className="watch-chat-hint">{segments.length ? 'Hỏi về lời thoại hoặc bất cứ điều gì. AI sẽ phân biệt nội dung video với kiến thức chung.' : 'Video chưa có lời thoại; bạn vẫn có thể hỏi AI những câu hỏi chung.'}</p>
      {quote && <div className="watch-chat-recent" aria-label="Đoạn lời thoại đã chọn"><div><span>Đoạn đã chọn · {clock(quote.time)}</span><button type="button" onClick={onClearQuote} aria-label="Bỏ đoạn đã chọn" title="Bỏ đoạn đã chọn"><X size={14}/></button></div><strong>{quote.text}</strong></div>}
      <div className="note-chat-messages" ref={scroll} role="log" aria-label="Lịch sử hỏi đáp video" aria-live="polite" aria-busy={pending}>
        {!messages.length && !pending && <div className="watch-chat-empty"><MessageCircle size={22}/><strong>Bạn muốn biết gì?</strong><span>Hỏi về video hoặc một chủ đề bạn đang tò mò.</span></div>}
        {messages.map((message, index) => <article key={index} className={`chat-message ${message.role}`}>
          {message.role === 'assistant' ? <ChatMarkdown content={message.content}/> : <>{message.quote && <blockquote className="chat-quote">{message.quote}</blockquote>}<p>{message.content}</p></>}
          {message.role === 'assistant' && Boolean(message.evidence?.length) && <div className="watch-chat-evidence" aria-label="Đoạn video liên quan">{message.evidence?.map(item => <button key={item.id} type="button" title={item.source} onClick={() => { onSeek(item.time); close() }}>{item.label}</button>)}</div>}
        </article>)}
        {pending && <>{partial && <article className="chat-message assistant streaming"><ChatMarkdown content={partial} streaming/></article>}<div className="chat-thinking" role="status"><LoaderCircle size={15} className="speech-loading"/>{partial ? 'AI đang viết…' : 'AI đang suy nghĩ…'}</div></>}
        {error && <div className="chat-error" role="alert"><p>{error}</p><button type="button" className="copy-btn" onClick={() => { if (failed) void ask(failed.question, true) }}>Thử lại</button></div>}
      </div>
      {quote && !pending && <button type="button" className="watch-chat-quote-action" onClick={() => void ask('Giải thích đoạn đã chọn trong ngữ cảnh video.')}>Giải thích đoạn này</button>}
      <form className="note-chat-form" onSubmit={event => { event.preventDefault(); void ask(draft) }}>
        <MessageCircle size={17} className="chat-input-icon" aria-hidden="true"/>
        <textarea ref={input} aria-label="Câu hỏi về video" placeholder={quote ? 'Hỏi về đoạn đã chọn…' : 'Hỏi bất cứ điều gì…'} rows={1} maxLength={4000} value={draft} disabled={pending} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(draft) } }}/>
        <button className="pill-btn primary" type="submit" disabled={pending || !draft.trim()} aria-label="Gửi câu hỏi"><Send size={16}/></button>
      </form>
    </div>
  </section></div>, document.body)
}
