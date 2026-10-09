import { describe, expect, it } from 'vitest'
import { buildReport, documentReport, inlineRuns, markdownSections, reportDocx, reportFileName, reportHtml, reportMarkdown, textSections } from './noteExport'
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

  it('turns an AI document into a report titled by its heading', () => {
    const markdown = '# AI sẽ thay đổi lớp học\n\nMở đầu **rất** ngắn.\n\n## Ba ý chính\n1. **Một**: giải thích\n2. Hai\n\n> Câu trích\n> tiếp dòng\n\n> Câu khác\n\n---\n- Gạch *nghiêng*'
    expect(markdownSections(markdown)).toEqual([
      { title: '', blocks: [{ kind: 'paragraph', text: 'Mở đầu **rất** ngắn.' }] },
      { title: 'Ba ý chính', blocks: [{ kind: 'numbered', items: ['**Một**: giải thích', 'Hai'] }, { kind: 'quote', text: 'Câu trích tiếp dòng' }, { kind: 'quote', text: 'Câu khác' }, { kind: 'bullets', items: ['Gạch *nghiêng*'] }] },
    ])
    const report = documentReport(demoNote, { id: 'd', kind: 'workshop', length: 'medium', markdown, createdAt: '', updatedAt: '' })
    expect(report.title).toBe('AI sẽ thay đổi lớp học')
    expect(report.meta[0]).toBe('Tóm tắt workshop')
    const html = reportHtml(report)
    expect(html).toContain('<p>Mở đầu <strong>rất</strong> ngắn.</p>')
    expect(html).toContain('<ol><li><strong>Một</strong>: giải thích</li><li>Hai</li></ol>')
    expect(html).toContain('<blockquote><p>Câu trích tiếp dòng</p></blockquote>')
    expect(html).toContain('<li>Gạch nghiêng</li>')
    expect(reportMarkdown(report)).toContain('## Ba ý chính\n\n1. **Một**: giải thích\n2. Hai\n\n> Câu trích tiếp dòng')
  })

  it('keeps bold runs and drops other inline marks', () => {
    expect(inlineRuns('A **b** `c` _d_ 2*3*4')).toEqual([{ text: 'A ', bold: false }, { text: 'b', bold: true }, { text: ' c d 2*3*4', bold: false }])
  })

  it('builds a Word file from a document', async () => {
    const bytes = await reportDocx(documentReport(demoNote, { id: 'd', kind: 'post', length: 'short', markdown: 'Hook\n\n> Trích\n\n1. Một', createdAt: '', updatedAt: '' }))
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK')
  })
})
