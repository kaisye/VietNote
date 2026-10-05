import type { MeetingNote, StructuredMeetingSummary } from './types'
import { formatTime } from './notes'

/** One export, described once and rendered to HTML (copy, PDF) and Word. */
export type ReportBlock = { kind: 'paragraph'; text: string } | { kind: 'bullets'; items: string[] }
export interface ReportSection { title: string; blocks: ReportBlock[] }
export interface Report {
  title: string
  meta: string[]
  sections: ReportSection[]
  transcript: { time: string; speaker?: string | null; text: string }[]
}

function structuredSections(summary: StructuredMeetingSummary): ReportSection[] {
  const sections: ReportSection[] = []
  const bullets = (title: string, items: string[]) => { if (items.length) sections.push({ title, blocks: [{ kind: 'bullets', items }] }) }
  if (summary.tldr.trim()) sections.push({ title: 'Tóm tắt nhanh', blocks: [{ kind: 'paragraph', text: summary.tldr.trim() }] })
  bullets('Ý chính', summary.keyPoints.map(item => item.text))
  bullets('Quyết định', summary.decisions.map(item => item.text))
  bullets('Quyết định dự kiến', summary.tentativeDecisions.map(item => item.text))
  bullets('Vấn đề chưa chốt', summary.unresolvedTopics.map(item => [item.topic, item.options.length ? `Lựa chọn: ${item.options.join(', ')}` : '', item.status === 'No final decision' ? 'Chưa có quyết định cuối cùng' : item.status].filter(Boolean).join(' · ')))
  bullets('Việc cần làm', summary.actionItems.map(item => [item.owner, item.task, item.deadline].filter(Boolean).join(' → ')))
  bullets('Câu hỏi mở', summary.openQuestions.map(item => item.text))
  bullets('Tạm hoãn', summary.deferred.map(item => [item.text, item.target].filter(Boolean).join(' → ')))
  return sections
}

/** Free-form summaries: `#` or all-caps lines start a section, `-`/`•`/`*` lines are bullets, the rest are paragraphs. */
export function textSections(text: string): ReportSection[] {
  const sections: ReportSection[] = []
  let current: ReportSection = { title: '', blocks: [] }
  const flush = () => { if (current.title || current.blocks.length) sections.push(current) }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const plain = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
    const isHeading = /^#+\s/.test(line) || (plain.length <= 60 && /\p{L}/u.test(plain) && plain === plain.toLocaleUpperCase('vi-VN') && !/^[-•*]/.test(plain))
    if (isHeading) {
      flush()
      const title = plain.replace(/:$/, '')
      current = { title: title.charAt(0) + title.slice(1).toLocaleLowerCase('vi-VN'), blocks: [] }
      continue
    }
    const bullet = plain.match(/^[-•*]\s*(.+)$/)
    const last = current.blocks[current.blocks.length - 1]
    if (bullet) {
      if (last?.kind === 'bullets') last.items.push(bullet[1])
      else current.blocks.push({ kind: 'bullets', items: [bullet[1]] })
    } else current.blocks.push({ kind: 'paragraph', text: plain })
  }
  flush()
  return sections
}

export function buildReport(note: MeetingNote, options: { groupName?: string | null; transcript?: boolean } = {}): Report {
  const meta = [formatTime(note.createdAt)]
  if (note.duration > 0) meta.push(`${Math.max(1, Math.round(note.duration / 60))} phút`)
  if (options.groupName) meta.push(`Nhóm: ${options.groupName}`)
  const sections = note.structuredSummary ? structuredSections(note.structuredSummary) : textSections(note.summary)
  const transcript = !options.transcript ? [] : note.transcriptSegments?.length
    ? note.transcriptSegments.map(segment => ({ time: formatTime(segment.timestamp, false), speaker: segment.speaker, text: segment.cleanText }))
    : note.transcript.trim() ? note.transcript.trim().split(/\r?\n/).filter(line => line.trim()).map(text => ({ time: '', text })) : []
  return { title: note.title.trim() || 'Chưa có tiêu đề', meta, sections, transcript }
}

const escape = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

/** Semantic HTML with no classes, so it pastes cleanly into Docs, Notion and mail, and prints from the app. */
export function reportHtml(report: Report): string {
  const blocks = (items: ReportBlock[]) => items.map(block => block.kind === 'paragraph' ? `<p>${escape(block.text)}</p>` : `<ul>${block.items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`).join('')
  const sections = report.sections.map(section => `${section.title ? `<h2>${escape(section.title)}</h2>` : ''}${blocks(section.blocks)}`).join('')
  const transcript = report.transcript.length ? `<h2>Transcript gốc</h2>${report.transcript.map(line => `<p>${line.time ? `<strong>[${escape(line.time)}]</strong> ` : ''}${line.speaker ? `<strong>${escape(line.speaker)}:</strong> ` : ''}${escape(line.text)}</p>`).join('')}` : ''
  return `<h1>${escape(report.title)}</h1><p><em>${escape(report.meta.join(' · '))}</em></p>${sections || '<p>Chưa có nội dung tóm tắt.</p>'}${transcript}`
}

export function reportFileName(report: Report, extension: string): string {
  const base = report.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'VietNote'
  return `${base}.${extension}`
}

/** Word document, loaded on demand so `docx` stays out of the main bundle. */
export async function reportDocx(report: Report): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx')
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(report.title)] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: report.meta.join(' · '), italics: true, color: '666666' })] }),
  ]
  for (const section of report.sections) {
    if (section.title) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(section.title)] }))
    for (const block of section.blocks) {
      if (block.kind === 'paragraph') children.push(new Paragraph({ children: [new TextRun(block.text)] }))
      else for (const item of block.items) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] }))
    }
  }
  if (!report.sections.length) children.push(new Paragraph({ children: [new TextRun('Chưa có nội dung tóm tắt.')] }))
  if (report.transcript.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun('Transcript gốc')] }))
    for (const line of report.transcript) children.push(new Paragraph({ children: [
      ...(line.time ? [new TextRun({ text: `[${line.time}] `, color: '666666' })] : []),
      ...(line.speaker ? [new TextRun({ text: `${line.speaker}: `, bold: true })] : []),
      new TextRun(line.text),
    ] }))
  }
  const document = new Document({
    creator: 'VietNote', title: report.title,
    styles: { default: { document: { run: { font: 'Arial', size: 22 }, paragraph: { spacing: { after: 120, line: 300 } } } } },
    sections: [{ children }],
  })
  return new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer())
}
