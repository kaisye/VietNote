import type { TranscriptSegment } from './types'

/** A file second costs this share of a live (streaming) second. */
export const FILE_RATE = 0.75

/** Credit (in live seconds) a recording of this length costs. */
export const fileCost = (audioSeconds: number) => Math.ceil(audioSeconds * FILE_RATE)

/** [text, start_ms, end_ms, speaker, language, is_translation], as the `soniox-file` function sends tokens. */
export type FileToken = [string, number, number, string | null, string | null, 0 | 1]

export interface FileParagraph { entryIds: string[]; translatedText: string }

const SENTENCE_END = /[.!?。？！…]["”’)]?\s*$/
const MAX_GAP_MS = 1500
const MIN_WORDS_TO_SPLIT = 40

/**
 * Groups Soniox's word tokens into transcript lines: a new line on a speaker
 * change, a long pause, or a sentence end once a line is long. Translation
 * tokens follow the sentences they translate in small runs; runs belonging to
 * the same line join into one paragraph attached to the lines they translate.
 */
export function buildFileTranscript(tokens: FileToken[], startedAtMs: number): { segments: TranscriptSegment[]; paragraphs: FileParagraph[] } {
  const segments: TranscriptSegment[] = []
  const paragraphs: FileParagraph[] = []
  let current: { text: string; start: number; end: number; speaker: string | null } | null = null
  let run = new Set<string>()
  let translation = ''
  const close = () => {
    if (!current) return
    const text = current.text.trim()
    if (text) {
      const id = `file-${segments.length + 1}`
      const at = startedAtMs + current.start
      segments.push({ id, timestamp: new Date(at).toISOString(), startedAt: at / 1000, endedAt: (startedAtMs + current.end) / 1000, audioSource: 'file', rawText: text, cleanText: text, speaker: current.speaker ? `Người nói ${current.speaker}` : null, speakerProvisional: false })
    }
    current = null
  }
  const flushTranslation = () => {
    const text = translation.trim()
    const previous = paragraphs[paragraphs.length - 1]
    // Soniox translates a long line in several small runs: keep one paragraph per line.
    if (text && run.size && previous?.entryIds.at(-1) === [...run][0]) {
      previous.translatedText += ` ${text}`
      previous.entryIds = [...new Set([...previous.entryIds, ...run])]
    } else if (text && run.size) paragraphs.push({ entryIds: [...run], translatedText: text })
    translation = ''; run = new Set()
  }
  for (const [text, start, end, speaker, , isTranslation] of tokens) {
    if (isTranslation) { translation += text; continue }
    if (translation) flushTranslation()
    if (current) {
      const words = current.text.trim().split(/\s+/).length
      if (speaker !== current.speaker || start - current.end > MAX_GAP_MS || (words >= MIN_WORDS_TO_SPLIT && SENTENCE_END.test(current.text) && /^\s/.test(text))) close()
    }
    if (!current) current = { text: '', start, end, speaker }
    current.text += text
    current.end = Math.max(current.end, end)
    run.add(`file-${segments.length + 1}`)
  }
  close()
  flushTranslation()
  return { segments, paragraphs }
}

/** The note's plain-text transcript, laid out like a recorded meeting's. */
export function fileNoteTranscript(segments: TranscriptSegment[], paragraphs: FileParagraph[]): string {
  const time = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  const source = segments.map(segment => `${time(segment.timestamp)} · File ghi âm${segment.speaker ? ` · ${segment.speaker}` : ''}: ${segment.cleanText}`).join('\n')
  if (!paragraphs.length) return source
  return `${source}\n\nBẢN DỊCH TIẾNG VIỆT THEO ĐOẠN\n${paragraphs.map((paragraph, index) => `ĐOẠN ${index + 1}\n${paragraph.translatedText}`).join('\n\n')}`
}
