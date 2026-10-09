import { useState } from 'react'
import { AlertCircle, ArrowUp, BookOpen, FilePen, Megaphone, NotebookPen, Presentation, Sparkles, Trash2, Users } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { WriteOptions } from '../hooks/useNoteDocuments'
import type { DocumentKind, DocumentLength, MeetingNote, NoteDocument } from '../services/types'
import { documentKinds, documentLengths, kindLabel, transcriptLines } from '../services/noteDocument'
import { formatTime } from '../services/notes'
import { ChatMarkdown } from './ChatMarkdown'
import { AnimatedWaveform } from './AnimatedWaveform'

const kindIcons: Record<DocumentKind, typeof Users> = { workshop: Presentation, lecture: BookOpen, meeting: Users, article: NotebookPen, post: Megaphone, custom: FilePen }

/** "AI viết": documents written from the note, one at a time, plus the form that writes a new one. */
export function NoteDocuments({ note, model, selected, onSelect, editing }: {
  note: MeetingNote; model: AppModel; selected: NoteDocument | null; onSelect: (id: string | null) => void; editing: boolean
}) {
  const writer = model.noteDocuments
  const status = writer.statuses[note.id]
  const documents = note.documents ?? []
  const busy = Boolean(status && !status.error)
  const write = (options: WriteOptions) => void writer.write(note.id, options).then(id => { if (id) onSelect(id) })

  return <div className="note-documents">
    {documents.length > 0 && <div className="document-tabs" role="tablist" aria-label="Tài liệu AI đã viết">
      {documents.map(document => { const Icon = kindIcons[document.kind]; return <button key={document.id} role="tab" aria-selected={selected?.id === document.id} className={selected?.id === document.id ? 'selected' : ''} onClick={() => onSelect(document.id)} title={formatTime(document.updatedAt)}><Icon size={14}/>{kindLabel(document.kind)}</button> })}
      <button role="tab" aria-selected={!selected} className={`document-new ${!selected ? 'selected' : ''}`} onClick={() => onSelect(null)} disabled={busy}><Sparkles size={14}/>Viết mới</button>
    </div>}

    {busy && status ? <WriteProgressView status={status}/>
      : selected ? <DocumentView note={note} document={selected} editing={editing} error={status?.options.reviseId === selected.id ? status?.error : undefined}
          onSave={markdown => writer.save(note.id, selected.id, markdown)}
          onRevise={instruction => write({ kind: selected.kind, length: selected.length, instruction, reviseId: selected.id })}
          onDelete={() => { writer.remove(note.id, selected.id); onSelect(documents.find(item => item.id !== selected.id)?.id ?? null) }}/>
      : <Composer note={note} error={status && !status.options.reviseId ? status.error : undefined} initial={status?.options} onWrite={write}/>}
  </div>
}

function WriteProgressView({ status }: { status: NonNullable<AppModel['noteDocuments']['statuses'][string]> }) {
  const progress = status.progress
  const label = status.options.reviseId ? 'AI đang chỉnh tài liệu' : `AI đang viết ${kindLabel(status.options.kind).toLocaleLowerCase('vi-VN')}`
  if (progress?.stage === 'writing' && progress.text) return <article className="document-body writing" aria-busy="true"><ChatMarkdown content={progress.text} streaming/></article>
  return <div className="document-progress" role="status">
    <AnimatedWaveform/>
    <div><strong>{label}…</strong>
      {progress?.stage === 'reading' && progress.total > 0
        ? <><small>Đang đọc transcript · phần {Math.min(progress.done + 1, progress.total)}/{progress.total}. Bản ghi dài được đọc kỹ từng phần trước khi viết.</small><div className="file-progress-bar"><span style={{ width: `${Math.round(progress.done / progress.total * 100)}%` }}/></div></>
        : <small>Thường mất 10–40 giây. Bạn có thể chuyển sang ghi chú khác.</small>}
    </div>
  </div>
}

