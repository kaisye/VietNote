import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, Folder, Maximize2, Minimize2, Mic, Sparkles, Square, Clock3 } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import { MeetingControls, TranslateSwitch } from '../components/MeetingControls'
import { formatTime } from '../services/notes'
import { AnimatedWaveform } from '../components/AnimatedWaveform'
import { visibleTranslation } from '../services/translationView'

const summaryHeadings = new Set(['TÓM TẮT NHANH', 'Ý CHÍNH', 'QUYẾT ĐỊNH', 'QUYẾT ĐỊNH TẠM THỜI', 'VẤN ĐỀ CHƯA CHỐT', 'VIỆC CẦN LÀM', 'CÂU HỎI MỞ', 'NỘI DUNG TẠM HOÃN'])
function SummaryText({ text }: { text: string }) {
  return <div className="live-summary-text">{text.split(/\n\n+/).map((block, index) => {
    const [heading, ...body] = block.split('\n')
    return summaryHeadings.has(heading)
      ? <section className="live-summary-block" key={index}><h4>{heading}</h4><p>{body.join('\n')}</p></section>
      : <p className="live-summary-block" key={index}>{block}</p>
  })}</div>
}

// Follows new content while the user is at the bottom; pauses once they scroll up to reread.
function useStickToBottom(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [following, setFollowing] = useState(true)
  const scrollToBottom = () => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stick.current = atBottom
    setFollowing(atBottom)
  }
  useLayoutEffect(() => { if (stick.current) scrollToBottom() }, deps)
  const resume = () => { stick.current = true; setFollowing(true); ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }) }
  return { ref, onScroll, following, resume }
}

