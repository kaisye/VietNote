import { useEffect, useRef, useState } from 'react'
import { BookOpen, Captions, FilePen, CheckCircle2, ChevronDown, Download, FileAudio, FileText, Languages, Link2, LoaderCircle, Megaphone, NotebookPen, RefreshCw, Upload, Users, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Page } from '../services/types'
import { fileCost, FILE_RATE } from '../services/fileTranscript'
import { languageOptions } from '../components/MeetingControls'
import { Choice } from '../components/Choice'
import { AnimatedWaveform } from '../components/AnimatedWaveform'
import { ChatMarkdown } from '../components/ChatMarkdown'
import { StructuredMeetingSummaryView } from '../components/StructuredMeetingSummary'
import { kindLabel } from '../services/noteDocument'
import type { FileJob, FollowUp } from '../hooks/useFileJob'
import type { DocumentStatus } from '../hooks/useNoteDocuments'
import { desktop } from '../services/desktop'
import { hasTimedTranslation, noteSrt, subtitleFileName, subtitleModes, translationByLine } from '../services/subtitles'
import type { DocumentKind, MeetingNote } from '../services/types'

const MAX_SECONDS = 300 * 60
const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60))
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
const length = (seconds: number) => { const total = Math.round(seconds); const h = Math.floor(total / 3600); const m = Math.floor(total % 3600 / 60); const s = total % 60; return h ? `${h} giờ ${m} phút` : m ? `${m} phút ${s} giây` : `${s} giây` }

const looksLikeLink = (text: string) => /^https?:\/\/\S+\.\S+$/i.test(text.trim())
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

/** What to make from the recording; the summary is always made, the others are written after it. */
const purposes: { kind: DocumentKind | null; scriptOnly?: boolean; label: string; Icon: typeof FileText }[] = [
  { kind: null, scriptOnly: true, label: 'Chỉ lấy phụ đề (SRT)', Icon: Captions },
  { kind: null, label: 'Tóm tắt', Icon: FileText },
  { kind: 'meeting', label: 'Biên bản họp', Icon: Users },
  { kind: 'lecture', label: 'Bài học', Icon: BookOpen },
  { kind: 'article', label: 'Bài viết', Icon: NotebookPen },
  { kind: 'post', label: 'Bài đăng MXH', Icon: Megaphone },
  { kind: 'custom', label: 'Theo yêu cầu', Icon: FilePen },
]
const isPurpose = (value: FollowUp, item: typeof purposes[number]) => value.kind === item.kind && Boolean(value.scriptOnly) === Boolean(item.scriptOnly)
const purposeLabel = (value: FollowUp) => purposes.find(item => isPurpose(value, item))?.label ?? 'Tóm tắt'
/** A custom purpose needs the request itself. */
const purposeReady = (value: FollowUp) => value.kind !== 'custom' || Boolean(value.instruction.trim())

/** What to make, plus the reader's own request for any AI-written document. */
function Purpose({ value, onChange }: { value: FollowUp; onChange: (value: FollowUp) => void }) {
  const writes = Boolean(value.kind)
  return <>
    <div className="purpose-chips" role="radiogroup" aria-label="Mục đích">
      <span>Mục đích</span>
      {purposes.map(item => { const selected = isPurpose(value, item); return <button type="button" key={item.label} role="radio" aria-checked={selected} className={selected ? 'selected' : ''} onClick={() => onChange({ kind: item.kind, scriptOnly: item.scriptOnly, instruction: value.instruction })}><item.Icon size={13}/>{item.label}</button> })}
    </div>
    {writes && <textarea className="purpose-prompt" rows={2} maxLength={2000} value={value.instruction} onChange={event => onChange({ ...value, instruction: event.target.value })}
      aria-label="Yêu cầu cho AI" placeholder={value.kind === 'custom'
        ? 'Bạn muốn AI làm gì với nội dung này? Ví dụ: liệt kê 10 bài học rút ra kèm ví dụ, viết thành kịch bản video 1 phút…'
        : 'Yêu cầu thêm cho AI (không bắt buộc): giọng văn, độ dài, người đọc, phần cần tập trung…'}/>}
    {value.scriptOnly && <small className="purpose-note">Chỉ chép lời và dịch, không tóm tắt. Xong là tải được phụ đề gốc, tiếng Việt hoặc song ngữ.</small>}
  </>
}

