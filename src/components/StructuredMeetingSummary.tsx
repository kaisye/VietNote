import { useEffect, useState } from 'react'
import { Check, CheckCheck, CircleHelp, Clock3, GitBranch, ListTodo, PauseCircle, Pencil, Plus, Sparkles, Text, Trash2, X } from 'lucide-react'
import type { ActionItem, DeferredItem, StructuredMeetingSummary, SummaryBullet, UnresolvedTopic } from '../services/types'

type EvidenceHandler = (ids: string[]) => void
type EvidenceLabel = (id: string) => string | undefined

export function structuredSummaryHasEvidence(summary: StructuredMeetingSummary) {
  return [summary.keyPoints, summary.decisions, summary.tentativeDecisions, summary.unresolvedTopics, summary.actionItems, summary.openQuestions, summary.deferred]
    .some(items => items.some(item => item.evidenceIds.length))
}

function Evidence({ ids, onEvidence, evidenceLabel }: { ids: string[]; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  if (!ids.length || !onEvidence) return null
  const first = evidenceLabel?.(ids[0]) ?? 'Xem timestamp'
  return <button className="evidence-link" onClick={() => onEvidence(ids)} title="Mở đoạn transcript làm bằng chứng"><Clock3 size={12}/>{ids.length === 1 ? first : `${first} +${ids.length - 1}`}</button>
}

function EditButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button type="button" className="section-edit-button" onClick={onClick} aria-label={label} title={label}><Pencil size={13}/></button>
}

function EditorActions({ onAdd, onCancel, onSave }: { onAdd?: () => void; onCancel: () => void; onSave: () => void }) {
  return <div className="inline-editor-actions">{onAdd && <button type="button" onClick={onAdd}><Plus size={13}/>Thêm dòng</button>}<span/><button type="button" onClick={onCancel}><X size={13}/>Hủy</button><button type="button" className="save" onClick={onSave}><Check size={13}/>Lưu</button></div>
}

