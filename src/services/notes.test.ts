import { describe, expect, it } from 'vitest'
import { dayKey, dayLabel, formatStructuredSummary, hasDateTitle, isShortNote, noteContentText, noteMatches, noteMoments, noteSource, noteTranscriptText } from './notes'
import type { MeetingNote } from './types'

describe('noteMoments', () => {
  it('maps legacy staged summaries into structured moments', () => {
    const moments = noteMoments('ĐOẠN 1 · 00:14 · TỰ ĐỘNG\nTÓM TẮT\n- Chốt phạm vi.\nQUYẾT ĐỊNH\n- Dùng microphone.\nVIỆC CẦN LÀM\n- Lan gửi tài liệu.\n\nĐOẠN 2 · 00:16 · THỦ CÔNG\nTÓM TẮT\n- Kiểm tra lại.')
    expect(moments).toHaveLength(2)
    expect(moments[0]).toMatchObject({ overview: ['Chốt phạm vi.'], decisions: ['Dùng microphone.'], actions: ['Lan gửi tài liệu.'] })
    expect(moments[1].overview).toEqual(['Kiểm tra lại.'])
  })

  it('does not expose empty decision and action placeholders', () => {
    const [moment] = noteMoments('TÓM TẮT\n- Nội dung mới.\nQUYẾT ĐỊNH\n- Chưa có.\nVIỆC CẦN LÀM\n- Chưa có')
    expect(moment.decisions).toEqual([])
    expect(moment.actions).toEqual([])
  })

  it('parses the saved meeting overview without showing its section heading as content', () => {
    const [moment] = noteMoments('ĐOẠN 1 · TỔNG QUAN CUỘC HỌP\nTÓM TẮT TỔNG QUAN\n- Cuộc họp rà soát kế hoạch phát hành.\nQUYẾT ĐỊNH\n- Phát hành vào thứ Ba.')
    expect(moment.title).toBe('ĐOẠN 1 · TỔNG QUAN CUỘC HỌP')
    expect(moment.overview).toEqual(['Cuộc họp rà soát kế hoạch phát hành.'])
    expect(moment.decisions).toEqual(['Phát hành vào thứ Ba.'])
  })

  it('formats only populated structured sections without inventing missing fields', () => {
    const text = formatStructuredSummary({
      tldr: 'Chốt backend; vector database chưa chốt.',
      keyPoints: [],
      decisions: [{ id: 'd1', text: 'Dùng FastAPI.', evidenceIds: ['s1'] }],
      tentativeDecisions: [],
      unresolvedTopics: [{ id: 'u1', text: 'Vector database', topic: 'Vector Database Selection', options: ['Qdrant', 'Chroma'], status: 'No final decision', evidenceIds: ['s2'] }],
      actionItems: [{ id: 'a1', owner: 'Minh', task: 'Test Qdrant và Chroma', deadline: null, evidenceIds: ['s3'] }],
      openQuestions: [],
      deferred: [],
    })
    expect(text).toContain('QUYẾT ĐỊNH\n• Dùng FastAPI.')
    expect(text).toContain('Qdrant, Chroma · Chưa có quyết định cuối cùng')
    expect(text).toContain('Minh → Test Qdrant và Chroma')
    expect(text).not.toContain('QUYẾT ĐỊNH TẠM THỜI')
    expect(text).not.toContain('undefined')
  })
})

describe('note copy text', () => {
  const note: MeetingNote = { id: 'n', title: 'Họp sản phẩm', createdAt: '2026-09-30T03:43:00Z', updatedAt: '2026-09-30T03:43:00Z', duration: 0, summary: 'Nội dung cũ', transcript: 'a b',
    transcriptSegments: [{ id: 's1', timestamp: '2026-09-30T03:43:00Z', startedAt: 0, audioSource: 'system', rawText: 'Hello', cleanText: 'Hello', speaker: 'Người nói 1' }, { id: 's2', timestamp: '2026-09-30T03:44:00Z', startedAt: 1, audioSource: 'system', rawText: 'Hi', cleanText: 'Hi' }] }

  it('copies title, time and body', () => {
    const text = noteContentText(note)
    expect(text.startsWith('Họp sản phẩm\n\n')).toBe(true)
    expect(text.endsWith('\n\nNội dung cũ')).toBe(true)
  })

  it('copies one transcript line per segment with its speaker', () => {
    const lines = noteTranscriptText(note).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[.+\] Người nói 1: Hello$/)
    expect(lines[1]).toMatch(/^\[.+\] Hi$/)
    expect(noteTranscriptText({ ...note, transcriptSegments: [] })).toBe('a b')
  })
})

describe('finding notes', () => {
  const note = (patch: Partial<MeetingNote>): MeetingNote => ({ id: 'n', title: '', createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', duration: 0, summary: '', transcript: '', ...patch })

  it('matches words without Vietnamese marks, in any order', () => {
    const item = note({ title: 'Đánh giá năng lượng', summary: 'Cuộc họp về điện Mỹ' })
    expect(noteMatches(item, 'dien danh gia')).toBe(true)
    expect(noteMatches(item, 'Điện')).toBe(true)
    expect(noteMatches(item, 'gió')).toBe(false)
  })

  it('tells where a note came from', () => {
    expect(noteSource(note({ transcript: 'Nguồn: https://youtu.be/x\n\nhello' }))).toBe('link')
    expect(noteSource(note({ title: 'Phiên dịch · 10:00 10/10/26', transcript: 'hi' }))).toBe('translate')
    expect(noteSource(note({ transcript: 'hi' }))).toBe('meeting')
    expect(noteSource(note({}))).toBe('manual')
    expect(noteSource(note({ source: 'file' }))).toBe('file')
  })

  it('spots names made from the date alone', () => {
    expect(hasDateTitle(note({ title: 'Cuộc họp · 22:47 10/10/26' }))).toBe(true)
    expect(hasDateTitle(note({ title: 'Phiên dịch · 22:47, 10/10/2026' }))).toBe(true)
    expect(hasDateTitle(note({ title: 'Cuộc họp · chốt ngân sách' }))).toBe(false)
  })

  it('offers only untouched notes with little in them for clean-up', () => {
    const long = 'word '.repeat(100)
    expect(isShortNote(note({ duration: 50, transcript: long }))).toBe(true)
    expect(isShortNote(note({ duration: 900, transcript: 'Alo alo' }))).toBe(true)
    expect(isShortNote(note({ duration: 900, transcript: long }))).toBe(false)
    expect(isShortNote(note({ duration: 50, transcript: 'hi', titleEdited: true }))).toBe(false)
    expect(isShortNote(note({ duration: 50, transcript: 'hi', groupID: 'g' }))).toBe(false)
    expect(isShortNote(note({ duration: 50, transcript: 'hi', chatMessages: [{ id: 'c', role: 'user', content: 'q', createdAt: '' }] }))).toBe(false)
    expect(isShortNote(note({ summary: '' }))).toBe(true)
    expect(isShortNote(note({ summary: 'Gửi báo giá cho khách trước thứ Sáu' }))).toBe(false)
  })

  it('labels days', () => {
    const today = new Date(2026, 9, 11, 9)
    expect(dayLabel('2026-10-11', today)).toBe('Hôm nay')
    expect(dayLabel('2026-10-10', today)).toBe('Hôm qua')
    expect(dayLabel('2026-10-09', today)).toBe('Thứ Sáu, 9/10')
    expect(dayLabel('2025-10-09', today)).toMatch(/9\/10\/2025$/)
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
