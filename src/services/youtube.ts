import type { FileToken } from './fileTranscript'

/** A piece of a video's captions: a line, or a single word for recognised speech. Times are seconds into the video. */
export interface CaptionPiece { start: number; end: number; text: string }
/** "heard": the words were transcribed from the video's audio rather than taken from its captions. */
export type CaptionKind = 'manual' | 'auto' | 'none' | 'heard'
export interface VideoCaptions { videoId: string; title: string; duration: number | null; language: string; kind: CaptionKind; pieces: CaptionPiece[] }
/** One subtitle as shown; `translation` is unset until its batch is translated. */
export interface WatchLine { start: number; end: number; source: string; translation?: string }
/** Lines translated together. Recognised speech keeps its words, which the translation splits into subtitles. */
export interface Batch { start: number; draft: WatchLine[]; words?: CaptionPiece[] }
/** A subtitle the translation made from recognised words, starting at word `from`. */
export interface SpeechLine { from: number; source: string; translation: string }

/** The page that hosts the YouTube player; YouTube refuses to play inside the app's own pages. */
export const PLAYER_URL = import.meta.env.VITE_PLAYER_URL ?? (import.meta.env.DEV ? '/youtube-player.html' : 'https://web.vietnote-app.workers.dev/youtube-player')
/** Lines made by people translated together. */
export const BATCH = 20
/** Recognised words translated together; the first batch is smaller, so subtitles are ready sooner. */
const WORDS = 110
const FIRST_WORDS = 50
/** Subtitles show this much before their words are heard, so reading starts with the voice. */
export const LEAD = 0.2
/** A subtitle stays this long after its last word unless the next one starts. */
const HOLD = 1.5

const YOUTUBE_ID = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([\w-]{11})(?![\w-])/i
export const youtubeId = (url: string) => YOUTUBE_ID.exec(url.trim())?.[1] ?? null

/** Chinese and Japanese are written without spaces between words. */
const UNSPACED = /[぀-ヿ㐀-鿿豈-﫿＀-￯]/
const join = (text: string, next: string) => !text ? next : UNSPACED.test(text.at(-1)!) && UNSPACED.test(next[0]) ? text + next : `${text} ${next}`
const ENDS_SENTENCE = /[.?!…。？！]["'”’)\]]*$/
const NOISE = /^[[(][^\])]*[\])]$/

/**
 * Groups caption pieces into subtitles of about a sentence: short enough to read at a glance,
 * whole enough to translate well. Recognised speech has no punctuation, so pauses split it.
 */
export function captionLines(pieces: CaptionPiece[], kind: CaptionKind): WatchLine[] {
  const auto = kind !== 'manual'
  const maxSeconds = auto ? 6 : 8
  const maxChars = auto ? 90 : 150
  const pause = auto ? 0.8 : 1.6
  const lines: WatchLine[] = []
  let line: WatchLine | null = null
  const close = () => { if (line) lines.push(line); line = null }
  for (const piece of pieces) {
    const noise = NOISE.test(piece.text)
    if (line && (noise || NOISE.test(line.source) || piece.start - line.end >= pause || piece.end - line.start > maxSeconds || line.source.length + piece.text.length > maxChars)) close()
    if (line) { line.source = join(line.source, piece.text); line.end = Math.max(line.end, piece.end) }
    else line = { start: piece.start, end: piece.end, source: piece.text }
    if (!auto && ENDS_SENTENCE.test(piece.text)) close()
  }
  close()
  return lines
}

/**
 * Splits recognised words into batches of about `WORDS`, each cut at the longest pause near its
 * end, so a sentence is rarely split between two batches.
 */
export function wordRanges(words: CaptionPiece[]): [number, number][] {
  const ranges: [number, number][] = []
  for (let from = 0; from < words.length;) {
    const size = ranges.length ? WORDS : FIRST_WORDS
    if (words.length - from <= size * 1.4) { ranges.push([from, words.length]); break }
    let cut = from + size
    for (let index = from + Math.round(size * 0.7); index <= from + Math.round(size * 1.3); index++) {
      if (words[index].start - words[index - 1].end > words[cut].start - words[cut - 1].end) cut = index
    }
    ranges.push([from, cut]); from = cut
  }
  return ranges
}

