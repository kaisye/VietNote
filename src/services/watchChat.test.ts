import { describe, expect, it } from 'vitest'
import { watchChatHistory, watchChatSegments } from './watchChat'

describe('watch chat context', () => {
  it('keeps original speech and any available translation with seekable times', () => {
    expect(watchChatSegments([
      { start: 65, end: 68, source: 'Hello', translation: 'Xin chào' },
      { start: 72, end: 75, source: 'What next?' },
    ])).toMatchObject([
      { id: 'video-0', timestamp: '1:05', startedAt: 65, cleanText: 'Lời gốc: Hello\nTiếng Việt: Xin chào' },
      { id: 'video-1', timestamp: '1:12', startedAt: 72, cleanText: 'Lời gốc: What next?' },
    ])
  })
  it('starts follow-up history with a user turn', () => {
    expect(watchChatHistory([{ role: 'assistant', content: 'old' }, { role: 'user', content: 'question' }])).toEqual([{ role: 'user', content: 'question' }])
  })
})
