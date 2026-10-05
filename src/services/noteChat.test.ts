import { describe, expect, it, vi } from 'vitest'
import { appendNoteChat, askNoteQuestion, noteChatHistory } from './noteChat'
import { demoNote, emptyStructuredSummary } from './notes'
import type { NoteChatMessage } from './types'

const askNote = vi.hoisted(() => vi.fn().mockResolvedValue({ answer: 'Lan gửi báo cáo.', evidenceIds: [] }))
vi.mock('./desktop', () => ({ desktop: { askNote } }))
const message = (role: 'user' | 'assistant', content: string): NoteChatMessage => ({ id: crypto.randomUUID(), role, content, createdAt: '2026-10-04T00:00:00Z' })

describe('meeting chat context', () => {
  it('sends the full legacy transcript and recent conversation for follow-up questions', async () => {
    await askNoteQuestion({ ...demoNote, chatMessages: [message('user', 'Ai gửi báo cáo?'), message('assistant', 'Lan.')] }, '  Khi nào?  ')
    expect(askNote).toHaveBeenLastCalledWith(expect.objectContaining({
      title: demoNote.title, summary: demoNote.summary, transcript: demoNote.transcript,
      question: 'Khi nào?', history: [{ role: 'user', content: 'Ai gửi báo cáo?' }, { role: 'assistant', content: 'Lan.' }],
    }), undefined)
  })
  it('uses structured summaries and all source segments without duplicating the transcript', async () => {
    const segments = [{ id: 'original', timestamp: '09:00', startedAt: 0, audioSource: 'microphone', rawText: 'Lan gửi', cleanText: 'Lan gửi báo cáo.' }]
    await askNoteQuestion({ ...demoNote, structuredSummary: { ...emptyStructuredSummary(), tldr: 'Bản tóm tắt mới' }, transcriptSegments: segments }, 'Ai gửi?')
    expect(askNote).toHaveBeenLastCalledWith(expect.objectContaining({ summary: 'TÓM TẮT NHANH\nBản tóm tắt mới', transcript: '', segments }), undefined)
  })
  it('keeps history within the character budget while starting on a user turn', () => {
    const turns = Array.from({ length: 20 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `${index}:` + 'x'.repeat(3000)))
    const history = noteChatHistory(turns)
    expect(history.length).toBeLessThanOrEqual(10)
    expect(history.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(20_000)
    expect(history[0].role).toBe('user')
    expect(history.at(-1)?.content).toBe(turns.at(-1)?.content)
    expect(history.every(turn => !('id' in turn))).toBe(true)
  })
  it('does not send an orphaned reply or history from another note', async () => {
    expect(noteChatHistory([message('assistant', 'Một câu trả lời cũ')])).toEqual([])
    await askNoteQuestion({ ...demoNote, chatMessages: undefined }, 'Câu hỏi mới')
    expect(askNote).toHaveBeenLastCalledWith(expect.objectContaining({ history: [] }), undefined)
  })
})

describe('streaming progress callbacks', () => {
  it('passes progressive answers through before the final result resolves', async () => {
    let finish!: (answer: { answer: string; evidenceIds: string[] }) => void
    askNote.mockImplementationOnce((_request, progress) => {
      progress({ answer: 'Đang viết', evidenceIds: [], incomplete: true })
      return new Promise(resolve => { finish = resolve })
    })
    const progress = vi.fn()
    const final = askNoteQuestion(demoNote, 'Tóm tắt', progress)
    expect(progress).toHaveBeenCalledWith({ answer: 'Đang viết', evidenceIds: [], incomplete: true })
    finish({ answer: 'Hoàn tất', evidenceIds: [] })
    await expect(final).resolves.toEqual({ answer: 'Hoàn tất', evidenceIds: [] })
  })
})

describe('late meeting chat replies' , () => {
  const source = { ...demoNote, id: 'meeting-a', isDemo: false }
  const reply = message('assistant', 'Lan gửi báo cáo.')
  it('preserves renamed or moved notes and leaves other meetings untouched', () => {
    const other = { ...source, id: 'meeting-b' }
    const current = { ...source, title: 'Tên mới', groupID: 'new-group' }
    const [updated, unchanged] = appendNoteChat([current, other], source, [reply])
    expect(updated).toMatchObject({ title: 'Tên mới', groupID: 'new-group', chatMessages: [reply], updatedAt: source.updatedAt })
    expect(unchanged).toBe(other)
    expect(source.chatMessages).toBeUndefined()
  })
  it('never recreates a deleted meeting', () => {
    const notes = [{ ...source, id: 'meeting-b' }]
    expect(appendNoteChat(notes, source, [reply])).toBe(notes)
  })
  it('rejects a stale reply when the note content was edited during a request', () => {
    expect(() => appendNoteChat([{ ...source, summary: 'Nội dung mới' }], source, [reply])).toThrow('Nội dung ghi chú đã thay đổi')
    expect(() => appendNoteChat([{ ...source, transcript: 'Transcript mới' }], source, [reply])).toThrow()
  })
})
