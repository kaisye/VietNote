import { describe, expect, it } from 'vitest'
import { formatStructuredSummary, noteMoments } from './notes'

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
