import { useEffect, useMemo, useRef, useState } from 'react'
import { Grid2X2, Folder, Plus, SquarePen, Clock3, Trash2, MoreHorizontal, Maximize2, Minimize2, Copy, Check } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { AppModel } from '../hooks/useAppModel'
import { formatTime, noteInScope, noteMoments, noteTranscriptText } from '../services/notes'
import { NoteChat } from '../components/NoteChat'
import { Choice } from '../components/Choice'
import { NoteExport } from '../components/NoteExport'
import { NoteMomentCard } from '../components/NoteMomentCard'
import { StructuredMeetingSummaryView } from '../components/StructuredMeetingSummary'

export function NotesPage({ model }: { model: AppModel }) {
  const [scope, setScope] = useState(model.savingNoteGroupID ?? 'all')
  const [search, setSearch] = useState('')
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  // Fixed-position so the category bar's horizontal scroll does not clip it.
  const [groupMenu, setGroupMenu] = useState<{ id: string; left: number; top: number } | null>(null)
  const [dialog, setDialog] = useState<'createGroup' | 'renameGroup' | 'deleteGroup' | 'deleteNote' | null>(null)
  const [dialogID, setDialogID] = useState<string | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [highlightedEvidence, setHighlightedEvidence] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState<'transcript' | 'failed' | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const transcriptDetails = useRef<HTMLDetailsElement>(null)
  const visible = useMemo(() => model.notes.filter(note => noteInScope(note, scope, model.noteGroups) && (!search || [note.title, note.summary, note.transcript].some(value => value.toLocaleLowerCase().includes(search.toLocaleLowerCase())))).sort((a,b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [model.notes, model.noteGroups, scope, search])
  const selected = visible.find(note => note.id === selectedID) ?? visible[0]
  useEffect(() => { setEditMode(false); setHighlightedEvidence([]); setCopied(null) }, [selected?.id])
  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  useEffect(() => {
    if (!groupMenu) return
    const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('.group-popover, .group-menu-button'))) setGroupMenu(null) }
    const dismiss = () => setGroupMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', dismiss)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('resize', dismiss) }
  }, [groupMenu])
  const copy = async (kind: 'transcript', text: string) => {
    clearTimeout(copiedTimer.current)
    try { await navigator.clipboard.writeText(text); setCopied(kind) } catch { setCopied('failed') }
    copiedTimer.current = setTimeout(() => setCopied(null), 1800)
  }
  const showEvidence = (ids: string[]) => {
    setExpanded(false)
    setHighlightedEvidence(ids)
    if (transcriptDetails.current) transcriptDetails.current.open = true
    requestAnimationFrame(() => document.getElementById(`transcript-${ids[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }
  const evidenceLabel = (id: string) => {
    const segment = selected?.transcriptSegments?.find(item => item.id === id)
    return segment ? formatTime(segment.timestamp, false) : undefined
  }
  const openDialog = (kind: typeof dialog, id: string | null = null, value = '') => { setDialog(kind); setDialogID(id); setDialogValue(value); setDialogError(''); setGroupMenu(null) }
  const submitDialog = () => {
    if (dialog === 'createGroup') { const id = model.createGroup(dialogValue); if (!id) { setDialogError('Tên nhóm không được trống hoặc trùng.'); return } setScope(id); setSelectedID(null) }
    if (dialog === 'renameGroup' && dialogID && !model.renameGroup(dialogID, dialogValue)) { setDialogError('Tên nhóm không được trống hoặc trùng.'); return }
    if (dialog === 'deleteGroup' && dialogID) { model.deleteGroup(dialogID); if (scope === dialogID) setScope('all'); setSelectedID(null) }
    if (dialog === 'deleteNote' && dialogID) { model.deleteNote(dialogID); setSelectedID(null) }
    setDialog(null)
  }
  const addNote = () => { const id = model.newNote(scope !== 'all' ? scope : null); setSearch(''); setSelectedID(id) }
  return <main className={`notes-page animate-in ${expanded ? 'note-expanded' : ''}`}><div className="eyebrow">KHÔNG GIAN GHI CHÚ</div><h1>Ghi chú cuộc họp</h1>
    <div className="note-category-bar"><div className="category-scroll" onScroll={() => setGroupMenu(null)}><button className={`category-pill ${scope === 'all' ? 'selected' : ''}`} onClick={() => { setScope('all'); setSelectedID(null) }}><Grid2X2 size={17}/>Tất cả <small>{model.notes.length}</small></button><span className="category-separator"/>{model.noteGroups.map(group => <div className="category-group" key={group.id}><button className={`category-pill ${scope === group.id ? 'selected' : ''}`} onClick={() => { setScope(group.id); setSelectedID(null) }}><Folder size={17}/>{group.name}<small>{model.notes.filter(note => note.groupID === group.id).length}</small></button><button className="group-menu-button" aria-label={`Tùy chọn nhóm ${group.name}`} aria-expanded={groupMenu?.id === group.id} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setGroupMenu(groupMenu?.id === group.id ? null : { id: group.id, left: rect.left, top: rect.bottom + 6 }) }}><MoreHorizontal size={17}/></button></div>)}</div><button className="add-group" aria-label="Tạo nhóm ghi chú" title="Tạo nhóm" onClick={() => openDialog('createGroup')}><Plus size={20}/></button></div>
    {groupMenu && createPortal(<div className="group-popover" role="menu" style={{ left: groupMenu.left, top: groupMenu.top }}><button role="menuitem" onClick={() => openDialog('renameGroup', groupMenu.id, model.noteGroups.find(group => group.id === groupMenu.id)?.name ?? '')}>Đổi tên</button><button role="menuitem" className="danger" onClick={() => openDialog('deleteGroup', groupMenu.id)}>Xóa nhóm</button></div>, document.body)}
    <div className="notes-columns"><section className="glass-card notes-list-panel"><div className="notes-list-heading"><h3>Ghi chú</h3><button aria-label="Tạo ghi chú" title="Tạo ghi chú" onClick={addNote}><SquarePen size={18}/></button></div><input className="note-search" placeholder="Tìm ghi chú…" value={search} onChange={e => setSearch(e.target.value)}/><div className="notes-list-scroll">{visible.map(note => { const overview = note.saving ? 'Đang hoàn tất tóm tắt và lưu cuộc họp…' : noteMoments(note.summary)[0]?.overview[0] ?? (note.summary || 'Chưa có nội dung'); return <button key={note.id} className={`note-list-item ${selected?.id === note.id ? 'selected' : ''} ${note.saving ? 'saving' : ''}`} onClick={() => setSelectedID(note.id)}><div><strong>{note.title || 'Chưa có tiêu đề'}</strong>{note.isDemo && <small>MẪU</small>}{note.saving && <small className="note-saving-label">ĐANG LƯU</small>}</div><p>{overview}</p><time>{formatTime(note.updatedAt)}</time></button> })}{visible.length === 0 && <p className="muted empty-list">Không tìm thấy ghi chú. Tạo ghi chú mới hoặc chọn nhóm khác.</p>}</div></section>
      {selected ? <section className="glass-card strong note-editor" key={selected.id}><div className="note-editor-scroll">{selected.isDemo ? <><small className="accent-text">Ghi chú mẫu · chỉ đọc</small><h2>{selected.title}</h2></> : <><div className="note-title-row"><NoteTitle title={selected.title} onRename={title => model.updateNote(selected.id, { title })}/><button className="pill-btn" onClick={() => openDialog('deleteNote', selected.id)}><Trash2 size={15}/>Xóa</button></div><div className="note-group-row"><span>Nhóm</span><Choice className="note-group-choice" icon={<Folder size={15}/>} chevron={16} label="Nhóm" value={selected.groupID ?? ''} onChange={value => model.updateNote(selected.id, { groupID: value || null })} options={[{ value: '', label: 'Tất cả' }, ...model.noteGroups.map(group => ({ value: group.id, label: group.name }))]}/><small className="note-date" title="Tự động lưu">{formatTime(selected.createdAt)}{selected.duration > 0 && ` · ${Math.floor(selected.duration / 60)} phút`}</small></div></>}
        {selected.isDemo && <div className="note-date">{formatTime(selected.createdAt)}{selected.duration > 0 && ` · ${Math.floor(selected.duration / 60)} phút`}</div>}<div className="divider"/><div className="note-content-heading"><h3>Nội dung ghi chú</h3><div className="note-content-actions">{copied === 'failed' && <small className="accent-text">Không copy được</small>}<NoteExport note={selected} groupName={model.noteGroups.find(group => group.id === selected.groupID)?.name}/>{!selected.isDemo && <div className="segmented"><button className={!editMode ? 'selected' : ''} onClick={() => setEditMode(false)}>Xem</button><button className={editMode ? 'selected' : ''} onClick={() => setEditMode(true)}>Chỉnh sửa</button></div>}<button className="icon-btn panel-expand" onClick={() => setExpanded(value => !value)} aria-pressed={expanded} aria-label={expanded ? 'Thu nhỏ ghi chú' : 'Mở rộng ghi chú'} title={expanded ? 'Thu nhỏ (Esc)' : 'Mở rộng: chỉ xem tiêu đề, thời gian và nội dung'}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button></div></div>
        {editMode && !selected.isDemo ? <textarea className="note-textarea" value={selected.summary} onChange={e => model.updateNote(selected.id, { summary: e.target.value })} aria-label="Nội dung ghi chú"/> : selected.structuredSummary ? <StructuredMeetingSummaryView summary={selected.structuredSummary} onEvidence={showEvidence} evidenceLabel={evidenceLabel}/> : <div className="note-moments">{noteMoments(selected.summary).length ? <><div className="moments-caption"><Clock3 size={15}/>{noteMoments(selected.summary).length} mốc nội dung<span>Nhấn vào từng mốc để xem chi tiết</span></div>{noteMoments(selected.summary).map(moment => <NoteMomentCard key={`${selected.id}-${moment.id}`} moment={moment} defaultOpen={moment.id === 0}/>)}</> : <div className="empty-note"><SquarePen size={26}/><h3>Chưa có nội dung</h3><p>Chọn Chỉnh sửa để thêm ghi chú cho cuộc họp này.</p></div>}</div>}
        <div className="divider"/><details className="transcript-disclosure" ref={transcriptDetails}><summary><span>Transcript gốc · chỉ đọc</span>{(selected.transcriptSegments?.length || selected.transcript.trim()) && <button type="button" className="copy-btn" onClick={event => { event.preventDefault(); void copy('transcript', noteTranscriptText(selected)) }} title="Copy transcript">{copied === 'transcript' ? <Check size={14}/> : <Copy size={14}/>}{copied === 'transcript' ? 'Đã copy' : 'Copy'}</button>}</summary>{selected.transcriptSegments?.length ? <div className="saved-transcript">{selected.transcriptSegments.map(segment => <article id={`transcript-${segment.id}`} key={segment.id} className={highlightedEvidence.includes(segment.id) ? 'evidence-highlight' : ''}><small>{formatTime(segment.timestamp, false)} · {segment.audioSource === 'microphone' ? 'Microphone' : 'System audio'}{segment.speaker ? ` · ${segment.speaker}${segment.speakerProvisional ? ' (tạm)' : ''}` : ''}</small><p>{segment.cleanText}</p>{segment.rawText !== segment.cleanText && <small className="raw-transcript">Bản nhận diện gốc: {segment.rawText}</small>}</article>)}</div> : <p>{selected.transcript || 'Ghi chú này không có transcript.'}</p>}</details></div><NoteChat key={selected.id} note={selected} chat={model.noteChat} onEvidence={showEvidence}/></section> : <section className="glass-card strong note-empty">Chọn hoặc tạo ghi chú để bắt đầu.</section>}
    </div>{dialog && <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null) }}><form className="app-dialog" role="dialog" aria-modal="true" aria-label={dialog === 'deleteNote' ? 'Xóa cuộc họp' : dialog === 'deleteGroup' ? 'Xóa nhóm' : dialog === 'createGroup' ? 'Tạo nhóm' : 'Đổi tên'} onSubmit={event => { event.preventDefault(); submitDialog() }}><h2>{dialog === 'createGroup' ? 'Tạo nhóm ghi chú' : dialog === 'renameGroup' ? 'Đổi tên nhóm' : dialog === 'deleteNote' ? 'Xóa cuộc họp?' : 'Xóa nhóm?'}</h2>{dialog === 'deleteNote' ? <p>Cuộc họp này sẽ bị xóa vĩnh viễn.</p> : dialog === 'deleteGroup' ? <p>Ghi chú trong nhóm vẫn còn ở Tất cả.</p> : <label className="field"><span>TÊN NHÓM</span><input autoFocus value={dialogValue} onChange={event => setDialogValue(event.target.value)} required/></label>}{dialogError && <p className="dialog-error">{dialogError}</p>}<div className="dialog-actions"><button type="button" className="pill-btn" onClick={() => setDialog(null)}>Hủy</button><button type="submit" className="pill-btn primary">{dialog === 'deleteNote' || dialog === 'deleteGroup' ? 'Xóa' : 'Lưu'}</button></div></form></div>}
  </main>
}

/** The note title is edited in place: Enter or leaving the field saves, Esc or an empty title reverts. */
function NoteTitle({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState(title)
  useEffect(() => setDraft(title), [title])
  const commit = () => {
    const value = draft.trim()
    if (value && value !== title) onRename(value)
    else setDraft(title)
  }
  return <input className="note-title-input" aria-label="Tên cuộc họp" title="Nhấn để đổi tên" value={draft} placeholder="Chưa có tiêu đề" spellCheck={false}
    onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); setDraft(title); requestAnimationFrame(() => event.currentTarget?.blur()) } }}/>
}
