import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Lightbulb, List, Sparkles } from 'lucide-react'
import { WatchChat, type ScriptQuote } from './WatchChat'
import { collectWatched } from '../services/watchScript'
import { clock, lineBefore, type WatchLine } from '../services/youtube'

interface Pick extends ScriptQuote { x: number; top: number; bottom: number }

function selectedPassage(root: HTMLElement | null): Pick | null {
  const selection = document.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (!root || !range || selection?.isCollapsed || !root.contains(range.commonAncestorContainer)) return null
  const text = range.toString().replace(/\s+/g, ' ').trim().slice(0, 2000)
  if (text.length < 2) return null
  const rect = range.getBoundingClientRect()
  const viewport = root.getBoundingClientRect()
  if (rect.bottom < viewport.top || rect.top > viewport.bottom) return null
  const first = [...root.querySelectorAll<HTMLElement>('[data-start]')].find(element => range.intersectsNode(element))
  return { text, time: Number(first?.dataset.start ?? 0), x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }
}

/** Show only lines actually watched, with a selection path into the AI island. */
export function WatchScripts({ title, lines, time, onSeek, onWatchedChange }: { title: string; lines: WatchLine[]; time: number; onSeek: (time: number) => void; onWatchedChange?: (watched: WatchLine[]) => void }) {
  const [watched, setWatched] = useState<WatchLine[]>([])
  const [pick, setPick] = useState<Pick | null>(null)
  const [quote, setQuote] = useState<ScriptQuote | null>(null)
  const before = useRef(-1)
  const scriptScroll = useRef<HTMLDivElement>(null)
  const followScript = useRef(true)

  useEffect(() => {
    setWatched(previous => collectWatched(previous, lines, before.current, time))
    before.current = time
  }, [lines, time])
  useEffect(() => { onWatchedChange?.(watched) }, [watched, onWatchedChange])
  useEffect(() => {
    if (followScript.current && scriptScroll.current) scriptScroll.current.scrollTop = scriptScroll.current.scrollHeight
  }, [watched.length])
  const recentIndex = lineBefore(lines, time)
  const recent = recentIndex >= 0 ? lines[recentIndex] : null

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!scriptScroll.current?.contains(event.target as Node) && !(event.target as Element).closest?.('.watch-selection-bar')) setPick(null)
    }
    const onSelectionChange = () => { if (document.getSelection()?.isCollapsed) setPick(null) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('selectionchange', onSelectionChange) }
  }, [])
  const captureSelection = () => { const next = selectedPassage(scriptScroll.current); setPick(next); if (next) followScript.current = false }
  const useSelection = (prompt?: string) => {
    if (!pick) return
    setQuote({ text: pick.text, time: pick.time, prompt }); setPick(null)
    document.getSelection()?.removeAllRanges()
  }

  return <>
    <section className="glass-card strong watch-scripts-panel" aria-label="Lời thoại đã xem">
      <header className="watch-scripts-panel-head panel-heading">
        <div><h3>Lời thoại đã xem</h3><small>{watched.length} câu · Bôi đen để hỏi AI</small></div>
      </header>
      <div className="divider"/>
      <div className="watch-script-lines" ref={scriptScroll} onPointerUp={captureSelection} onKeyUp={captureSelection} onScroll={event => { const element = event.currentTarget; followScript.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; if (pick) setPick(selectedPassage(element)) }} tabIndex={0}>
        {watched.length ? watched.map((item, index) => <article className="watch-script-line" key={`${item.start}-${index}`} data-start={item.start}>
          <button type="button" className="watch-script-time" onClick={() => onSeek(item.start)} title="Tua đến câu này">{clock(item.start)}</button>
          <div className="watch-script-text"><p>{item.translation || item.source}</p>{item.translation && item.translation !== item.source && <small>{item.source}</small>}</div>
        </article>) : <p className="watch-script-empty">Hãy phát video để lời thoại xuất hiện ở đây.</p>}
      </div>
    </section>
    {pick && createPortal(<div className={`live-ask-bar watch-selection-bar ${pick.top < 64 ? 'below' : ''}`} role="toolbar" aria-label="Thao tác với lời thoại đã chọn"
      style={{ left: Math.min(Math.max(pick.x, 190), window.innerWidth - 190), top: pick.top < 64 ? pick.bottom + 8 : pick.top - 8 }} onPointerDown={event => event.preventDefault()}>
      <button type="button" className="primary" onClick={() => useSelection()}><Bot size={14}/>Hỏi</button>
      <button type="button" onClick={() => useSelection('Giải thích đoạn đã chọn trong ngữ cảnh video một cách dễ hiểu.')}><Lightbulb size={14}/>Giải thích</button>
      <button type="button" onClick={() => useSelection('Tóm tắt ngắn gọn ý chính của đoạn đã chọn.')}><List size={14}/>Tóm tắt</button>
      <button type="button" onClick={() => useSelection('Gợi ý 3 câu hỏi thú vị để tìm hiểu sâu hơn về đoạn đã chọn.')}><Sparkles size={14}/>Gợi ý</button>
    </div>, document.body)}
    <WatchChat title={title} lines={lines} recent={recent} quote={quote} onClearQuote={() => setQuote(null)} onSeek={onSeek}/>
  </>
}
