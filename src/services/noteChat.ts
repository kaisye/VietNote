import { desktop, type NoteChatAnswer } from './desktop'
import { formatStructuredSummary } from './notes'
import type { MeetingNote, NoteChatMessage } from './types'

export const noteChatPrompts = [
  { label: 'Tóm tắt chi tiết', question: 'Tóm tắt chi tiết nội dung cuộc hội thoại theo từng chủ đề, bao gồm các ý kiến và kết luận đã được nêu.' },
  { label: 'Việc cần làm', question: 'Liệt kê các việc cần làm, người phụ trách và thời hạn được nhắc đến. Ghi rõ thông tin nào chưa được xác định.' },
  { label: 'Quyết định đã chốt', question: 'Những quyết định nào đã được thống nhất? Phân biệt với đề xuất hoặc ý kiến chưa được chốt.' },
  { label: 'Vấn đề còn bỏ ngỏ', question: 'Những câu hỏi, vấn đề hoặc bất đồng nào còn chưa được giải quyết trong cuộc hội thoại?' },
]

/** Keep recent follow-ups within the proxy's input budget; always send the complete source. */
export function noteChatHistory(messages: NoteChatMessage[]) {
  const history: { role: 'user' | 'assistant'; content: string }[] = []
  let size = 0
  for (const message of messages.slice(-10).reverse()) {
    if (size + message.content.length > 20_000) break
    history.unshift({ role: message.role, content: message.content })
    size += message.content.length
  }
  // Start at a user turn rather than an orphaned reply.
  if (history[0]?.role === 'assistant') history.shift()
  return history
}

export function askNoteQuestion(note: MeetingNote, question: string, onProgress?: (answer: NoteChatAnswer) => void) {
  return desktop.askNote({
    title: note.title,
    summary: note.structuredSummary ? formatStructuredSummary(note.structuredSummary) : note.summary,
    transcript: note.transcriptSegments?.length ? '' : note.transcript,
    segments: note.transcriptSegments ?? [],
    history: noteChatHistory(note.chatMessages ?? []),
    question: question.trim(),
  }, onProgress)
}

/** Apply a late reply to its original note without overwriting other edits or resurrecting deletions. */
export function appendNoteChat(notes: MeetingNote[], source: MeetingNote, messages: NoteChatMessage[]): MeetingNote[] {
  const current = notes.find(note => note.id === source.id)
  if (!current) return notes
  if (current.summary !== source.summary || current.transcript !== source.transcript || current.transcriptSegments !== source.transcriptSegments) {
    throw new Error('Nội dung ghi chú đã thay đổi. Hãy gửi lại câu hỏi để dùng nội dung mới.')
  }
  return notes.map(note => note.id === source.id ? { ...note, chatMessages: [...(note.chatMessages ?? []), ...messages] } : note)
}
