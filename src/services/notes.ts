import type { NoteSource, MeetingNote, NoteGroup, StructuredMeetingSummary, TimedTranslation, TranscriptSegment, Subtitle } from './types'

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

export function toTranscriptSegment(entry: Pick<Subtitle, 'id' | 'timestamp' | 'startedAt' | 'audioSource' | 'sourceText' | 'rawText' | 'endedAt' | 'speaker' | 'speakerProvisional'>): TranscriptSegment {
  return { id: entry.id, timestamp: entry.timestamp, startedAt: entry.startedAt, audioSource: entry.audioSource, rawText: entry.rawText ?? entry.sourceText, cleanText: entry.sourceText, endedAt: entry.endedAt, speaker: entry.speaker, speakerProvisional: entry.speakerProvisional }
}

/**
 * The translation saved with a note for timed subtitles: each line's own live translation
 * when there is one (it matches the speech exactly), else the paragraph covering it.
 */
export function timedTranslations(liveText: Map<string, string>, paragraphs: TimedTranslation[]): TimedTranslation[] {
  const live = [...liveText].filter(([, text]) => text.trim()).map(([id, text]) => ({ entryIds: [id], text }))
  const covered = new Set(live.flatMap(item => item.entryIds))
  const rest = paragraphs.filter(block => block.text.trim() && !block.entryIds.some(id => covered.has(id)))
  return [...live, ...rest]
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
  return { id: crypto.randomUUID(), title: 'Ghi chú mới', createdAt: now, updatedAt: now, duration: 0, summary: '', transcript: '', groupID, source: 'manual' }
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

/** Plain text for "copy content": title, meeting time and the note body. */
export function noteContentText(note: MeetingNote): string {
  const body = note.structuredSummary ? formatStructuredSummary(note.structuredSummary) : note.summary.trim()
  return [note.title || 'Chưa có tiêu đề', formatTime(note.createdAt), body].filter(Boolean).join('\n\n')
}

/** Plain text for "copy transcript": one timestamped line per segment, with the speaker when known. */
export function noteTranscriptText(note: MeetingNote): string {
  if (!note.transcriptSegments?.length) return note.transcript.trim()
  return note.transcriptSegments.map(segment => `[${formatTime(segment.timestamp, false)}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.cleanText}`).join('\n')
}

/** Where a note came from, guessed from its content for notes saved before `source` existed. */
export function noteSource(note: MeetingNote): NoteSource {
  if (note.source) return note.source
  if (/^Nguồn: https?:\/\//.test(note.transcript)) return 'link'
  if (note.transcriptSegments?.some(segment => segment.audioSource === 'file')) return 'file'
  if (note.title.startsWith('Phiên dịch')) return 'translate'
  return note.transcriptSegments?.length || note.transcript.trim() || note.isDemo ? 'meeting' : 'manual'
}

/** A name made from the date alone ("Cuộc họp · 22:47 10/10/26"), which says nothing of the content. */
export const hasDateTitle = (note: MeetingNote) => /^(Cuộc họp|Phiên dịch) · [\d:,/ ]+$/.test(note.title.trim())

/** The opening of what was said, for naming a note. */
export function titleSourceText(note: MeetingNote): string {
  const text = note.transcriptSegments?.length ? note.transcriptSegments.map(segment => segment.cleanText).join('\n') : note.transcript
  return text.slice(0, 6000).trim()
}

/** Lowercase without Vietnamese marks, so "hop" finds "họp". */
export const searchKey = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLocaleLowerCase()

export function noteMatches(note: MeetingNote, query: string): boolean {
  const words = searchKey(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = searchKey([note.title, note.summary, note.structuredSummary?.tldr ?? '', note.transcript, ...(note.documents ?? []).map(document => document.markdown)].join('\n'))
  return words.every(word => text.includes(word))
}

/** The local calendar day, as YYYY-MM-DD. */
export function dayKey(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return ''
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

/** "Hôm nay", "Hôm qua", or the weekday and date (with the year when not this year). */
export function dayLabel(key: string, today = new Date()): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (key === dayKey(today)) return 'Hôm nay'
  if (key === dayKey(yesterday)) return 'Hôm qua'
  const weekday = new Intl.DateTimeFormat('vi-VN', { weekday: 'long' }).format(date)
  return `${weekday.charAt(0).toLocaleUpperCase()}${weekday.slice(1)}, ${day}/${month}${year === today.getFullYear() ? '' : `/${year}`}`
}

/** Under this many seconds, or this many characters said, a recording counts as short. */
const SHORT_SECONDS = 120
const SHORT_CHARACTERS = 300

/**
 * A note with little in it, offered for clean-up: a short or nearly silent recording, or an empty
 * hand-written note. Anything the user has put work into (renamed, filed in a group, asked the AI
 * about, had a document written from) is left alone.
 */
export function isShortNote(note: MeetingNote): boolean {
  if (note.isDemo || note.saving || note.titleEdited || note.groupID || note.documents?.length || note.chatMessages?.length) return false
  if (noteSource(note) === 'manual') return note.summary.trim().length < 20
  const said = note.transcriptSegments?.length ? note.transcriptSegments.map(segment => segment.cleanText).join(' ') : note.transcript
  return (note.duration > 0 && note.duration < SHORT_SECONDS) || said.trim().length < SHORT_CHARACTERS
}