export function HomePage({ model }: { model: AppModel }) {
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const transcriptScroll = useStickToBottom([model.entries, model.interimTranscripts, model.translationBlocks, summaryExpanded])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveTitle, setSaveTitle] = useState('')
  const [saveGroup, setSaveGroup] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const dateTitle = `Cuộc họp · ${new Date(model.meetingStartedAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}`
  const openSave = () => {
    setSaveTitle(model.suggestedTitle || dateTitle)
    setTitleEdited(false)
    setSaveGroup('')
    setSaveOpen(true)
    // Live summaries already carry a name; without one, ask for just the name.
    if (!model.suggestedTitle) model.suggestTitleNow()
  }
  // A suggestion that arrives while the dialog is open replaces the name until the user types.
  useEffect(() => { if (saveOpen && !titleEdited && model.suggestedTitle) setSaveTitle(model.suggestedTitle) }, [model.suggestedTitle])
  const pickTitle = (title: string) => { setSaveTitle(title); setTitleEdited(true) }
  return <main className="page-scroll"><div className="page-wrap home-wrap animate-in">
    {/* A running meeting folds the page header into its toolbar to leave room for the notes. */}
    {!model.meetingActive && <header className="page-header"><div><div className="eyebrow">LIVE MEETING NOTES</div><h1>Tóm tắt cuộc họp</h1><p>Lắng nghe, ghi lại và tóm tắt khi cuộc trò chuyện đang diễn ra.</p></div><div className="live-status"><span className="status-dot ready"/>Sẵn sàng</div></header>}
    {model.meetingActive ? <div className="active-meeting">
      <section className="glass-card active-toolbar"><div className="listening-icon"><AnimatedWaveform active={model.capturing}/></div><div className="active-toolbar-title"><h3>Tóm tắt cuộc họp</h3><p>{model.status}</p></div><div className="row-spacer"/><button className="pill-btn" onClick={model.summarizeNow} disabled={!model.canSummarizeNow}><Sparkles size={16}/>Cập nhật tóm tắt</button><button className="pill-btn primary" onClick={openSave} disabled={model.busy}><Square size={14} fill="currentColor"/>Kết thúc & lưu</button></section>
      <div className={`live-panels ${summaryExpanded ? 'summary-expanded' : ''}`}><section className="glass-card strong live-panel transcript-panel"><div className="panel-heading"><h3>Bản ghi trực tiếp</h3><small>{model.entries.length} câu · {model.translationBlocks.filter(block => block.kind !== 'live').length} đoạn dịch</small>{model.sourceLanguage !== 'vi' && <label className="panel-translate-toggle" title="Dịch tiếng nước ngoài sang tiếng Việt"><span>Dịch</span><TranslateSwitch model={model}/></label>}</div><div className="divider"/><div className="panel-scroll" ref={transcriptScroll.ref} onScroll={transcriptScroll.onScroll}>{model.entries.map(entry => { const blocks = [visibleTranslation(model.translationBlocks, entry.id)].filter(block => block !== undefined); return <div className="transcript-entry" key={entry.id}><small>{formatTime(entry.timestamp, false)} · {entry.audioSource === 'microphone' ? 'Mic' : 'System'} · {entry.speaker ?? 'Chưa xác định người nói'}{entry.speaker && entry.speakerProvisional ? ' (tạm)' : ''}</small><p>{entry.sourceText}</p>{blocks.map(block => <div key={block.id} className={`translation-result ${block.pending ? 'pending' : ''}`}><small>TIẾNG VIỆT · {block.kind === 'live' ? (block.pending ? 'ĐANG DỊCH TRỰC TIẾP' : 'SONIOX') : (block.pending ? 'ĐANG DỊCH CẢ ĐOẠN' : 'BẢN DỊCH THEO ĐOẠN')}</small><p>{block.translatedText}</p></div>)}</div> })}{model.interimTranscripts.map(item => { const translated = model.translationBlocks.find(block => block.kind === 'live' && block.id === item.id); if (!item.showSource && !translated) return null; return <div className="transcript-entry interim" key={item.id}><small>{item.showSource ? 'ĐANG NHẬN DIỆN' : 'ĐANG DỊCH'} · {item.source === 'microphone' ? 'Mic' : 'System'}{item.speaker ? ` · ${item.speaker} (tạm)` : ''}</small>{item.showSource && <p>{item.text}</p>}{translated && <div className="translation-result pending"><small>TIẾNG VIỆT · ĐANG DỊCH TRỰC TIẾP</small><p>{translated.translatedText}</p></div>}</div> })}{!model.entries.length && !model.interimTranscripts.length && <p className="muted">Lời nói sẽ xuất hiện tại đây ngay khi nhận diện được…</p>}</div>{!transcriptScroll.following && <button className="pill-btn jump-latest" onClick={transcriptScroll.resume}><ArrowDown size={14}/>Mới nhất</button>}</section>
        <section className="glass-card strong live-panel summary-panel"><div className="panel-heading"><h3>Tóm tắt cuộc họp</h3><button className="icon-btn panel-expand" onClick={() => setSummaryExpanded(value => !value)} aria-pressed={summaryExpanded} aria-label={summaryExpanded ? 'Thu nhỏ tóm tắt' : 'Mở rộng tóm tắt'} title={summaryExpanded ? 'Hiện lại bản ghi' : 'Chỉ xem tóm tắt'}>{summaryExpanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button></div><div className="divider"/><small className="accent-text">{model.summaryStatus}</small><div className="panel-scroll summary-scroll"><section className="overall-summary"><div className="summary-section-title"><Sparkles size={14}/><strong>TỔNG QUAN CUỘC HỌP</strong></div>{model.overallSummary ? <SummaryText text={model.overallSummary}/> : <p className="muted">Tổng quan sẽ được cập nhật liên tục để phản ánh toàn bộ nội dung cuộc họp.</p>}</section></div></section></div></div> :
      <div className="idle-meeting"><div className="start-visual"><div className="outer-ring"/><div className="middle-ring"/><div className="inner-ring"/><div className="orbit-track"><span/></div><button className="start-button" onClick={() => void model.startMeeting()} disabled={!model.canStartMeeting || model.busy} aria-label="Bắt đầu tóm tắt cuộc họp"><Mic size={35} fill="currentColor"/><AnimatedWaveform compact/><strong>Bắt đầu tóm tắt</strong></button></div><div className="idle-copy"><h2>Một chạm để bắt đầu</h2><p>Bản ghi xuất hiện ngay khi nhận diện được lời nói.</p></div><MeetingControls model={model}/>{!model.ready && <small className="accent-text"><Clock3 size={13}/>{model.status}</small>}{model.ready && model.startError && <small className="accent-text">{model.startError}</small>}</div>}
  </div>{saveOpen && <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSaveOpen(false) }}><form className="app-dialog" role="dialog" aria-modal="true" aria-label="Lưu cuộc họp" onSubmit={event => { event.preventDefault(); setSaveOpen(false); void model.stop({ title: saveTitle, groupID: saveGroup || null }) }}><h2>Lưu cuộc họp</h2><label className="field"><span>TÊN CUỘC HỌP</span><input autoFocus value={saveTitle} onChange={event => pickTitle(event.target.value)} required/></label><div className="title-suggestions" aria-live="polite">{model.titlePending && !model.suggestedTitle ? <small className="muted"><Sparkles size={13}/>Đang đặt tên…</small> : <>{model.suggestedTitle && <button type="button" className={`title-chip ${saveTitle === model.suggestedTitle ? 'selected' : ''}`} onClick={() => pickTitle(model.suggestedTitle)}><Sparkles size={13}/>{model.suggestedTitle}</button>}<button type="button" className={`title-chip ${saveTitle === dateTitle ? 'selected' : ''}`} onClick={() => pickTitle(dateTitle)}><Clock3 size={13}/>{dateTitle}</button></>}</div><label className="field"><span>NHÓM GHI CHÚ</span><div className="meeting-choice"><Folder size={17}/><select value={saveGroup} onChange={event => setSaveGroup(event.target.value)}><option value="">Tất cả</option>{model.noteGroups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select><ChevronDown size={17}/></div></label><div className="dialog-actions"><button type="button" className="pill-btn" onClick={() => setSaveOpen(false)}>Tiếp tục ghi</button><button className="pill-btn primary" type="submit">Dừng, tóm tắt & lưu</button></div></form></div>}</main>
}
