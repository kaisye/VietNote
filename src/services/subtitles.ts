import type { MeetingNote, TranscriptSegment } from './types'

/** Original speech, the Vietnamese translation, or both lines in one cue. */
export type SubtitleMode = 'source' | 'vi' | 'bilingual'

export const subtitleModes: { mode: SubtitleMode; label: string; hint: string; suffix: string }[] = [
  { mode: 'source', label: 'Phụ đề tiếng gốc', hint: 'Lời nói như trong bản ghi', suffix: 'goc' },
  { mode: 'vi', label: 'Phụ đề tiếng Việt', hint: 'Bản dịch, đúng thời điểm nói', suffix: 'tieng-viet' },
  { mode: 'bilingual', label: 'Phụ đề song ngữ', hint: 'Dòng gốc trên, tiếng Việt dưới', suffix: 'song-ngu' },
]

/** A cue longer than this is split, so it fits two lines on screen. */
const MAX_CHARS = 84
const MAX_SECONDS = 7
const MIN_SECONDS = 0.8
const SENTENCE = /(?<=[.!?。？！…])\s+/

/** The note has timed lines; a translated subtitle also needs the translation tied to them. */
export const canExportSubtitles = (note: MeetingNote) => Boolean(note.transcriptSegments?.length)
export const hasTimedTranslation = (note: MeetingNote) => Boolean(note.translations?.some(item => item.text.trim()))

/** Splits text into `parts` pieces of similar length, on word boundaries. */
export function splitEvenly(text: string, parts: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (parts <= 1 || words.length <= 1) return [words.join(' ')]
  const total = words.join(' ').length
  const pieces: string[] = []
  let current: string[] = []
  for (const word of words) {
    current.push(word)
    const done = pieces.reduce((sum, piece) => sum + piece.length + 1, 0) + current.join(' ').length
    // Break once the word's middle passes this piece's share.
    if (pieces.length < parts - 1 && done + (word.length + 1) / 2 >= total * (pieces.length + 1) / parts) { pieces.push(current.join(' ')); current = [] }
  }
  if (current.length) pieces.push(current.join(' '))
  return pieces
}

/**
 * Each line's share of the translation. A translation covering several lines is split by
 * sentence and handed out in proportion to how much each line says.
 */
export function translationByLine(note: MeetingNote): Map<string, string> {
  const lines = new Map((note.transcriptSegments ?? []).map(segment => [segment.id, segment]))
  const result = new Map<string, string>()
  for (const block of note.translations ?? []) {
    const ids = block.entryIds.filter(id => lines.has(id))
    const text = block.text.trim()
    if (!ids.length || !text) continue
    if (ids.length === 1) { result.set(ids[0], [result.get(ids[0]), text].filter(Boolean).join(' ')); continue }
    const weights = ids.map(id => Math.max(1, lines.get(id)!.cleanText.length))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let sentences = text.split(SENTENCE).filter(Boolean)
    // Fewer sentences than lines: share out words instead.
    if (sentences.length < ids.length) sentences = splitEvenly(text, ids.length)
    const length = sentences.reduce((sum, sentence) => sum + sentence.length, 0)
    let index = 0, said = 0, given = 0
    ids.forEach((id, line) => {
      said += weights[line]
      const share: string[] = []
      // Every line up to the last takes sentences until it holds its share of the text.
      while (index < sentences.length && (line === ids.length - 1 || given + sentences[index].length / 2 <= length * said / total)) {
        given += sentences[index].length
        share.push(sentences[index++])
      }
      if (share.length) result.set(id, [result.get(id), share.join(' ')].filter(Boolean).join(' '))
    })
  }
  return result
}

const stamp = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

/** The note's lines as an .srt file, timed from the start of the recording. */
export function noteSrt(note: MeetingNote, mode: SubtitleMode): string {
  const segments: TranscriptSegment[] = [...(note.transcriptSegments ?? [])].sort((a, b) => a.startedAt - b.startedAt)
  if (!segments.length) return ''
  const created = Date.parse(note.createdAt) / 1000
  const origin = Number.isFinite(created) ? Math.min(created, segments[0].startedAt) : segments[0].startedAt
  const translated = translationByLine(note)
  const cues: { start: number; end: number; text: string }[] = []
  segments.forEach((segment, index) => {
    const source = segment.cleanText.trim()
    const vietnamese = translated.get(segment.id)?.trim() ?? ''
    // Vietnamese speech has no translation: it is its own Vietnamese line.
    const lines = mode === 'source' ? [source] : mode === 'vi' ? [vietnamese || source] : vietnamese && vietnamese !== source ? [source, vietnamese] : [source]
    if (!lines[0]) return
    const start = segment.startedAt - origin
    const next = segments[index + 1]?.startedAt
    const spoken = segment.endedAt && segment.endedAt > segment.startedAt ? segment.endedAt : segment.startedAt + Math.max(1.5, source.split(/\s+/).length * 0.4)
    const end = Math.max(start + MIN_SECONDS, Math.min(spoken, next ?? spoken) - origin)
    const parts = Math.max(1, Math.ceil(Math.max(...lines.map(line => line.length)) / MAX_CHARS), Math.ceil((end - start) / MAX_SECONDS))
    const split = lines.map(line => splitEvenly(line, parts))
    const count = Math.min(...split.map(pieces => pieces.length))
    const pieces = split.map(line => line.length > count ? [...line.slice(0, count - 1), line.slice(count - 1).join(' ')] : line)
    // Time follows the first line's length.
    const weights = pieces[0].map(piece => Math.max(1, piece.length))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let at = start
    for (let part = 0; part < count; part++) {
      const until = part === count - 1 ? end : at + (end - start) * weights[part] / total
      cues.push({ start: at, end: until, text: pieces.map(line => line[part]).join('\n') })
      at = until
    }
  })
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n')
}

export const subtitleFileName = (note: MeetingNote, mode: SubtitleMode) => {
  const title = note.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'VietNote'
  return `${title} - ${subtitleModes.find(item => item.mode === mode)!.suffix}.srt`
}
