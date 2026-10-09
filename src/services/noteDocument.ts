import type { DocumentKind, DocumentLength, MeetingNote, NoteDocument } from './types'

export const documentKinds: { kind: DocumentKind; label: string; hint: string }[] = [
  { kind: 'workshop', label: 'Tóm tắt workshop', hint: 'Hội thảo, buổi chia sẻ: ý lớn, ví dụ, cách áp dụng' },
  { kind: 'lecture', label: 'Tóm tắt buổi học', hint: 'Kiến thức, khái niệm, câu hỏi ôn tập' },
  { kind: 'meeting', label: 'Biên bản họp', hint: 'Thảo luận, quyết định, việc cần làm' },
  { kind: 'article', label: 'Bài viết chia sẻ', hint: 'Blog, newsletter: đủ hay để chia sẻ lại' },
  { kind: 'post', label: 'Bài đăng MXH', hint: 'LinkedIn, Facebook: ngắn, có hook' },
  { kind: 'custom', label: 'Theo yêu cầu', hint: 'Bạn mô tả, AI viết' },
]
export const documentLengths: { value: DocumentLength; label: string }[] = [
  { value: 'short', label: 'Ngắn' }, { value: 'medium', label: 'Vừa' }, { value: 'long', label: 'Chi tiết' },
]
export const kindLabel = (kind: DocumentKind) => documentKinds.find(item => item.kind === kind)?.label ?? 'Tài liệu'

const clock = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 3600)}:${String(Math.floor(total % 3600 / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** What the AI reads: one "[h:mm:ss] Speaker: words" line per transcript segment, timed from the start. */
export function transcriptLines(note: MeetingNote): string[] {
  const segments = note.transcriptSegments ?? []
  if (!segments.length) return note.transcript.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const start = new Date(segments[0].timestamp).getTime()
  return segments.filter(segment => segment.cleanText.trim()).map(segment => {
    const at = (new Date(segment.timestamp).getTime() - start) / 1000
    return `[${clock(Number.isFinite(at) ? at : 0)}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.cleanText.trim()}`
  })
}

/** The document's `# heading`, or the note title for a post that has none. */
export function documentTitle(document: NoteDocument, fallback: string): string {
  const heading = document.markdown.match(/^\s*#\s+(.+)$/m)?.[1]?.replace(/\*\*/g, '').trim()
  return heading || fallback.trim() || kindLabel(document.kind)
}
