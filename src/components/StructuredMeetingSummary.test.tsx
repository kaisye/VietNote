import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StructuredMeetingSummaryView, structuredSummaryHasEvidence } from './StructuredMeetingSummary'
import type { StructuredMeetingSummary } from '../services/types'

const summary: StructuredMeetingSummary = {
  tldr: 'Nhóm đã thống nhất phạm vi phát hành.',
  keyPoints: [{ id: 'key', text: 'Ưu tiên trải nghiệm ghi chú.', evidenceIds: ['segment-1'] }],
  decisions: [{ id: 'decision', text: 'Phát hành vào thứ Sáu.', evidenceIds: [] }],
  tentativeDecisions: [], unresolvedTopics: [],
  actionItems: [{ id: 'action', owner: 'Lan', task: 'Chuẩn bị bản phát hành', deadline: 'thứ Sáu', evidenceIds: [] }],
  openQuestions: [], deferred: [],
}

describe('structured meeting summary editing', () => {
  it('offers inline editing per visible section without adding a separate evidence row', () => {
    const html = renderToStaticMarkup(<StructuredMeetingSummaryView summary={summary} editable onChange={() => {}} onEvidence={() => {}}/>)
    expect(html).toContain('aria-label="Chỉnh sửa tóm tắt nhanh"')
    expect(html).toContain('aria-label="Chỉnh sửa ý chính"')
    expect(html).toContain('aria-label="Chỉnh sửa quyết định"')
    expect(html).toContain('aria-label="Chỉnh sửa việc cần làm"')
    expect(html).not.toContain('Hiện mốc thời gian')
  })

  it('reports whether the summary has transcript evidence for the toolbar control', () => {
    expect(structuredSummaryHasEvidence(summary)).toBe(true)
    expect(structuredSummaryHasEvidence({ ...summary, keyPoints: [{ ...summary.keyPoints[0], evidenceIds: [] }] })).toBe(false)
  })
})
