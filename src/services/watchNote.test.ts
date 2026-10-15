import { describe, expect, it } from 'vitest'
import { buildWatchNote, watchedVideoSegments } from './watchNote'
import { emptyStructuredSummary } from './notes'

describe('saved video note', () => {
  const watched = [
    { start: 12, end: 16, source: 'This is the first point.', translation: 'Đây là ý đầu tiên.' },
    { start: 90, end: 94, source: 'The second point.', translation: 'Ý thứ hai.' },
  ]

  it('keeps the watched video timestamps and both subtitle languages', () => {
    const segments = watchedVideoSegments(watched)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ timestamp: '0:12', rawText: 'This is the first point.', cleanText: 'Đây là ý đầu tiên.', audioSource: 'video' })
    expect(segments[1].startedAt).toBe(90)
  })

  it('saves the summary, source link and watched scripts as one note', () => {
    const summary = { ...emptyStructuredSummary(), tldr: 'Hai ý chính.' }
    const note = buildWatchNote({ title: 'My video', url: 'https://youtube.com/watch?v=abcdefghijk' }, watched, summary)
    expect(note.source).toBe('link')
    expect(note.summary).toContain('Hai ý chính.')
    expect(note.transcript).toContain('Nguồn: https://youtube.com/watch?v=abcdefghijk')
    expect(note.transcript).toContain('Gốc: This is the first point.')
    expect(note.transcriptSegments).toHaveLength(2)
    expect(note.duration).toBe(8)
  })

  it('creates an immediate pending note before the background summary is ready', () => {
    const note = buildWatchNote({ title: 'My video', url: 'https://youtube.com/watch?v=abcdefghijk' }, watched)
    expect(note.saving).toBe(true)
    expect(note.structuredSummary).toBeUndefined()
    expect(note.summary).toContain('Đang tạo tóm tắt')
    expect(note.transcriptSegments).toHaveLength(2)
  })
})
