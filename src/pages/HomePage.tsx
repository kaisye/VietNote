import { useState } from 'react'
import { ChevronDown, Folder, Mic, Sparkles, Square, Clock3 } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import { MeetingControls } from '../components/MeetingControls'
import { formatTime } from '../services/notes'
import { AnimatedWaveform } from '../components/AnimatedWaveform'

const summaryHeadings = new Set(['TÓM TẮT NHANH', 'Ý CHÍNH', 'QUYẾT ĐỊNH', 'QUYẾT ĐỊNH TẠM THỜI', 'VẤN ĐỀ CHƯA CHỐT', 'VIỆC CẦN LÀM', 'CÂU HỎI MỞ', 'NỘI DUNG TẠM HOÃN'])
function SummaryText({ text }: { text: string }) {
  return <div className="live-summary-text">{text.split(/\n\n+/).map((block, index) => {
    const [heading, ...body] = block.split('\n')
    return summaryHeadings.has(heading)
      ? <section className="live-summary-block" key={index}><h4>{heading}</h4><p>{body.join('\n')}</p></section>
      : <p className="live-summary-block" key={index}>{block}</p>
  })}</div>
}

export function HomePage({ model }: { model: AppModel }) {
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveTitle, setSaveTitle] = useState('')
  const [saveGroup, setSaveGroup] = useState('')
  const openSave = () => {
    setSaveTitle(`Cuộc họp · ${new Date(model.meetingStartedAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}`)
    setSaveGroup('')
    setSaveOpen(true)
  }
  return <main className="page-scroll"><div className="page-wrap home-wrap animate-in">
    <header className="page-header"><div><div className="eyebrow">LIVE MEETING NOTES</div><h1>Tóm tắt cuộc họp</h1><p>Lắng nghe, ghi lại và tóm tắt khi cuộc trò chuyện đang diễn ra.</p></div><div className="live-status"><span className="status-dot ready"/>{model.meetingActive ? 'Đang ghi nhận' : 'Sẵn sàng'}</div></header>
    {model.meetingActive ? <div className="active-meeting">
      <section className="glass-card active-toolbar"><div className="listening-icon"><AnimatedWaveform active={model.capturing}/></div><div><h3>Đang lắng nghe</h3><p>{model.status}</p></div><div className="row-spacer"/><button className="pill-btn" onClick={model.summarizeNow} disabled={!model.canSummarizeNow}><Sparkles size={16}/>Tóm tắt đoạn này</button><button className="pill-btn primary" onClick={openSave} disabled={model.busy}><Square size={14} fill="currentColor"/>Kết thúc & lưu</button></section>
      <div className="live-panels"><section className="glass-card strong live-panel"><div className="panel-heading"><h3>Bản ghi trực tiếp</h3><small>{model.entries.length} câu · {model.translationBlocks.length} đoạn dịch</small></div><div className="divider"/><div className="panel-scroll">{model.entries.length ? model.entries.map(entry => { const block = model.translationBlocks.find(item => item.entryIds.at(-1) === entry.id); return <div className="transcript-entry" key={entry.id}><small>{formatTime(entry.timestamp, false)} · {entry.audioSource === 'microphone' ? 'Mic' : 'System'}</small><p>{entry.sourceText}</p>{block && <div className={`translation-result ${block.pending ? 'pending' : ''}`}><small>TIẾNG VIỆT · DỊCH THEO ĐOẠN</small><p>{block.translatedText}</p></div>}</div> }) : <p className="muted">Lời nói sẽ xuất hiện tại đây sau vài giây…</p>}</div></section>
        <section className="glass-card strong live-panel summary-panel"><div className="panel-heading"><h3>Tóm tắt cuộc họp</h3><small>{model.summaryHistory.length} lần cập nhật</small></div><div className="divider"/><small className="accent-text">{model.summaryStatus}</small><div className="panel-scroll summary-scroll"><section className="overall-summary"><div className="summary-section-title"><Sparkles size={14}/><strong>TỔNG QUAN CUỘC HỌP</strong></div>{model.overallSummary ? <SummaryText text={model.overallSummary}/> : <p className="muted">Tổng quan sẽ được cập nhật liên tục để phản ánh toàn bộ nội dung cuộc họp.</p>}</section><div className="latest-summary-heading"><strong>NỘI DUNG MỚI NHẤT</strong></div>{model.summaryHistory.length ? (() => { const item = model.summaryHistory.at(-1)!; return <article className={`summary-snapshot ${item.isManual ? 'manual' : ''}`} key={item.id}><div className="snapshot-meta"><strong>{item.isManual ? 'THỦ CÔNG' : 'TỰ ĐỘNG'}</strong><small>{formatTime(item.createdAt, false)} · {item.entryCount} câu</small></div><SummaryText text={item.text}/></article> })() : <p className="muted">Phần tóm tắt gần nhất sẽ xuất hiện tại đây. Nhấn “Tóm tắt đoạn này” để cập nhật ngay.</p>}</div></section></div></div> :
      <div className="idle-meeting"><div className="start-visual"><div className="outer-ring"/><div className="middle-ring"/><div className="inner-ring"/><div className="orbit-track"><span/></div><button className="start-button" onClick={() => void model.startMeeting()} disabled={!model.canStartMeeting || model.busy} aria-label="Bắt đầu tóm tắt cuộc họp"><Mic size={35} fill="currentColor"/><AnimatedWaveform compact/><strong>Bắt đầu tóm tắt</strong></button></div><div className="idle-copy"><h2>Một chạm để bắt đầu</h2><p>Bản ghi xuất hiện ngay khi nhận diện được lời nói.</p></div><MeetingControls model={model}/>{!model.ready && <small className="accent-text"><Clock3 size={13}/>{model.status}</small>}</div>}
  </div>{saveOpen && <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSaveOpen(false) }}><form className="app-dialog" role="dialog" aria-modal="true" aria-label="Lưu cuộc họp" onSubmit={event => { event.preventDefault(); setSaveOpen(false); void model.stop({ title: saveTitle, groupID: saveGroup || null }) }}><h2>Lưu cuộc họp</h2><label className="field"><span>TÊN CUỘC HỌP</span><input autoFocus value={saveTitle} onChange={event => setSaveTitle(event.target.value)} required/></label><label className="field"><span>NHÓM GHI CHÚ</span><div className="meeting-choice"><Folder size={17}/><select value={saveGroup} onChange={event => setSaveGroup(event.target.value)}><option value="">Tất cả</option>{model.noteGroups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select><ChevronDown size={17}/></div></label><div className="dialog-actions"><button type="button" className="pill-btn" onClick={() => setSaveOpen(false)}>Tiếp tục ghi</button><button className="pill-btn primary" type="submit">Dừng, tóm tắt & lưu</button></div></form></div>}</main>
}