function Composer({ note, error, initial, onWrite }: { note: MeetingNote; error?: string; initial?: WriteOptions; onWrite: (options: WriteOptions) => void }) {
  const [kind, setKind] = useState<DocumentKind>(initial?.kind ?? 'workshop')
  const [length, setLength] = useState<DocumentLength>(initial?.length ?? 'medium')
  const [instruction, setInstruction] = useState(initial?.instruction ?? '')
  const lines = transcriptLines(note)
  const empty = !lines.length
  const needsInstruction = kind === 'custom' && !instruction.trim()
  const minutes = Math.round(lines.join('\n').length / 900)

  return <form className="document-composer" onSubmit={event => { event.preventDefault(); if (!empty && !needsInstruction) onWrite({ kind, length, instruction }) }}>
    <div className="document-intro"><Sparkles size={18}/><div><strong>AI viết từ bản ghi này</strong><small>Chọn loại tài liệu. Bản ghi dài vài giờ vẫn được đọc hết trước khi viết.</small></div></div>
    <div className="document-kinds" role="radiogroup" aria-label="Loại tài liệu">
      {documentKinds.map(item => { const Icon = kindIcons[item.kind]; return <button type="button" key={item.kind} role="radio" aria-checked={kind === item.kind} className={kind === item.kind ? 'selected' : ''} onClick={() => setKind(item.kind)}><Icon size={17}/><strong>{item.label}</strong><small>{item.hint}</small></button> })}
    </div>
    {kind !== 'post' && <div className="document-option"><span>ĐỘ DÀI</span><div className="segmented">{documentLengths.map(item => <button type="button" key={item.value} className={length === item.value ? 'selected' : ''} onClick={() => setLength(item.value)}>{item.label}</button>)}</div></div>}
    <label className="field"><span>{kind === 'custom' ? 'YÊU CẦU CHO AI' : 'YÊU CẦU THÊM (KHÔNG BẮT BUỘC)'}</span>
      <textarea className="document-instruction" rows={2} value={instruction} maxLength={2000} onChange={event => setInstruction(event.target.value)}
        placeholder={kind === 'custom' ? 'Ví dụ: Viết email gửi sếp tóm tắt 3 điểm chính và đề xuất bước tiếp theo' : 'Ví dụ: tập trung phần ứng dụng AI cho giáo viên, giọng văn trẻ trung'}/></label>
    {empty && <p className="file-error">Ghi chú này chưa có transcript để AI đọc.</p>}
    {error && <p className="file-error" role="alert"><AlertCircle size={14}/>{error}</p>}
    <div className="action-row">{!empty && <small className="muted">{lines.length} đoạn transcript{minutes > 0 ? ` · ~${minutes} phút đọc` : ''}</small>}<div className="row-spacer"/>
      <button type="submit" className="pill-btn primary" disabled={empty || needsInstruction}><Sparkles size={15}/>{error ? 'Thử lại' : 'Viết'}</button></div>
  </form>
}

function DocumentView({ note, document, editing, error, onSave, onRevise, onDelete }: {
  note: MeetingNote; document: NoteDocument; editing: boolean; error?: string
  onSave: (markdown: string) => void; onRevise: (instruction: string) => void; onDelete: () => void
}) {
  const [request, setRequest] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const submit = () => { const value = request.trim(); if (value) { onRevise(value); setRequest('') } }
  return <div className="document-view">
    <div className="document-meta"><span>{kindLabel(document.kind)} · {formatTime(document.updatedAt)}{document.instruction ? ` · "${document.instruction}"` : ''}</span>
      {note.isDemo ? null : confirmDelete
        ? <span className="document-confirm">Xóa tài liệu này?<button type="button" className="danger" onClick={onDelete}>Xóa</button><button type="button" onClick={() => setConfirmDelete(false)}>Hủy</button></span>
        : <button type="button" className="icon-btn" aria-label="Xóa tài liệu" title="Xóa tài liệu" onClick={() => setConfirmDelete(true)}><Trash2 size={14}/></button>}</div>
    {document.incomplete && <p className="document-warning"><AlertCircle size={14}/>AI dừng trước khi viết xong.<button type="button" onClick={() => onRevise('Viết tiếp và hoàn thiện phần còn thiếu ở cuối, giữ nguyên phần đã có.')}>Viết tiếp</button></p>}
    {editing
      ? <textarea className="note-textarea document-editor" value={document.markdown} onChange={event => onSave(event.target.value)} aria-label="Nội dung tài liệu (Markdown)" spellCheck={false}/>
      : <article className="document-body"><ChatMarkdown content={document.markdown}/></article>}
    {error && <p className="file-error" role="alert"><AlertCircle size={14}/>{error}</p>}
    <form className="document-revise" onSubmit={event => { event.preventDefault(); submit() }}>
      <Sparkles size={15}/>
      <input value={request} maxLength={2000} onChange={event => setRequest(event.target.value)} placeholder="Yêu cầu AI chỉnh: ngắn hơn, thêm ví dụ, đổi giọng văn, viết lại phần mở đầu…" aria-label="Yêu cầu AI chỉnh tài liệu"/>
      <button type="submit" className="document-send" disabled={!request.trim()} aria-label="Gửi yêu cầu chỉnh"><ArrowUp size={15}/></button>
    </form>
  </div>
}