function Tldr({ text, editable, onChange }: { text: string; editable?: boolean; onChange?: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  useEffect(() => { if (!editing) setDraft(text) }, [text, editing])
  const cancel = () => { setDraft(text); setEditing(false) }
  const save = () => { const value = draft.trim(); if (value) onChange?.(value); setEditing(false) }
  return <section className={`structured-tldr tone-summary ${editing ? 'editing' : ''}`}><h4><Sparkles size={15}/>Tóm tắt nhanh{editable && !editing && <EditButton onClick={() => setEditing(true)} label="Chỉnh sửa tóm tắt nhanh"/>}</h4>{editing ? <div className="inline-section-editor"><textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') cancel(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save() }} aria-label="Nội dung tóm tắt nhanh"/><EditorActions onCancel={cancel} onSave={save}/></div> : <p>{text}</p>}</section>
}

type BulletDraft = { original: SummaryBullet | null; text: string }
function BulletSection({ title, tone, icon: Icon, items, editable, displayText = item => item.text, onChange, onEvidence, evidenceLabel }: { title: string; tone: string; icon: typeof Text; items: SummaryBullet[]; editable?: boolean; displayText?: (item: SummaryBullet) => string; onChange?: (items: SummaryBullet[]) => void; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<BulletDraft[]>([])
  const begin = () => { setDrafts(items.map(item => ({ original: item, text: item.text }))); setEditing(true) }
  const cancel = () => { setDrafts([]); setEditing(false) }
  const save = () => { onChange?.(drafts.map(({ original, text }) => ({ ...(original ?? { id: crypto.randomUUID(), evidenceIds: [] }), text: text.trim() })).filter(item => item.text)); setEditing(false) }
  if (!items.length && !editing) return null
  return <section className={`structured-section tone-${tone} ${editing ? 'editing' : ''}`}><h4><Icon size={15}/>{title}{editable && !editing && <EditButton onClick={begin} label={`Chỉnh sửa ${title.toLocaleLowerCase('vi-VN')}`}/>}</h4>{editing ? <div className="inline-section-editor">{drafts.map((draft, index) => <div className="inline-editor-row" key={draft.original?.id ?? `new-${index}`}><textarea autoFocus={index === 0} value={draft.text} onChange={event => setDrafts(values => values.map((value, itemIndex) => itemIndex === index ? { ...value, text: event.target.value } : value))} onKeyDown={event => { if (event.key === 'Escape') cancel(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save() }} aria-label={`${title} ${index + 1}`}/><button type="button" onClick={() => setDrafts(values => values.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Xóa dòng ${index + 1}`}><Trash2 size={14}/></button></div>)}<EditorActions onAdd={() => setDrafts(values => [...values, { original: null, text: '' }])} onCancel={cancel} onSave={save}/></div> : items.length ? <ul>{items.map((item, index) => <li key={item.id || `${title}-${index}`}><span>{displayText(item)}</span><Evidence ids={item.evidenceIds} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/></li>)}</ul> : <p className="inline-empty">Chưa có nội dung.</p>}</section>
}

type ActionDraft = { original: ActionItem | null; owner: string; task: string; deadline: string }
function Actions({ items, editable, onChange, onEvidence, evidenceLabel }: { items: ActionItem[]; editable?: boolean; onChange?: (items: ActionItem[]) => void; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<ActionDraft[]>([])
  const begin = () => { setDrafts(items.map(item => ({ original: item, owner: item.owner ?? '', task: item.task, deadline: item.deadline ?? '' }))); setEditing(true) }
  const cancel = () => { setDrafts([]); setEditing(false) }
  const save = () => { onChange?.(drafts.map(({ original, owner, task, deadline }) => ({ ...(original ?? { id: crypto.randomUUID(), evidenceIds: [] }), owner: owner.trim() || null, task: task.trim(), deadline: deadline.trim() || null })).filter(item => item.task)); setEditing(false) }
  if (!items.length && !editing) return null
  return <section className={`structured-section tone-action ${editing ? 'editing' : ''}`}><h4><ListTodo size={15}/>Việc cần làm{editable && !editing && <EditButton onClick={begin} label="Chỉnh sửa việc cần làm"/>}</h4>{editing ? <div className="inline-section-editor">{drafts.map((draft, index) => <div className="inline-editor-row action" key={draft.original?.id ?? `new-${index}`}><input value={draft.owner} onChange={event => setDrafts(values => values.map((value, itemIndex) => itemIndex === index ? { ...value, owner: event.target.value } : value))} placeholder="Người phụ trách" aria-label={`Người phụ trách ${index + 1}`}/><textarea autoFocus={index === 0} value={draft.task} onChange={event => setDrafts(values => values.map((value, itemIndex) => itemIndex === index ? { ...value, task: event.target.value } : value))} onKeyDown={event => { if (event.key === 'Escape') cancel(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save() }} aria-label={`Việc cần làm ${index + 1}`}/><input value={draft.deadline} onChange={event => setDrafts(values => values.map((value, itemIndex) => itemIndex === index ? { ...value, deadline: event.target.value } : value))} placeholder="Hạn hoàn thành" aria-label={`Hạn hoàn thành ${index + 1}`}/><button type="button" onClick={() => setDrafts(values => values.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Xóa việc ${index + 1}`}><Trash2 size={14}/></button></div>)}<EditorActions onAdd={() => setDrafts(values => [...values, { original: null, owner: '', task: '', deadline: '' }])} onCancel={cancel} onSave={save}/></div> : items.length ? <ul>{items.map((item, index) => <li key={item.id || `action-${index}`}><span>{[item.owner, item.task, item.deadline].filter(Boolean).join(' → ')}</span><Evidence ids={item.evidenceIds} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/></li>)}</ul> : <p className="inline-empty">Chưa có nội dung.</p>}</section>
}

type TopicDraft = { original: UnresolvedTopic; topic: string; options: string }
function Unresolved({ items, editable, onChange, onEvidence, evidenceLabel }: { items: UnresolvedTopic[]; editable?: boolean; onChange?: (items: UnresolvedTopic[]) => void; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<TopicDraft[]>([])
  const begin = () => { setDrafts(items.map(item => ({ original: item, topic: item.topic, options: item.options.join(', ') }))); setEditing(true) }
  const cancel = () => { setDrafts([]); setEditing(false) }
  const save = () => { onChange?.(drafts.map(({ original, topic, options }) => ({ ...original, topic: topic.trim(), text: topic.trim(), options: options.split(',').map(value => value.trim()).filter(Boolean) })).filter(item => item.topic)); setEditing(false) }
  if (!items.length) return null
  return <section className={`structured-section tone-unresolved ${editing ? 'editing' : ''}`}><h4><GitBranch size={15}/>Vấn đề chưa chốt{editable && !editing && <EditButton onClick={begin} label="Chỉnh sửa vấn đề chưa chốt"/>}</h4>{editing ? <div className="inline-section-editor">{drafts.map((draft, index) => <div className="inline-editor-row topic" key={draft.original.id}><textarea autoFocus={index === 0} value={draft.topic} onChange={event => setDrafts(values => values.map((value, itemIndex) => itemIndex === index ? { ...value, topic: event.target.value } : value))} onKeyDown={event => { if (event.key === 'Escape') cancel(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save() }} aria-label={`Vấn đề chưa chốt ${index + 1}`}/><input value={draft.options} onChange={event => setDrafts(values => values.map((value, itemIndex) => itemIndex === index ? { ...value, options: event.target.value } : value))} placeholder="Các lựa chọn, cách nhau bằng dấu phẩy" aria-label={`Các lựa chọn ${index + 1}`}/><button type="button" onClick={() => setDrafts(values => values.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Xóa vấn đề ${index + 1}`}><Trash2 size={14}/></button></div>)}<EditorActions onCancel={cancel} onSave={save}/></div> : <ul>{items.map((item, index) => <li key={item.id || `unresolved-${index}`}><strong>{item.topic}</strong>{item.options.length > 0 && <small>Lựa chọn: {item.options.join(', ')}</small>}<small>{item.status === 'No final decision' ? 'Chưa có quyết định cuối cùng' : item.status}</small><Evidence ids={item.evidenceIds} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/></li>)}</ul>}</section>
}

export function StructuredMeetingSummaryView({ summary, showEvidence = false, editable = false, onChange, onEvidence, evidenceLabel }: { summary: StructuredMeetingSummary; showEvidence?: boolean; editable?: boolean; onChange?: (summary: StructuredMeetingSummary) => void; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  const hasEvidence = Boolean(onEvidence) && structuredSummaryHasEvidence(summary)
  return <div className={`structured-summary ${hasEvidence && !showEvidence ? 'hide-evidence' : ''}`}><div className="structured-sheet">
    {summary.tldr && <Tldr text={summary.tldr} editable={editable} onChange={tldr => onChange?.({ ...summary, tldr })}/>}
    <BulletSection title="Ý chính" tone="summary" icon={Text} items={summary.keyPoints} editable={editable} onChange={keyPoints => onChange?.({ ...summary, keyPoints })} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Quyết định" tone="decision" icon={CheckCheck} items={summary.decisions} editable={editable} onChange={decisions => onChange?.({ ...summary, decisions })} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Quyết định dự kiến" tone="unresolved" icon={Clock3} items={summary.tentativeDecisions} editable={editable} onChange={tentativeDecisions => onChange?.({ ...summary, tentativeDecisions })} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <Unresolved items={summary.unresolvedTopics} editable={editable} onChange={unresolvedTopics => onChange?.({ ...summary, unresolvedTopics })} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <Actions items={summary.actionItems} editable={editable} onChange={actionItems => onChange?.({ ...summary, actionItems })} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Câu hỏi mở" tone="unresolved" icon={CircleHelp} items={summary.openQuestions} editable={editable} onChange={openQuestions => onChange?.({ ...summary, openQuestions })} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Tạm hoãn" tone="muted" icon={PauseCircle} items={summary.deferred} editable={editable} displayText={item => [item.text, (item as DeferredItem).target].filter(Boolean).join(' → ')} onChange={deferred => onChange?.({ ...summary, deferred: deferred.map(item => ({ ...item, target: summary.deferred.find(old => old.id === item.id)?.target })) })} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
  </div></div>
}
