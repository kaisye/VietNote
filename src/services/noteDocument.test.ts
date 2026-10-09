import { describe, expect, it } from 'vitest'
import { documentTitle, transcriptLines } from './noteDocument'
import { demoNote } from './notes'

describe('note documents', () => {
  it('times transcript lines from the start of the recording', () => {
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 9, 2, 0, seconds)).toISOString()
    const segment = (id: string, seconds: number, text: string, speaker: string | null = null) => ({ id, timestamp: at(seconds), startedAt: seconds, audioSource: 'file', rawText: text, cleanText: text, speaker })
    expect(transcriptLines({ ...demoNote, transcriptSegments: [segment('a', 0, 'Xin chào', 'Người nói 1'), segment('b', 3725, ' Kết thúc '), segment('c', 3726, ' ')] }))
      .toEqual(['[0:00:00] Người nói 1: Xin chào', '[1:02:05] Kết thúc'])
    expect(transcriptLines(demoNote)).toHaveLength(6)
  })

  it('titles a document by its heading, else the note', () => {
    const document = { id: 'd', kind: 'post' as const, length: 'short' as const, createdAt: '', updatedAt: '' }
    expect(documentTitle({ ...document, markdown: 'Intro\n# **Tương lai AI**\n' }, 'Ghi chú')).toBe('Tương lai AI')
    expect(documentTitle({ ...document, markdown: 'Chỉ có hook' }, 'Ghi chú')).toBe('Ghi chú')
  })
})
