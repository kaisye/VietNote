import type { MeetingNote, NoteGroup, StructuredMeetingSummary, TranscriptSegment } from './types'

export const emptyStructuredSummary = (): StructuredMeetingSummary => ({
  tldr: '', keyPoints: [], decisions: [], tentativeDecisions: [], unresolvedTopics: [],
  actionItems: [], openQuestions: [], deferred: [],
})

export function formatStructuredSummary(summary: StructuredMeetingSummary): string {
  const blocks: string[] = []
  if (summary.tldr.trim()) blocks.push(`TÓM TẮT NHANH\n${summary.tldr.trim()}`)
  const bullets = (title: string, values: string[]) => { if (values.length) blocks.push(`${title}\n${values.map(value => `• ${value}`).join('\n')}`) }
  bullets('Ý CHÍNH', summary.keyPoints.map(item => item.text))
  bullets('QUYẾT ĐỊNH', summary.decisions.map(item => item.text))
  bullets('QUYẾT ĐỊNH TẠM THỜI', summary.tentativeDecisions.map(item => item.text))
  bullets('VẤN ĐỀ CHƯA CHỐT', summary.unresolvedTopics.map(item => `${item.topic}${item.options.length ? ` · Lựa chọn: ${item.options.join(', ')}` : ''} · ${item.status === 'No final decision' ? 'Chưa có quyết định cuối cùng' : item.status}`))
  bullets('VIỆC CẦN LÀM', summary.actionItems.map(item => [item.owner, item.task, item.deadline].filter(Boolean).join(' → ')))
  bullets('CÂU HỎI MỞ', summary.openQuestions.map(item => item.text))
  bullets('NỘI DUNG TẠM HOÃN', summary.deferred.map(item => [item.text, item.target].filter(Boolean).join(' → ')))
  return blocks.join('\n\n')
}

export function toTranscriptSegment(entry: { id: string; timestamp: string; startedAt: number; audioSource: string; sourceText: string; rawText?: string }): TranscriptSegment {
  return { id: entry.id, timestamp: entry.timestamp, startedAt: entry.startedAt, audioSource: entry.audioSource, rawText: entry.rawText ?? entry.sourceText, cleanText: entry.sourceText }
}

export interface NoteMoment { id: number; title: string; overview: string[]; decisions: string[]; actions: string[] }

export function noteMoments(text: string): NoteMoment[] {
  const moments: NoteMoment[] = []
  let current: NoteMoment = { id: 0, title: 'Nội dung chính', overview: [], decisions: [], actions: [] }
  let section: 'overview' | 'decisions' | 'actions' = 'overview'
  const flush = () => { if (current.overview.length || current.decisions.length || current.actions.length) moments.push(current) }
  for (const raw of text.split(/\r?\n/)) {
    const normalized = raw.trim().replace(/[*#]/g, '').trim()
    if (!normalized) continue
    const upper = normalized.toLocaleUpperCase('vi-VN')
    if (upper.startsWith('ĐOẠN ')) { flush(); current = { id: moments.length, title: normalized, overview: [], decisions: [], actions: [] }; section = 'overview'; continue }
    if (upper === 'TÓM TẮT' || upper === 'TÓM TẮT:' || upper === 'TÓM TẮT NHANH' || upper === 'TÓM TẮT NHANH:' || upper === 'TÓM TẮT TỔNG QUAN' || upper === 'TÓM TẮT TỔNG QUAN:' || upper === 'Ý CHÍNH' || upper === 'Ý CHÍNH:') { section = 'overview'; continue }
    if (upper === 'QUYẾT ĐỊNH' || upper === 'QUYẾT ĐỊNH:') { section = 'decisions'; continue }
    if (upper === 'VIỆC CẦN LÀM' || upper === 'VIỆC CẦN LÀM:') { section = 'actions'; continue }
    if (['QUYẾT ĐỊNH TẠM THỜI', 'VẤN ĐỀ CHƯA CHỐT', 'CÂU HỎI MỞ', 'NỘI DUNG TẠM HOÃN'].includes(upper.replace(/:$/, ''))) continue
    const content = normalized.replace(/^[-•\s]+/, '').trim()
    if (!content || (section !== 'overview' && /^chưa có[ .;:]*$/i.test(content))) continue
    current[section].push(content)
  }
  flush()
  return moments
}

export const demoNote: MeetingNote = {
  id: 'demo', title: 'Demo · Review khảo sát người dùng',
  createdAt: new Date(Date.now() - 86400000).toISOString(), updatedAt: new Date(Date.now() - 86400000).toISOString(), duration: 1080,
  summary: 'TÓM TẮT\n• Khảo sát người dùng chưa hoàn tất: đã nhận 86/120 phản hồi, nhóm nhân viên mới còn thiếu dữ liệu.\n• Bản thử nghiệm meeting note đã nhận diện tốt các ý chính nhưng cần kiểm tra thêm trong môi trường ồn.\n\nQUYẾT ĐỊNH\n• Gia hạn khảo sát đến 17 giờ thứ Năm.\n• Giữ phạm vi bản demo ở microphone và tiếng Việt.\n\nVIỆC CẦN LÀM\n• Lan gửi nhắc khảo sát và tổng hợp kết quả trước 10 giờ thứ Sáu.\n• Huy kiểm thử nhận diện với ba mức tiếng ồn và báo cáo tỷ lệ lỗi.\n• Minh chuẩn bị bản demo meeting note cho buổi review thứ Hai.',
  transcript: '09:00 · Minh: Hôm nay nhóm rà soát tiến độ khảo sát người dùng và bản demo meeting note.\n09:02 · Lan: Khảo sát chưa hoàn tất. Hiện có 86 trên 120 phản hồi, nhóm nhân viên mới vẫn còn thiếu dữ liệu.\n09:05 · Lan: Tôi đề xuất gia hạn khảo sát đến 17 giờ thứ Năm và sẽ tổng hợp kết quả trước 10 giờ thứ Sáu.\n09:08 · Huy: Bản thử nghiệm đã nhận diện tốt các ý chính, nhưng vẫn cần kiểm tra trong môi trường có tiếng ồn.\n09:11 · Huy: Tôi sẽ thử ba mức tiếng ồn và báo cáo tỷ lệ lỗi trước cuối ngày thứ Sáu.\n09:14 · Minh: Nhóm thống nhất giữ phạm vi demo ở microphone và tiếng Việt. Tôi sẽ chuẩn bị bản demo meeting note cho buổi review thứ Hai.',
  isDemo: true,
}

export function createNote(groupID?: string | null): MeetingNote {
  const now = new Date().toISOString()
  return { id: crypto.randomUUID(), title: 'Ghi chú mới', createdAt: now, updatedAt: now, duration: 0, summary: '', transcript: '', groupID }
}

export function noteInScope(note: MeetingNote, scope: string, groups: NoteGroup[]): boolean {
  if (scope === 'all') return true
  if (scope === 'inbox') return !note.isDemo && (!note.groupID || !groups.some(group => group.id === note.groupID))
  return note.groupID === scope
}

export function formatTime(date: string, datePart = true): string {
  const value = new Date(date)
  return Number.isNaN(value.getTime()) ? date : new Intl.DateTimeFormat('vi-VN', datePart ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'short' }).format(value)
}
