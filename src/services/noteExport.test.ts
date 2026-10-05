import { describe, expect, it } from 'vitest'
import { buildReport, reportDocx, reportFileName, reportHtml, textSections } from './noteExport'
import { demoNote, emptyStructuredSummary } from './notes'

describe('note export', () => {
  it('splits a free-form summary into sections, bullets and paragraphs', () => {
    const sections = textSections('TÓM TẮT\n• Ý một\n- Ý hai\n\n## Quyết định:\nChốt ngày thứ Năm.\n**VIỆC CẦN LÀM**\n* Lan gửi khảo sát')
    expect(sections).toEqual([
      { title: 'Tóm tắt', blocks: [{ kind: 'bullets', items: ['Ý một', 'Ý hai'] }] },
      { title: 'Quyết định', blocks: [{ kind: 'paragraph', text: 'Chốt ngày thứ Năm.' }] },
      { title: 'Việc cần làm', blocks: [{ kind: 'bullets', items: ['Lan gửi khảo sát'] }] },
    ])
  })

  it('uses the structured summary and only adds the transcript when asked', () => {
    const note = { ...demoNote, structuredSummary: { ...emptyStructuredSummary(), tldr: 'Ngắn gọn', actionItems: [{ id: 'a', owner: 'Lan', task: 'Gửi khảo sát', deadline: 'Thứ Sáu', evidenceIds: [] }] } }
    const report = buildReport(note, { groupName: 'Sản phẩm' })
    expect(report.sections.map(section => section.title)).toEqual(['Tóm tắt nhanh', 'Việc cần làm'])
    expect(report.sections[1].blocks[0]).toEqual({ kind: 'bullets', items: ['Lan → Gửi khảo sát → Thứ Sáu'] })
    expect(report.meta).toContain('18 phút')
    expect(report.meta).toContain('Nhóm: Sản phẩm')
    expect(report.transcript).toEqual([])
    expect(buildReport(note, { transcript: true }).transcript).toHaveLength(6)
  })

  it('escapes HTML and makes a safe file name', () => {
    const report = buildReport({ ...demoNote, title: 'Họp <b>A/B</b>: "chốt"', summary: '• 1 < 2 & 3' })
    const html = reportHtml(report)
    expect(html).toContain('<h1>Họp &lt;b&gt;A/B&lt;/b&gt;: &quot;chốt&quot;</h1>')
    expect(html).toContain('<li>1 &lt; 2 &amp; 3</li>')
    expect(reportFileName(report, 'docx')).toBe('Họp b A B b chốt.docx')
  })

  it('builds a Word file', async () => {
    const bytes = await reportDocx(buildReport(demoNote, { transcript: true }))
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK')
  })
})
