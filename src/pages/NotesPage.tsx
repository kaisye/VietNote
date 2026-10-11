import { useEffect, useMemo, useRef, useState } from 'react'
import { Grid2X2, Folder, Plus, SquarePen, Clock3, Trash2, MoreHorizontal, Maximize2, Minimize2, Copy, Check, Sparkles, Mic, Languages, FileAudio, Link2, X, ListChecks, type LucideIcon } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { AppModel } from '../hooks/useAppModel'
import { dayKey, dayLabel, formatTime, isShortNote, noteInScope, noteMatches, noteMoments, noteSource, noteTranscriptText } from '../services/notes'
import type { MeetingNote, NoteSource } from '../services/types'
import { NoteCalendar } from '../components/NoteCalendar'
import { NoteChat } from '../components/NoteChat'
import { Choice } from '../components/Choice'
import { NoteExport } from '../components/NoteExport'
import { NoteMomentCard } from '../components/NoteMomentCard'
import { NoteDocuments } from '../components/NoteDocuments'
import { StructuredMeetingSummaryView, structuredSummaryHasEvidence } from '../components/StructuredMeetingSummary'

const sourceIcons: Record<NoteSource, { icon: LucideIcon; label: string }> = {
  meeting: { icon: Mic, label: 'Ghi âm cuộc họp' },
  translate: { icon: Languages, label: 'Phiên dịch' },
  file: { icon: FileAudio, label: 'Từ file' },
  link: { icon: Link2, label: 'Từ link' },
  manual: { icon: SquarePen, label: 'Tự viết' },
}

const clock = (date: string) => new Date(date).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
const minutes = (seconds: number) => seconds >= 60 ? `${Math.round(seconds / 60)} phút` : ''
const SUMMARY_EVIDENCE_KEY = 'summaryEvidenceShown'

/** Notes grouped by the day they were recorded, newest day first. */
function byDay(notes: MeetingNote[]) {
  const days: { key: string; notes: MeetingNote[] }[] = []
  for (const note of notes) {
    const key = dayKey(note.createdAt)
    if (days.at(-1)?.key === key) days.at(-1)!.notes.push(note)
    else days.push({ key, notes: [note] })
  }
  return days
}

