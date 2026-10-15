import type { TranscriptSegment } from './types'
import { clock, type WatchLine } from './youtube'

export interface WatchChatTurn { role: 'user' | 'assistant'; content: string }

/** Give the assistant the whole available script, including untranslated lines, with seekable IDs. */
export function watchChatSegments(lines: WatchLine[]): TranscriptSegment[] {
  return lines.filter(line => line.source.trim()).map((line, index) => ({
    id: `video-${index}`,
    timestamp: clock(line.start),
    startedAt: line.start,
    audioSource: 'video',
    rawText: line.source,
    cleanText: line.translation && line.translation !== line.source
      ? `Lời gốc: ${line.source}\nTiếng Việt: ${line.translation}`
      : `Lời gốc: ${line.source}`,
  }))
}

/** Keep follow-ups compact; the full script is sent separately on every question. */
export function watchChatHistory(messages: WatchChatTurn[]): WatchChatTurn[] {
  const history: WatchChatTurn[] = []
  let length = 0
  for (const message of messages.slice(-10).reverse()) {
    if (length + message.content.length > 20_000) break
    history.unshift(message)
    length += message.content.length
  }
  if (history[0]?.role === 'assistant') history.shift()
  return history
}