/** The batches to translate. Vietnamese captions need none, so they come translated. */
export function planBatches({ pieces, kind, language }: Pick<VideoCaptions, 'pieces' | 'kind' | 'language'>): Batch[] {
  const vietnamese = language === 'vi'
  const shown = (lines: WatchLine[]) => vietnamese ? lines.map(line => ({ ...line, translation: line.source })) : lines
  if (kind === 'manual') {
    const lines = shown(captionLines(pieces, 'manual'))
    return Array.from({ length: Math.ceil(lines.length / BATCH) }, (_, index) => { const draft = lines.slice(index * BATCH, (index + 1) * BATCH); return { start: draft[0].start, draft } })
  }
  return wordRanges(pieces).map(([from, to]) => {
    const words = pieces.slice(from, to)
    return { start: words[0].start, draft: shown(captionLines(words, 'auto')), words: vietnamese ? undefined : words }
  })
}

/** Times the subtitles a translation made from a batch's words. */
export function speechLines(words: CaptionPiece[], lines: SpeechLine[]): WatchLine[] {
  return lines.map((line, index) => {
    const to = Math.min(lines[index + 1]?.from ?? words.length, words.length)
    const own = words.slice(line.from, to)
    return { start: own[0].start, end: own[own.length - 1].end, source: line.source || own.map(word => word.text).join(' '), translation: line.translation }
  }).filter(line => Number.isFinite(line.start))
}

/** The batch being watched at `time`. */
export const batchAt = (batches: Batch[], time: number) => { let found = 0; batches.forEach((batch, index) => { if (batch.start <= time + LEAD) found = index }); return found }

/**
 * Words with their times from a transcription of the audio, whose tokens are often parts of
 * words; a token starting with a space starts a new word. Also the language most of them are in.
 */
export function heardWords(tokens: FileToken[]): { pieces: CaptionPiece[]; language: string } {
  const pieces: CaptionPiece[] = []
  const languages = new Map<string, number>()
  for (const [text, start, end, , language, isTranslation] of tokens) {
    if (isTranslation || !text.trim()) continue
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1)
    const last = pieces.at(-1)
    if (last && !/^\s/.test(text) && start / 1000 - last.end < 0.15) { last.text += text; last.end = Math.max(last.end, end / 1000) }
    else pieces.push({ start: start / 1000, end: end / 1000, text: text.trim() })
  }
  const language = [...languages].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'en'
  return { pieces, language }
}

/** The subtitle on screen at `time`, or -1 between subtitles. */
export function lineAt(lines: WatchLine[], time: number) {
  const at = time + LEAD
  let low = 0, high = lines.length - 1, found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (lines[middle].start <= at) { found = middle; low = middle + 1 } else high = middle - 1
  }
  return found >= 0 && at < lines[found].end + HOLD ? found : -1
}

/** The latest subtitle that has started by `time`, for following along in the list. */
export function lineBefore(lines: WatchLine[], time: number) {
  let found = -1
  for (let low = 0, high = lines.length - 1; low <= high;) {
    const middle = (low + high) >> 1
    if (lines[middle].start <= time + LEAD) { found = middle; low = middle + 1 } else high = middle - 1
  }
  return found
}

/** Batches in the order to translate them: from the one being watched to the end, then the earlier ones. */
export function batchOrder(total: number, current: number) {
  const from = Math.min(Math.max(current, 0), Math.max(total - 1, 0))
  return [...Array.from({ length: total - from }, (_, index) => from + index), ...Array.from({ length: from }, (_, index) => from - 1 - index)]
}

export const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds)); const h = Math.floor(total / 3600); const m = Math.floor(total % 3600 / 60); const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** The fastest a dubbed line is read, so it ends before the next one starts. */
export const MAX_DUB_RATE = 1.6
/** How fast to read `seconds` of voice into a `slot` of video: normal pace when it fits. */
export const dubRate = (seconds: number, slot: number) => Math.min(MAX_DUB_RATE, Math.max(1, seconds / Math.max(slot - 0.15, 0.5)))
/** Lines worth reading aloud: translated words, not sound labels like [Nhạc]. */
export const dubbable = (line: WatchLine) => Boolean(line.translation?.trim()) && !NOISE.test(line.translation!.trim()) && !NOISE.test(line.source.trim())