export function NotesPage({ model }: { model: AppModel }) {
  const [scope, setScope] = useState(model.savingNoteGroupID ?? 'all')
  const [search, setSearch] = useState('')
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [view, setView] = useState<'summary' | 'documents'>('summary')
  // null shows the newest document, 'new' the form that writes another.
  const [documentID, setDocumentID] = useState<string | null>(null)
  // Fixed-position so the category bar's horizontal scroll does not clip it.
  const [groupMenu, setGroupMenu] = useState<{ id: string; left: number; top: number } | null>(null)
  const [dialog, setDialog] = useState<'createGroup' | 'renameGroup' | 'deleteGroup' | 'deleteNote' | null>(null)
  const [dialogID, setDialogID] = useState<string | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [highlightedEvidence, setHighlightedEvidence] = useState<string[]>([])
  const [evidenceShown, setEvidenceShown] = useState(() => { try { return localStorage.getItem(SUMMARY_EVIDENCE_KEY) === '1' } catch { return false } })
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState<'transcript' | 'failed' | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const transcriptDetails = useRef<HTMLDetailsElement>(null)
  const [day, setDay] = useState<string | null>(null)
  // Notes in the group that match the search: the calendar marks their days.
  const matching = useMemo(() => model.notes.filter(note => noteInScope(note, scope, model.noteGroups) && noteMatches(note, search)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [model.notes, model.noteGroups, scope, search])
  const counts = useMemo(() => { const result = new Map<string, number>(); for (const note of matching) { const key = dayKey(note.createdAt); result.set(key, (result.get(key) ?? 0) + 1) } return result }, [matching])
  const visible = useMemo(() => day ? matching.filter(note => dayKey(note.createdAt) === day) : matching, [matching, day])
  const days = useMemo(() => byDay(visible), [visible])
  const selected = visible.find(note => note.id === selectedID) ?? visible[0]
  // A note just made with the new-note button opens ready to type.
  const [freshID, setFreshID] = useState<string | null>(null)
  useEffect(() => {
    setEditMode(Boolean(selected && selected.id === freshID)); setHighlightedEvidence([]); setCopied(null); setDocumentID(null)
    if (!freshID || selected?.id === freshID) return
    // Left without writing anything: the empty note goes away rather than cluttering the list.
    const left = model.notes.find(note => note.id === freshID)
    if (left && !left.summary.trim() && left.title === 'Ghi chú mới') model.deleteNote(left.id)
    setFreshID(null)
  }, [selected?.id])
  const documentsView = view === 'documents' && !selected?.isDemo
  const selectedDocument = !documentsView || documentID === 'new' ? null : selected?.documents?.find(document => document.id === documentID) ?? selected?.documents?.[0] ?? null
  const writingHere = Boolean(selected && model.noteDocuments.statuses[selected.id] && !model.noteDocuments.statuses[selected.id].error)
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
  const toggleEvidence = () => setEvidenceShown(value => { const next = !value; try { localStorage.setItem(SUMMARY_EVIDENCE_KEY, next ? '1' : '0') } catch { /* private window */ } return next })
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
  // Choosing several notes, to delete them together.
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const lastPick = useRef<string | null>(null)
  const pickable = (note: MeetingNote) => !note.isDemo && !note.saving
  const pickableIDs = visible.filter(pickable).map(note => note.id)
  // Only notes still in view count: a search typed meanwhile may have hidden some.
  const pickedIDs = pickableIDs.filter(id => picked.has(id))
  const shortIDs = visible.filter(isShortNote).map(note => note.id)
  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); lastPick.current = null }
  /** Shift-click sets every note between the last one clicked and this one. */
  const pick = (id: string, range: boolean) => {
    const next = new Set(picked)
    const from = range && lastPick.current ? pickableIDs.indexOf(lastPick.current) : -1
    const to = pickableIDs.indexOf(id)
    const ids = from >= 0 && to >= 0 ? pickableIDs.slice(Math.min(from, to), Math.max(from, to) + 1) : [id]
    const add = !picked.has(id)
    ids.forEach(item => add ? next.add(item) : next.delete(item))
    setPicked(next); lastPick.current = id
  }
  const pickAll = (ids: string[]) => { const next = new Set(picked); const all = ids.every(id => picked.has(id)); ids.forEach(id => all ? next.delete(id) : next.add(id)); setPicked(next) }
  // Deleting is immediate; the notes stay in hand a few seconds so it can be undone.
  const [undo, setUndo] = useState<MeetingNote[] | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(undoTimer.current), [])
  useEffect(() => {
    if (!selecting) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') stopSelecting() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])
  const removeNotes = (ids: string[]) => {
    const removed = model.deleteNotes(ids)
    if (!removed.length) return
    clearTimeout(undoTimer.current)
    setUndo(removed)
    undoTimer.current = setTimeout(() => setUndo(null), 6000)
    if (selected && ids.includes(selected.id)) setSelectedID(null)
  }
  const undoDelete = () => { clearTimeout(undoTimer.current); if (undo) model.restoreNotes(undo); setUndo(null) }
  const addNote = () => { const id = model.newNote(scope !== 'all' ? scope : null); setSearch(''); setDay(null); setView('summary'); setFreshID(id); setSelectedID(id) }
  return <main className={`notes-page animate-in ${expanded ? 'note-expanded' : ''}`}><div className="eyebrow">KHÔNG GIAN GHI CHÚ</div><h1>Ghi chú cuộc họp</h1>
    <div className="note-category-bar"><div className="category-scroll" onScroll={() => setGroupMenu(null)}><button className={`category-pill ${scope === 'all' ? 'selected' : ''}`} onClick={() => { setScope('all'); setSelectedID(null) }}><Grid2X2 size={17}/>Tất cả <small>{model.notes.length}</small></button><span className="category-separator"/>{model.noteGroups.map(group => <div className="category-group" key={group.id}><button className={`category-pill ${scope === group.id ? 'selected' : ''}`} onClick={() => { setScope(group.id); setSelectedID(null) }}><Folder size={17}/>{group.name}<small>{model.notes.filter(note => note.groupID === group.id).length}</small></button><button className="group-menu-button" aria-label={`Tùy chọn nhóm ${group.name}`} aria-expanded={groupMenu?.id === group.id} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setGroupMenu(groupMenu?.id === group.id ? null : { id: group.id, left: rect.left, top: rect.bottom + 6 }) }}><MoreHorizontal size={17}/></button></div>)}</div><button className="add-group" aria-label="Tạo nhóm ghi chú" title="Tạo nhóm" onClick={() => openDialog('createGroup')}><Plus size={20}/></button></div>
    {groupMenu && createPortal(<div className="group-popover" role="menu" style={{ left: groupMenu.left, top: groupMenu.top }}><button role="menuitem" onClick={() => openDialog('renameGroup', groupMenu.id, model.noteGroups.find(group => group.id === groupMenu.id)?.name ?? '')}>Đổi tên</button><button role="menuitem" className="danger" onClick={() => openDialog('deleteGroup', groupMenu.id)}>Xóa nhóm</button></div>, document.body)}
    <div className="notes-columns"><section className="glass-card notes-list-panel"><div className="notes-list-heading"><h3>Ghi chú</h3>{selecting ? <button className="note-select-done" onClick={stopSelecting}>Xong</button> : <><button aria-label="Chọn nhiều ghi chú" title="Chọn nhiều để xoá" onClick={() => setSelecting(true)}><ListChecks size={18}/></button><button aria-label="Tạo ghi chú" title="Tạo ghi chú" onClick={addNote}><SquarePen size={18}/></button></>}</div><NoteCalendar counts={counts} selected={day} onSelect={value => { setDay(value); setSelectedID(null) }}/>{selecting && <div className="note-select-bar"><div><span>{pickedIDs.length ? `Đã chọn ${pickedIDs.length}` : 'Chọn ghi chú để xoá'}</span><button className="danger" disabled={!pickedIDs.length} onClick={() => { removeNotes(pickedIDs); stopSelecting() }}><Trash2 size={14}/>Xoá</button></div><div><button disabled={!pickableIDs.length} onClick={() => pickAll(pickableIDs)}>{pickableIDs.length && pickedIDs.length === pickableIDs.length ? 'Bỏ chọn' : 'Chọn tất cả'}</button><button disabled={!shortIDs.length} title="Ghi âm dưới 2 phút hoặc gần như không có lời, chưa đổi tên, chưa xếp nhóm, chưa hỏi AI hay viết bài" onClick={() => setPicked(new Set(shortIDs))}>Ghi chú ngắn ({shortIDs.length})</button></div></div>}<input className="note-search" placeholder="Tìm ghi chú…" title="Tìm trong tiêu đề, tóm tắt và bản ghi, gõ không dấu cũng được" value={search} onChange={e => setSearch(e.target.value)}/>{day && <button className="note-day-filter" onClick={() => setDay(null)}>{dayLabel(day)} · {visible.length} ghi chú<X size={13}/></button>}<div className="notes-list-scroll">{days.map(group => <div className="note-day" key={group.key}><h4>{dayLabel(group.key)}{selecting && group.notes.some(pickable) && <button onClick={() => pickAll(group.notes.filter(pickable).map(note => note.id))}>{group.notes.filter(pickable).every(note => picked.has(note.id)) ? 'Bỏ chọn ngày' : 'Chọn cả ngày'}</button>}</h4>{group.notes.map(note => { const source = sourceIcons[noteSource(note)]; const Icon = source.icon; const checked = selecting && picked.has(note.id); return <div key={note.id} className="note-row"><button className={`note-list-item ${!selecting && selected?.id === note.id ? 'selected' : ''} ${note.saving ? 'saving' : ''} ${checked ? 'picked' : ''}`} aria-pressed={selecting ? checked : undefined} disabled={selecting && !pickable(note)} onClick={event => selecting ? pick(note.id, event.shiftKey) : setSelectedID(note.id)}><div>{selecting ? <span className="note-check" aria-hidden>{checked && <Check size={12}/>}</span> : <span className="note-source" title={source.label} aria-label={source.label}><Icon size={13}/></span>}<strong>{note.title || 'Chưa có tiêu đề'}</strong>{note.isDemo && <small>MẪU</small>}{note.saving && <small className="note-saving-label">ĐANG LƯU</small>}</div><time dateTime={note.createdAt}>{[clock(note.createdAt), minutes(note.duration)].filter(Boolean).join(' · ')}</time></button>{!selecting && pickable(note) && <button className="note-quick-delete" aria-label={`Xoá “${note.title}”`} title="Xoá" onClick={() => removeNotes([note.id])}><Trash2 size={14}/></button>}</div> })}</div>)}{visible.length === 0 && <p className="muted empty-list">{search ? 'Không tìm thấy ghi chú khớp.' : day ? 'Ngày này không có ghi chú.' : 'Chưa có ghi chú. Tạo ghi chú mới hoặc chọn nhóm khác.'}</p>}</div>{undo && <div className="note-undo" role="status"><span>Đã xoá {undo.length === 1 ? `“${undo[0].title || 'Chưa có tiêu đề'}”` : `${undo.length} ghi chú`}</span><button onClick={undoDelete}>Hoàn tác</button></div>}</section>
      {selected ? <section className="glass-card strong note-editor" key={selected.id}><div className="note-editor-scroll">{selected.isDemo ? <><small className="accent-text">Ghi chú mẫu · chỉ đọc</small><h2>{selected.title}</h2></> : <><div className="note-title-row"><NoteTitle title={selected.title} fresh={selected.id === freshID} onRename={title => model.updateNote(selected.id, { title })}/><button className="pill-btn" onClick={() => removeNotes([selected.id])}><Trash2 size={15}/>Xóa</button></div><div className="note-group-row"><span>Nhóm</span><Choice className="note-group-choice" icon={<Folder size={15}/>} chevron={16} label="Nhóm" value={selected.groupID ?? ''} onChange={value => model.updateNote(selected.id, { groupID: value || null })} options={[{ value: '', label: 'Tất cả' }, ...model.noteGroups.map(group => ({ value: group.id, label: group.name }))]}/><small className="note-date" title="Tự động lưu">{formatTime(selected.createdAt)}{selected.duration > 0 && ` · ${Math.floor(selected.duration / 60)} phút`}</small></div></>}
        {selected.isDemo && <div className="note-date">{formatTime(selected.createdAt)}{selected.duration > 0 && ` · ${Math.floor(selected.duration / 60)} phút`}</div>}<div className="divider"/><div className="note-content-heading">{selected.isDemo ? <h3>Nội dung ghi chú</h3> : <div className="segmented note-view-tabs" role="tablist" aria-label="Nội dung"><button role="tab" aria-selected={!documentsView} className={!documentsView ? 'selected' : ''} onClick={() => { setView('summary'); setEditMode(false) }}>Tóm tắt</button><button role="tab" aria-selected={documentsView} className={documentsView ? 'selected' : ''} onClick={() => { setView('documents'); setEditMode(false) }}><Sparkles size={13}/>AI viết{selected.documents?.length ? <small>{selected.documents.length}</small> : null}{writingHere && <span className="nav-busy" aria-label="Đang viết"/>}</button></div>}<div className="note-content-actions">{copied === 'failed' && <small className="accent-text">Không copy được</small>}{(!documentsView || (selectedDocument && !writingHere)) && <NoteExport note={selected} document={selectedDocument ?? undefined} groupName={model.noteGroups.find(group => group.id === selected.groupID)?.name}/>} {!documentsView && !selected.isDemo && !selected.structuredSummary && <button className={`icon-btn inline-summary-toggle ${editMode ? 'selected' : ''}`} onClick={() => setEditMode(value => !value)} aria-pressed={editMode} aria-label={editMode ? 'Xem nội dung' : 'Chỉnh sửa nội dung'} title={editMode ? 'Xong' : 'Chỉnh sửa'}>{editMode ? <Check size={16}/> : <SquarePen size={16}/>}</button>}{documentsView && selectedDocument && !writingHere && <div className="segmented"><button className={!editMode ? 'selected' : ''} onClick={() => setEditMode(false)}>Xem</button><button className={editMode ? 'selected' : ''} onClick={() => setEditMode(true)}>Chỉnh sửa</button></div>}{!documentsView && selected.structuredSummary && structuredSummaryHasEvidence(selected.structuredSummary) && <button className={`icon-btn evidence-toolbar ${evidenceShown ? 'selected' : ''}`} onClick={toggleEvidence} aria-pressed={evidenceShown} aria-label={evidenceShown ? 'Ẩn mốc thời gian' : 'Hiện mốc thời gian'} title={evidenceShown ? 'Ẩn mốc thời gian' : 'Hiện mốc thời gian'}><Clock3 size={16}/></button>}<button className="icon-btn panel-expand" onClick={() => setExpanded(value => !value)} aria-pressed={expanded} aria-label={expanded ? 'Thu nhỏ ghi chú' : 'Mở rộng ghi chú'} title={expanded ? 'Thu nhỏ (Esc)' : 'Mở rộng: chỉ xem tiêu đề, thời gian và nội dung'}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button></div></div>
        {documentsView ? <NoteDocuments note={selected} model={model} selected={selectedDocument} onSelect={id => { setDocumentID(id ?? 'new'); setEditMode(false) }} editing={editMode}/> : editMode && !selected.isDemo && !selected.structuredSummary ? <textarea className="note-textarea" value={selected.summary} onChange={e => model.updateNote(selected.id, { summary: e.target.value })} aria-label="Nội dung ghi chú" placeholder="Gõ nội dung ghi chú…"/> : selected.structuredSummary ? <StructuredMeetingSummaryView summary={selected.structuredSummary} showEvidence={evidenceShown} editable={!selected.isDemo} onChange={summary => model.updateNote(selected.id, { structuredSummary: summary })} onEvidence={showEvidence} evidenceLabel={evidenceLabel}/> : <div className="note-moments">{noteMoments(selected.summary).length ? <><div className="moments-caption"><Clock3 size={15}/>{noteMoments(selected.summary).length} mốc nội dung<span>Nhấn vào từng mốc để xem chi tiết</span></div>{noteMoments(selected.summary).map(moment => <NoteMomentCard key={`${selected.id}-${moment.id}`} moment={moment} defaultOpen={moment.id === 0}/>)}</> : <div className="empty-note"><SquarePen size={26}/><h3>Chưa có nội dung</h3><p>Nhấn nút bút chì để thêm nội dung cho ghi chú này.</p></div>}</div>}
        <div className="divider"/><details className="transcript-disclosure" ref={transcriptDetails}><summary><span>Transcript gốc · chỉ đọc</span>{(selected.transcriptSegments?.length || selected.transcript.trim()) && <button type="button" className="copy-btn" onClick={event => { event.preventDefault(); void copy('transcript', noteTranscriptText(selected)) }} title="Copy transcript">{copied === 'transcript' ? <Check size={14}/> : <Copy size={14}/>}{copied === 'transcript' ? 'Đã copy' : 'Copy'}</button>}</summary>{selected.transcriptSegments?.length ? <div className="saved-transcript">{selected.transcriptSegments.map(segment => <article id={`transcript-${segment.id}`} key={segment.id} className={highlightedEvidence.includes(segment.id) ? 'evidence-highlight' : ''}><small>{formatTime(segment.timestamp, false)} · {segment.audioSource === 'microphone' ? 'Microphone' : segment.audioSource === 'file' ? 'File ghi âm' : 'System audio'}{segment.speaker ? ` · ${segment.speaker}${segment.speakerProvisional ? ' (tạm)' : ''}` : ''}</small><p>{segment.cleanText}</p>{segment.rawText !== segment.cleanText && <small className="raw-transcript">Bản nhận diện gốc: {segment.rawText}</small>}</article>)}</div> : <p>{selected.transcript || 'Ghi chú này không có transcript.'}</p>}</details></div><NoteChat key={selected.id} note={selected} chat={model.noteChat} onEvidence={showEvidence}/></section> : <section className="glass-card strong note-empty">Chọn hoặc tạo ghi chú để bắt đầu.</section>}
    </div>{dialog && <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null) }}><form className="app-dialog" role="dialog" aria-modal="true" aria-label={dialog === 'deleteNote' ? 'Xóa cuộc họp' : dialog === 'deleteGroup' ? 'Xóa nhóm' : dialog === 'createGroup' ? 'Tạo nhóm' : 'Đổi tên'} onSubmit={event => { event.preventDefault(); submitDialog() }}><h2>{dialog === 'createGroup' ? 'Tạo nhóm ghi chú' : dialog === 'renameGroup' ? 'Đổi tên nhóm' : dialog === 'deleteNote' ? 'Xóa cuộc họp?' : 'Xóa nhóm?'}</h2>{dialog === 'deleteNote' ? <p>Cuộc họp này sẽ bị xóa vĩnh viễn.</p> : dialog === 'deleteGroup' ? <p>Ghi chú trong nhóm vẫn còn ở Tất cả.</p> : <label className="field"><span>TÊN NHÓM</span><input autoFocus value={dialogValue} onChange={event => setDialogValue(event.target.value)} required/></label>}{dialogError && <p className="dialog-error">{dialogError}</p>}<div className="dialog-actions"><button type="button" className="pill-btn" onClick={() => setDialog(null)}>Hủy</button><button type="submit" className="pill-btn primary">{dialog === 'deleteNote' || dialog === 'deleteGroup' ? 'Xóa' : 'Lưu'}</button></div></form></div>}
  </main>
}

/** The note title is edited in place: Enter or leaving the field saves, Esc or an empty title reverts. */
function NoteTitle({ title, fresh, onRename }: { title: string; fresh?: boolean; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState(title)
  useEffect(() => setDraft(title), [title])
  const commit = () => {
    const value = draft.trim()
    if (value && value !== title) onRename(value)
    else setDraft(title)
  }
  // A new note starts with its name selected, so typing replaces "Ghi chú mới".
  return <input className="note-title-input" aria-label="Tên cuộc họp" title="Nhấn để đổi tên" value={draft} placeholder="Chưa có tiêu đề" spellCheck={false} autoFocus={fresh} onFocus={event => { if (fresh) event.currentTarget.select() }}
    onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur(); if (fresh) document.querySelector<HTMLTextAreaElement>('.note-textarea')?.focus() } if (event.key === 'Escape') { event.stopPropagation(); setDraft(title); requestAnimationFrame(() => event.currentTarget?.blur()) } }}/>
}
