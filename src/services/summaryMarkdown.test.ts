import { describe, expect, it } from 'vitest'
import { evidenceIds, hasEvidence, noteMarkdown, plainToMarkdown, structuredToMarkdown, withoutEvidence } from './summaryMarkdown'
import { buildReport } from './noteExport'
import { summaryText } from './notes'
import type { MeetingNote, StructuredMeetingSummary } from './types'

const summary: StructuredMeetingSummary = {
  tldr: 'Nhóm chốt lịch ra mắt.', keyPoints: [{ id: 'k', text: 'Doanh thu tăng 18%.', evidenceIds: ['s0', 's1'] }],
  decisions: [{ id: 'd', text: 'Ra mắt ngày 1/11.', evidenceIds: [] }], tentativeDecisions: [],
  unresolvedTopics: [{ id: 'u', text: 'Giá', topic: 'Giá gói Pro', options: ['99k', '149k'], status: 'No final decision', evidenceIds: [] }],
  actionItems: [{ id: 'a', owner: 'Lan', task: 'Làm bảng giá', deadline: 'thứ Sáu', evidenceIds: ['s2'] }], openQuestions: [], deferred: [],
}
const note = (extra: Partial<MeetingNote>): MeetingNote => ({ id: 'n', title: 'Họp', createdAt: '', updatedAt: '', duration: 0, summary: '', transcript: '', ...extra })

describe('summary markdown', () => {
  it('turns the AI summary into editable sections with timestamp links', () => {
    const markdown = structuredToMarkdown(summary, id => ({ s0: '09:01', s2: '09:09' })[id])
    expect(markdown).toBe([
      '## Tóm tắt nhanh', '', 'Nhóm chốt lịch ra mắt.', '',
      '## Ý chính', '', '- Doanh thu tăng 18%. [09:01 +1](#t=s0,s1)', '',
      '## Quyết định', '', '- Ra mắt ngày 1/11.', '',
      '## Vấn đề chưa chốt', '', '- **Giá gói Pro** · Lựa chọn: 99k, 149k', '',
      '## Việc cần làm', '', '- [ ] Lan → Làm bảng giá → thứ Sáu [09:09](#t=s2)',
    ].join('\n'))
    expect(evidenceIds('#t=s0,s1')).toEqual(['s0', 's1'])
    expect(evidenceIds('https://example.com')).toEqual([])
    expect(hasEvidence(markdown)).toBe(true)
    expect(withoutEvidence(markdown)).not.toContain('#t=')
    expect(withoutEvidence(markdown)).toContain('- Doanh thu tăng 18%.\n')
  })

  it('reads old plain-text summaries as markdown', () => {
    expect(plainToMarkdown('TÓM TẮT\n• Một ý.\n\nVIỆC CẦN LÀM\n• Lan gửi báo cáo.')).toBe('## Tóm tắt\n\n- Một ý.\n\n## Việc cần làm\n\n- Lan gửi báo cáo.')
  })

  it("prefers the user's own text once saved, for copying, chat and export", () => {
    const edited = note({ structuredSummary: summary, summaryMarkdown: '## Của tôi\n\n- Ý riêng [09:01](#t=s0)\n- [ ] Gọi đối tác' })
    expect(noteMarkdown(edited)).toBe(edited.summaryMarkdown)
    expect(summaryText(edited)).toBe('## Của tôi\n\n- Ý riêng\n- [ ] Gọi đối tác')
    expect(buildReport(edited).sections).toEqual([{ title: 'Của tôi', blocks: [{ kind: 'bullets', items: ['Ý riêng', '☐ Gọi đối tác'] }] }])
    // Not yet edited: the AI summary as before.
    expect(summaryText(note({ structuredSummary: summary }))).toContain('Ý CHÍNH')
  })
})
