import { CheckCheck, CircleHelp, Clock3, GitBranch, ListTodo, PauseCircle, Sparkles, Text } from 'lucide-react'
import type { ActionItem, StructuredMeetingSummary, SummaryBullet, UnresolvedTopic } from '../services/types'

type EvidenceHandler = (ids: string[]) => void
type EvidenceLabel = (id: string) => string | undefined

function Evidence({ ids, onEvidence, evidenceLabel }: { ids: string[]; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  if (!ids.length || !onEvidence) return null
  const first = evidenceLabel?.(ids[0]) ?? 'Xem timestamp'
  return <button className="evidence-link" onClick={() => onEvidence(ids)} title="Mở đoạn transcript làm bằng chứng"><Clock3 size={12}/>{ids.length === 1 ? first : `${first} +${ids.length - 1}`}</button>
}

function BulletSection({ title, icon: Icon, items, onEvidence, evidenceLabel }: { title: string; icon: typeof Text; items: SummaryBullet[]; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  if (!items.length) return null
  return <section className="structured-section"><h4><Icon size={15}/>{title}</h4><ul>{items.map((item, index) => <li key={item.id || `${title}-${index}`}><span>{item.text}</span><Evidence ids={item.evidenceIds} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/></li>)}</ul></section>
}

function Actions({ items, onEvidence, evidenceLabel }: { items: ActionItem[]; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  if (!items.length) return null
  return <section className="structured-section"><h4><ListTodo size={15}/>Việc cần làm</h4><ul>{items.map((item, index) => <li key={item.id || `action-${index}`}><span>{[item.owner, item.task, item.deadline].filter(Boolean).join(' → ')}</span><Evidence ids={item.evidenceIds} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/></li>)}</ul></section>
}

function Unresolved({ items, onEvidence, evidenceLabel }: { items: UnresolvedTopic[]; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  if (!items.length) return null
  return <section className="structured-section"><h4><GitBranch size={15}/>Vấn đề chưa chốt</h4><ul>{items.map((item, index) => <li key={item.id || `unresolved-${index}`}><strong>{item.topic}</strong>{item.options.length > 0 && <small>Lựa chọn: {item.options.join(', ')}</small>}<small>{item.status === 'No final decision' ? 'Chưa có quyết định cuối cùng' : item.status}</small><Evidence ids={item.evidenceIds} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/></li>)}</ul></section>
}

export function StructuredMeetingSummaryView({ summary, onEvidence, evidenceLabel }: { summary: StructuredMeetingSummary; onEvidence?: EvidenceHandler; evidenceLabel?: EvidenceLabel }) {
  return <div className="structured-summary">
    {summary.tldr && <section className="structured-tldr"><h4><Sparkles size={15}/>Tóm tắt nhanh</h4><p>{summary.tldr}</p></section>}
    <BulletSection title="Ý chính" icon={Text} items={summary.keyPoints} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Quyết định" icon={CheckCheck} items={summary.decisions} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Quyết định dự kiến" icon={Clock3} items={summary.tentativeDecisions} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <Unresolved items={summary.unresolvedTopics} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <Actions items={summary.actionItems} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Câu hỏi mở" icon={CircleHelp} items={summary.openQuestions} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
    <BulletSection title="Tạm hoãn" icon={PauseCircle} items={summary.deferred.map(item => ({ ...item, text: [item.text, item.target].filter(Boolean).join(' → ') }))} onEvidence={onEvidence} evidenceLabel={evidenceLabel}/>
  </div>
}
