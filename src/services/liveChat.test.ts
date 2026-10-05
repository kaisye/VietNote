import { describe, expect, it, vi } from 'vitest'
import { askLiveQuestion, liveSegments } from './liveChat'
import { noteChatHistory } from './noteChat'
import type { Subtitle } from './types'

const askNote = vi.hoisted(() => vi.fn().mockResolvedValue({ answer: 'Ý là tính phí theo mức dùng.', evidenceIds: [] }))
vi.mock('./desktop', () => ({ desktop: { askNote } }))

const start = Date.parse('2026-10-05T09:00:00Z')
// One utterance every 10 seconds.
const entries: Subtitle[] = Array.from({ length: 120 }, (_, index) => ({
  id: `e${index}`, timestamp: new Date(start + index * 10_000).toISOString(), sourceText: `Câu ${index}`,
  audioSource: 'system', translatedText: '', startedAt: index * 10, generation: 1,
}))

describe('live Q&A context', () => {
  it('sends the last five minutes plus the lines around a quoted passage', () => {
    const ids = liveSegments(entries, ['e10']).map(segment => segment.id)
    expect(ids.slice(0, 9)).toEqual(['e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13', 'e14'])
    expect(ids.slice(9)).toEqual(entries.slice(89).map(entry => entry.id))
  })
  it('keeps a minimum of recent lines after a long pause', () => {
    const sparse = entries.slice(0, 30).map((entry, index) => ({ ...entry, timestamp: new Date(start + index * 600_000).toISOString() }))
    expect(liveSegments(sparse)).toHaveLength(20)
    expect(liveSegments([])).toEqual([])
  })
  it('asks in live mode with the quote, and replays quotes in follow-up history', async () => {
    const history = [
      { id: '1', role: 'user' as const, content: 'Giải thích', quote: 'usage-based', createdAt: '' },
      { id: '2', role: 'assistant' as const, content: 'Tính theo mức dùng.', createdAt: '' },
    ]
    await askLiveQuestion({ title: 'Họp', summary: 'Tóm tắt', entries: entries.slice(0, 3) }, history, { question: ' Ví dụ? ', quote: ' usage-based ', focusIds: ['e1'] })
    expect(askNote).toHaveBeenLastCalledWith(expect.objectContaining({
      live: true, quote: 'usage-based', question: 'Ví dụ?', transcript: '', summary: 'Tóm tắt',
      history: [{ role: 'user', content: 'Đoạn trích: "usage-based"\nGiải thích' }, { role: 'assistant', content: 'Tính theo mức dùng.' }],
    }), undefined)
    expect(askNote.mock.lastCall![0].segments.map((segment: { id: string }) => segment.id)).toEqual(['e0', 'e1', 'e2'])
    expect(noteChatHistory([history[1]])).toEqual([])
  })
})