/** The subtitle files, straight from the result. */
function SubtitleButtons({ note }: { note: MeetingNote }) {
  const translated = hasTimedTranslation(note)
  return <div className="subtitle-buttons">
    {subtitleModes.map(item => { const disabled = item.mode !== 'source' && !translated; return <button key={item.mode} type="button" className="pill-btn" disabled={disabled} title={disabled ? 'Cần bật dịch sang tiếng Việt' : item.hint} onClick={() => void saveText(subtitleFileName(note, item.mode), noteSrt(note, item.mode)).catch(() => {})}><Captions size={15}/>{item.label.replace('Phụ đề ', 'SRT ')}</button> })}
  </div>
}

const offset = (seconds: number) => { const total = Math.max(0, Math.round(seconds)); const h = Math.floor(total / 3600); const m = Math.floor(total % 3600 / 60); const s = String(total % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}` }

type PreviewTab = 'transcript' | 'summary' | 'document'

/** The result right on this page: the transcript as soon as it is ready, then the summary and the document. */
function ResultPreview({ job, note, writing }: { job: FileJob; note?: MeetingNote; writing?: DocumentStatus }) {
  const preview = job.preview!
  const [chosen, setChosen] = useState<PreviewTab | null>(null)
  const document = job.written ? note?.documents?.[0] : undefined
  const streaming = job.phase === 'writing' ? writing?.progress?.stage === 'writing' ? writing.progress.text : '' : undefined
  const documentKind = document?.kind ?? (job.phase === 'writing' ? writing?.options.kind ?? job.followUp.kind : null)
  const tabs: PreviewTab[] = ['transcript', ...(note?.summary.trim() ? ['summary' as const] : []), ...(documentKind ? ['document' as const] : [])]
  // Until the reader picks a tab, follow the newest result.
  const tab = chosen && tabs.includes(chosen) ? chosen : tabs[tabs.length - 1]
  const origin = Math.min(Date.parse(preview.createdAt) / 1000, preview.segments[0]?.startedAt ?? Infinity)
  const vietnamese = translationByLine({ transcriptSegments: preview.segments, translations: preview.translations } as MeetingNote)
  const label = (item: PreviewTab) => item === 'transcript' ? `Bản ghi · ${preview.segments.length} câu` : item === 'summary' ? 'Tóm tắt' : kindLabel(documentKind!)

  return <section className="glass-card file-preview">
    <div className="segmented file-preview-tabs" role="tablist" aria-label="Xem trước">
      {tabs.map(item => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'selected' : ''} onClick={() => setChosen(item)}>{label(item)}{item === 'document' && job.phase === 'writing' && <span className="nav-busy" aria-label="Đang viết"/>}</button>)}
    </div>
    <div className="file-preview-body">
      {tab === 'transcript' && <ol className="preview-lines">{preview.segments.map(segment => <li key={segment.id}>
        <time>{offset(segment.startedAt - origin)}</time>
        <div>{segment.speaker && <strong>{segment.speaker}</strong>}<p>{segment.cleanText}</p>{vietnamese.get(segment.id) && <p className="preview-vi">{vietnamese.get(segment.id)}</p>}</div>
      </li>)}</ol>}
      {tab === 'summary' && note && (note.structuredSummary ? <StructuredMeetingSummaryView summary={note.structuredSummary}/> : <p className="preview-plain">{note.summary}</p>)}
      {tab === 'document' && (document ? <ChatMarkdown content={document.markdown}/>
        : streaming ? <ChatMarkdown content={streaming} streaming/>
        : <div className="file-working"><AnimatedWaveform/><div><strong>AI đang {writing?.progress?.stage === 'reading' ? `đọc bản ghi ${writing.progress.done}/${writing.progress.total} phần` : 'chuẩn bị viết'}…</strong><small>Bài viết sẽ hiện ở đây ngay khi AI bắt đầu viết.</small></div></div>)}
    </div>
  </section>
}

/** Saves text through the Save dialog, then shows the file. */
async function saveText(name: string, text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const path = await desktop.saveExport(name, btoa(binary))
  if (path) void desktop.revealFile(path).catch(() => {})
}

/** "Tải về": the transcript as text, or as subtitles in the original, Vietnamese or both. */
function DownloadMenu({ note }: { note: MeetingNote }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => { if (!(event.target instanceof Node && root.current?.contains(event.target))) setOpen(false) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  const translated = hasTimedTranslation(note)
  const title = note.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Ban ghi'
  const save = (name: string, text: string) => { setOpen(false); void saveText(name, text).catch(() => {}) }
  return <div className="download-menu" ref={root}>
    <button type="button" className="pill-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Download size={15}/>Tải về<ChevronDown size={13}/></button>
    {open && <div className="note-export-menu" role="menu">
      <button role="menuitem" onClick={() => save(`${title} - bản ghi.txt`, note.transcript)}><FileText size={17}/><span><strong>Bản ghi (.txt)</strong><small>Toàn bộ lời thoại và bản dịch</small></span></button>
      <div className="note-export-section">PHỤ ĐỀ (.SRT)</div>
      {subtitleModes.map(item => { const disabled = item.mode !== 'source' && !translated; return <button key={item.mode} role="menuitem" disabled={disabled} onClick={() => save(subtitleFileName(note, item.mode), noteSrt(note, item.mode))}><Captions size={17}/><span><strong>{item.label}</strong><small>{disabled ? 'Cần bật dịch sang tiếng Việt' : item.hint}</small></span></button> })}
    </div>}
  </div>
}

export function FilePage({ model, setPage }: { model: AppModel; setPage: (page: Page) => void }) {
  const job = model.fileJob
  const { file, phase } = job
  const working = phase === 'uploading' || phase === 'processing' || phase === 'summarizing'
  const tooLong = (file?.durationSeconds ?? 0) > MAX_SECONDS
  const balance = model.account?.balanceSeconds ?? null
  const cost = file?.durationSeconds ? fileCost(file.durationSeconds) : null
  const short = cost !== null && balance !== null && balance < cost
  const [link, setLink] = useState('')
  const note = job.noteId ? model.notes.find(item => item.id === job.noteId) : undefined
  const writing = job.noteId ? model.noteDocuments.statuses[job.noteId] : undefined
  const fetching = phase === 'fetching'
  const submitLink = () => { if (looksLikeLink(link) && purposeReady(job.followUp)) void job.fetchLink(link.trim()) }
  // A purpose saved from before (a custom request, a workshop summary) has no chip here.
  useEffect(() => { if (!purposes.some(item => isPurpose(job.followUp, item))) job.setFollowUp({ kind: null, instruction: '' }) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <main className="page-scroll"><div className="page-wrap narrow animate-in"><div className="eyebrow">RECORDING TO NOTES</div><h1>Dịch file hoặc link</h1>
    <p className="page-subtitle">Chọn file ghi âm, video cuộc họp, hoặc dán link video. VietNote chép lời, phân biệt người nói, dịch sang tiếng Việt và tóm tắt thành ghi chú, với giá chỉ bằng {FILE_RATE * 100}% so với ghi trực tiếp.</p>

    {!file && !fetching && <>
      <button type="button" className="glass-card file-drop" onClick={() => void job.pick()}>
        <span className="file-drop-icon"><Upload size={22}/></span><strong>Chọn file ghi âm</strong>
        <small>MP3, M4A, WAV, MP4, MOV… · tối đa 500 MB và 5 giờ</small>
      </button>
      <div className="file-or"><span>hoặc dán link</span></div>
      <form className="glass-card link-form" onSubmit={event => { event.preventDefault(); submitLink() }}>
        <div className="link-form-row"><Link2 size={18} className="link-form-icon"/>
        <input value={link} onChange={event => setLink(event.target.value)}
          placeholder="Link YouTube, bài giảng, podcast hoặc file âm thanh…" aria-label="Link video hoặc âm thanh" spellCheck={false} autoComplete="off"/>
        <button type="submit" className="pill-btn primary" disabled={!looksLikeLink(link) || !purposeReady(job.followUp)}>Bắt đầu</button></div>
        <Purpose value={job.followUp} onChange={job.setFollowUp}/>
      </form>
    </>}

    {fetching && <section className="glass-card strong file-card">
      <div className="file-row"><span className="file-icon"><Link2 size={20}/></span><div className="file-meta"><strong title={link}>{hostOf(link)}</strong><small title={link}>{purposeLabel(job.followUp)} · {link}</small></div></div>
      <div className="file-progress" role="status">
        {job.linkProgress?.stage === 'downloading' && job.linkProgress.percent > 0
          ? <><div className="file-progress-label"><span>Đang lấy âm thanh…</span><span>{job.linkProgress.percent}%</span></div><div className="file-progress-bar"><span style={{ width: `${job.linkProgress.percent}%` }}/></div></>
          : <div className="file-working"><AnimatedWaveform/><div><strong>{job.linkProgress?.stage === 'preparing' ? 'Đang chuẩn bị cho lần đầu dùng link…' : 'Đang đọc link…'}</strong><small>{job.linkProgress?.stage === 'preparing' ? `Chỉ một lần, khoảng 35 MB${job.linkProgress.percent ? ` · ${job.linkProgress.percent}%` : ''}.` : 'Chỉ lấy phần âm thanh, không tải video.'}</small></div></div>}
      </div>
      <div className="action-row"><div className="row-spacer"/><button type="button" className="pill-btn" onClick={job.cancelLink}><X size={15}/>Hủy</button></div>
    </section>}

    {file && <section className="glass-card strong file-card">
      <div className="file-row"><span className="file-icon">{file.sourceUrl ? <Link2 size={20}/> : <FileAudio size={20}/>}</span><div className="file-meta"><strong title={file.sourceUrl ?? file.path}>{file.sourceUrl ? file.name.replace(/\.[^.]+$/, '') : file.name}</strong><small>{file.sourceUrl ? `${hostOf(file.sourceUrl)} · ` : ''}{size(file.size)}{file.durationSeconds ? ` · ${length(file.durationSeconds)}` : ' · chưa đọc được thời lượng'}</small></div>
        {!working && phase !== 'done' && phase !== 'writing' && <button type="button" className="pill-btn" onClick={file.sourceUrl ? job.reset : () => void job.pick()}>{file.sourceUrl ? 'Đổi link' : 'Đổi file'}</button>}</div>

      {(phase === 'picked' || phase === 'error') && <>
        <div className="divider"/>
        <label className="field"><span>NGÔN NGỮ TRONG FILE</span><Choice icon={<Languages size={17}/>} label="Ngôn ngữ" value={job.language} onChange={job.setLanguage} options={languageOptions}/></label>
        {job.language !== 'vi' && <label className="translation-mode-note"><strong>Dịch sang tiếng Việt</strong><span>{job.translate ? 'Tiếng nước ngoài được dịch theo từng đoạn trong ghi chú.' : 'Chỉ chép lời gốc, không dịch.'}</span><span className="translate-switch"><input type="checkbox" role="switch" aria-label="Dịch sang tiếng Việt" checked={job.translate} onChange={event => job.setTranslate(event.target.checked)}/><span aria-hidden="true"/></span></label>}
        <Purpose value={job.followUp} onChange={job.setFollowUp}/>
        <div className="file-cost"><div><small>CHI PHÍ ƯỚC TÍNH</small><strong>{cost === null ? 'Tính theo thời lượng thực' : `~${minutes(cost)} phút`}</strong>{file.durationSeconds ? <span>{FILE_RATE * 100}% của {minutes(file.durationSeconds)} phút ghi âm</span> : <span>Trừ đúng {FILE_RATE * 100}% thời lượng sau khi xử lý</span>}</div>
          {balance !== null && <div><small>SỐ DƯ</small><strong>{Math.floor(balance / 60)} phút</strong></div>}</div>
        {tooLong && <p className="file-error">File dài hơn 5 giờ. Hãy cắt nhỏ rồi thử lại.</p>}
        {short && !tooLong && <p className="file-error">Số dư chưa đủ cho file này.</p>}
        {phase === 'error' && <p className="file-error" role="alert">{job.error}</p>}
        <div className="action-row"><div className="row-spacer"/><button type="button" className="pill-btn primary" disabled={tooLong || !purposeReady(job.followUp)} onClick={() => void job.start()}>{phase === 'error' ? <RefreshCw size={15}/> : <FileAudio size={15}/>}{phase === 'error' ? 'Thử lại' : 'Bắt đầu dịch'}</button></div>
      </>}

      {working && <>
        <div className="divider"/>
        <div className="file-progress" role="status">
          {phase === 'uploading' ? <><div className="file-progress-label"><span>Đang gửi file…</span><span>{job.progress}%</span></div><div className="file-progress-bar"><span style={{ width: `${job.progress}%` }}/></div></>
            : <div className="file-working"><AnimatedWaveform/><div><strong>{phase === 'processing' ? 'Đang chép lời và dịch…' : job.followUp.scriptOnly ? 'Đã có bản ghi · đang lưu…' : 'Đã có bản ghi · đang tóm tắt…'}</strong><small>Thường xong nhanh hơn nhiều so với thời lượng file. Bạn có thể chuyển sang tab khác.</small></div></div>}
        </div>
        {phase !== 'summarizing' && <div className="action-row"><div className="row-spacer"/><button type="button" className="pill-btn" onClick={job.cancel}><X size={15}/>Hủy</button></div>}
      </>}

      {phase === 'writing' && <>
        <div className="divider"/>
        <div className="file-working" role="status"><AnimatedWaveform/><div><strong>Đã lưu bản ghi · AI đang viết {kindLabel(writing?.options.kind ?? job.followUp.kind ?? 'custom').toLocaleLowerCase('vi-VN')}…</strong>
          <small>Xem bản ghi và tóm tắt ngay bên dưới trong lúc chờ.</small></div></div>
      </>}

      {phase === 'done' && <>
        <div className="divider"/>
        <div className="file-done"><CheckCircle2 size={22}/><div><strong>{job.written ? `Đã lưu ghi chú và ${kindLabel(note?.documents?.[0]?.kind ?? 'custom').toLocaleLowerCase('vi-VN')}` : note && !note.summary.trim() ? 'Đã có bản ghi · tải phụ đề bên dưới' : 'Đã lưu thành ghi chú'}</strong>
          {job.charged !== null && <small>Đã trừ {minutes(job.charged)} phút</small>}
          {writing?.error && <small className="file-error">AI chưa viết xong tài liệu: {writing.error} Mở ghi chú để thử lại.</small>}</div></div>
        {note && !note.summary.trim() && <SubtitleButtons note={note}/>}
        <div className="action-row"><button type="button" className="pill-btn" onClick={() => { setLink(''); job.reset() }}>Dịch file khác</button><div className="row-spacer"/>
          {note && <DownloadMenu note={note}/>}
          <button type="button" className="pill-btn primary" onClick={() => setPage('notes')}>Mở ghi chú</button></div>
      </>}
    </section>}
    {job.preview && <ResultPreview job={job} note={note} writing={writing}/>}
    {!file && phase === 'error' && <p className="file-error" role="alert">{job.error}</p>}
    {(phase === 'processing' || phase === 'summarizing') && <p className="file-hint"><LoaderCircle size={13}/>Nếu đóng app, VietNote sẽ tiếp tục khi mở lại.</p>}
  </div></main>
}
