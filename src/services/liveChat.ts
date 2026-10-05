import { desktop, type NoteChatAnswer } from './desktop'
import { noteChatHistory } from './noteChat'
import { toTranscriptSegment } from './notes'
import type { NoteChatMessage, Subtitle, TranscriptSegment } from './types'

/** One-tap actions on a selected transcript passage. "Hỏi" opens the input instead. */
export const liveActions = [
  { id: 'explain', label: 'Giải thích', question: 'Giải thích đoạn trích này: ý người nói, thuật ngữ hoặc khái niệm khó, và vì sao nó quan trọng trong cuộc họp.' },
  { id: 'translate', label: 'Dịch', question: 'Dịch đoạn trích sang tiếng Việt tự nhiên. Nếu đoạn trích đã là tiếng Việt, dịch sang tiếng Anh. Chỉ trả về bản dịch, thêm một dòng ghi chú nếu có thuật ngữ cần lưu ý.' },
  { id: 'reply', label: 'Gợi ý trả lời', question: 'Gợi ý 2–3 cách tôi có thể trả lời hoặc phản hồi đoạn này ngay trong cuộc họp. Mỗi gợi ý một câu ngắn, nói thành lời được, kèm nhãn ngắn về sắc thái (đồng ý, hỏi lại, phản biện…).' },
] as const

const RECENT_MS = 5 * 60_000
const MAX_RECENT = 80
const MIN_RECENT = 20
const AROUND_QUOTE = 4

/**
 * The live transcript keeps growing, so only send the last few minutes plus the
 * lines around the quoted passage; the running summary covers everything earlier.
 */
export function liveSegments(entries: Subtitle[], focusIds: string[] = []): TranscriptSegment[] {
  if (!entries.length) return []
  const keep = new Set<number>()
  const latest = new Date(entries[entries.length - 1].timestamp).getTime()
  for (let index = entries.length - 1; index >= Math.max(0, entries.length - MAX_RECENT); index--) {
    const age = latest - new Date(entries[index].timestamp).getTime()
    if (entries.length - index > MIN_RECENT && age > RECENT_MS) break
    keep.add(index)
  }
  const focus = new Set(focusIds)
  entries.forEach((entry, index) => {
    if (!focus.has(entry.id)) return
    for (let near = Math.max(0, index - AROUND_QUOTE); near <= Math.min(entries.length - 1, index + AROUND_QUOTE); near++) keep.add(near)
  })
  return [...keep].sort((a, b) => a - b).map(index => toTranscriptSegment(entries[index]))
}

export interface LiveQuestion { question: string; label?: string; quote?: string; focusIds?: string[] }

export function askLiveQuestion(
  context: { title: string; summary: string; entries: Subtitle[] }, messages: NoteChatMessage[], request: LiveQuestion,
  onProgress?: (answer: NoteChatAnswer) => void,
) {
  return desktop.askNote({
    title: context.title,
    summary: context.summary,
    transcript: '',
    segments: liveSegments(context.entries, request.focusIds),
    history: noteChatHistory(messages),
    question: request.question.trim(),
    quote: request.quote?.trim() || undefined,
    live: true,
  }, onProgress)
}
