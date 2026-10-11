import { describe, expect, it } from 'vitest'
import { noteSrt, splitEvenly, translationByLine } from './subtitles'
import { timedTranslations } from './notes'
import type { MeetingNote, TranscriptSegment } from './types'

const start = Date.parse('2026-10-11T09:00:00Z') / 1000
const line = (id: string, at: number, end: number, text: string): TranscriptSegment =>
  ({ id, timestamp: new Date((start + at) * 1000).toISOString(), startedAt: start + at, endedAt: start + end, audioSource: 'file', rawText: text, cleanText: text })
const note = (segments: TranscriptSegment[], translations: MeetingNote['translations'] = []): MeetingNote =>
  ({ id: 'n', title: 'Họp: kế hoạch Q4', createdAt: new Date(start * 1000).toISOString(), updatedAt: '', duration: 60, summary: '', transcript: '', transcriptSegments: segments, translations })

describe('subtitles', () => {
  it('times cues from the start of the recording', () => {
    const srt = noteSrt(note([line('a', 1.5, 3.25, 'Hello everyone.'), line('b', 4, 6, 'Let us begin.')]), 'source')
    expect(srt).toBe('1\n00:00:01,500 --> 00:00:03,250\nHello everyone.\n\n2\n00:00:04,000 --> 00:00:06,000\nLet us begin.\n')
  })

  it('puts the translation under the original in bilingual cues', () => {
    const value = note([line('a', 0, 2, 'Hello everyone.')], [{ entryIds: ['a'], text: 'Chào mọi người.' }])
    expect(noteSrt(value, 'bilingual')).toContain('Hello everyone.\nChào mọi người.')
    expect(noteSrt(value, 'vi')).toContain('00:00:00,000 --> 00:00:02,000\nChào mọi người.')
  })

  it('shares a paragraph translation among the lines it covers', () => {
    const value = note([line('a', 0, 2, 'First point here.'), line('b', 2, 4, 'Second point there.')], [{ entryIds: ['a', 'b'], text: 'Ý thứ nhất. Ý thứ hai.' }])
    expect([...translationByLine(value)]).toEqual([['a', 'Ý thứ nhất.'], ['b', 'Ý thứ hai.']])
  })

  it('splits a long line into cues that follow each other', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const cues = noteSrt(note([line('a', 0, 20, words)]), 'source').trim().split('\n\n')
    expect(cues.length).toBeGreaterThan(2)
    expect(cues.at(-1)).toContain('--> 00:00:20,000')
    expect(cues.map(cue => cue.split('\n')[2]).join(' ')).toBe(words)
  })

  it('splits text evenly on words', () => {
    expect(splitEvenly('a b c d', 2)).toEqual(['a b', 'c d'])
    expect(splitEvenly('one', 3)).toEqual(['one'])
  })

  it('prefers a line\'s own live translation over the paragraph covering it', () => {
    const saved = timedTranslations(new Map([['a', 'Chào.']]), [{ entryIds: ['a', 'b'], text: 'Chào. Bắt đầu.' }, { entryIds: ['c'], text: 'Hết.' }])
    expect(saved).toEqual([{ entryIds: ['a'], text: 'Chào.' }, { entryIds: ['c'], text: 'Hết.' }])
  })
})
