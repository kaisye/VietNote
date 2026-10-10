import type { MeetingNote, NoteDocument, StructuredMeetingSummary } from './types'
import { formatTime } from './notes'
import { documentTitle, kindLabel } from './noteDocument'

/** One export, described once and rendered to HTML (copy, PDF) and Word. Text may hold **bold** runs. */
export type ReportBlock = { kind: 'paragraph'; text: string } | { kind: 'quote'; text: string } | { kind: 'bullets'; items: string[] } | { kind: 'numbered'; items: string[] } | { kind: 'table'; header: string[]; rows: string[][] }
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

/** Cells of a `| a | b |` row, or null when the line is not a table row. `\|` stays a literal pipe. */
const tableCells = (line: string) => /^\|.*\|$/.test(line) && line.length > 1
  ? line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
  : null

/** An AI-written Markdown document: its `#` heading is the report title, `##`… start sections. */
export function markdownSections(markdown: string): ReportSection[] {
  const sections: ReportSection[] = []
  let current: ReportSection = { title: '', blocks: [] }
  let titleSkipped = false
  let previous = ''
  const add = (kind: 'bullets' | 'numbered', item: string) => {
    const last = current.blocks[current.blocks.length - 1]
    if (last?.kind === kind) last.items.push(item); else current.blocks.push({ kind, items: [item] })
  }
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    const quoteContinues = previous.startsWith('>')
    previous = line
    if (!line || /^([-*_])\1{2,}$/.test(line)) continue
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      if (heading[1].length === 1 && !titleSkipped && !sections.length && !current.blocks.length) { titleSkipped = true; continue }
      if (current.title || current.blocks.length) sections.push(current)
      current = { title: heading[2].replace(/\*\*/g, '').trim(), blocks: [] }
      continue
    }
    titleSkipped = true
    const quote = line.match(/^>\s?(.*)$/)
    const last = current.blocks[current.blocks.length - 1]
    if (quote) { if (last?.kind === 'quote' && quoteContinues) last.text += ` ${quote[1]}`; else current.blocks.push({ kind: 'quote', text: quote[1] }); continue }
    const cells = tableCells(line)
    if (cells) {
      // The `| :--- |` divider is dropped; rows join one table even when blank lines sit between them.
      if (cells.every(cell => /^:?-+:?$/.test(cell))) continue
      if (last?.kind === 'table') last.rows.push(last.header.map((_, index) => cells[index] ?? ''))
      else current.blocks.push({ kind: 'table', header: cells, rows: [] })
      continue
    }
    const bullet = line.match(/^[-•*+]\s+(.+)$/)
    if (bullet) { add('bullets', bullet[1]); continue }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/)
    if (numbered) { add('numbered', numbered[1]); continue }
    current.blocks.push({ kind: 'paragraph', text: line })
  }
  if (current.title || current.blocks.length) sections.push(current)
  return sections
}

const reportMeta = (note: MeetingNote, groupName?: string | null) => {
  const meta = [formatTime(note.createdAt)]
  if (note.duration > 0) meta.push(`${Math.max(1, Math.round(note.duration / 60))} phút`)
  if (groupName) meta.push(`Nhóm: ${groupName}`)
  return meta
}

const reportTranscript = (note: MeetingNote, include?: boolean): Report['transcript'] => !include ? [] : note.transcriptSegments?.length
  ? note.transcriptSegments.map(segment => ({ time: formatTime(segment.timestamp, false), speaker: segment.speaker, text: segment.cleanText }))
  : note.transcript.trim() ? note.transcript.trim().split(/\r?\n/).filter(line => line.trim()).map(text => ({ time: '', text })) : []

export function documentReport(note: MeetingNote, document: NoteDocument, options: { groupName?: string | null; transcript?: boolean } = {}): Report {
  return { title: documentTitle(document, note.title), meta: [kindLabel(document.kind), ...reportMeta(note, options.groupName)], sections: markdownSections(document.markdown), transcript: reportTranscript(note, options.transcript) }
}

export function buildReport(note: MeetingNote, options: { groupName?: string | null; transcript?: boolean } = {}): Report {
  const meta = reportMeta(note, options.groupName)
  const sections = note.structuredSummary ? structuredSections(note.structuredSummary) : textSections(note.summary)
  const transcript = reportTranscript(note, options.transcript)
  return { title: note.title.trim() || 'Chưa có tiêu đề', meta, sections, transcript }
}

const escape = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
/** Splits `**bold**` runs out of a line; other Markdown marks are dropped. */
export function inlineRuns(text: string): { text: string; bold: boolean }[] {
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(part => /^\*\*[^*]+\*\*$/.test(part)
    ? { text: part.slice(2, -2), bold: true }
    : { text: part.replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2').replace(/`([^`]+)`/g, '$1'), bold: false })
}
const inline = (text: string) => inlineRuns(text).map(run => run.bold ? `<strong>${escape(run.text)}</strong>` : escape(run.text)).join('')

/** Semantic HTML with no classes, so it pastes cleanly into Docs, Notion and mail, and prints from the app. */
export function reportHtml(report: Report): string {
  const blocks = (items: ReportBlock[]) => items.map(block => block.kind === 'paragraph' ? `<p>${inline(block.text)}</p>`
    : block.kind === 'quote' ? `<blockquote><p>${inline(block.text)}</p></blockquote>`
    : block.kind === 'table' ? `<table><thead><tr>${block.header.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : `<${block.kind === 'numbered' ? 'ol' : 'ul'}>${block.items.map(item => `<li>${inline(item)}</li>`).join('')}</${block.kind === 'numbered' ? 'ol' : 'ul'}>`).join('')
  const sections = report.sections.map(section => `${section.title ? `<h2>${escape(section.title)}</h2>` : ''}${blocks(section.blocks)}`).join('')
  const transcript = report.transcript.length ? `<h2>Transcript gốc</h2>${report.transcript.map(line => `<p>${line.time ? `<strong>[${escape(line.time)}]</strong> ` : ''}${line.speaker ? `<strong>${escape(line.speaker)}:</strong> ` : ''}${escape(line.text)}</p>`).join('')}` : ''
  return `<h1>${escape(report.title)}</h1><p><em>${escape(report.meta.join(' · '))}</em></p>${sections || '<p>Chưa có nội dung tóm tắt.</p>'}${transcript}`
}

/** Markdown export: the document as written, or the report's sections. */
export function reportMarkdown(report: Report): string {
  const row = (cells: string[]) => `| ${cells.map(cell => cell.replace(/\|/g, '\\|')).join(' | ')} |`
  const block = (item: ReportBlock) => item.kind === 'paragraph' ? item.text : item.kind === 'quote' ? `> ${item.text}`
    : item.kind === 'table' ? [row(item.header), row(item.header.map(() => '---')), ...item.rows.map(row)].join('\n')
    : item.items.map((text, index) => `${item.kind === 'numbered' ? `${index + 1}.` : '-'} ${text}`).join('\n')
  const parts = [`# ${report.title}`, `_${report.meta.join(' · ')}_`]
  for (const section of report.sections) {
    if (section.title) parts.push(`## ${section.title}`)
    parts.push(...section.blocks.map(block))
  }
  if (report.transcript.length) parts.push('## Transcript gốc', report.transcript.map(line => `${line.time ? `[${line.time}] ` : ''}${line.speaker ? `**${line.speaker}:** ` : ''}${line.text}`).join('\n\n'))
  return `${parts.join('\n\n')}\n`
}

export function reportFileName(report: Report, extension: string): string {
  const base = report.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'VietNote'
  return `${base}.${extension}`
}

/** Word document, loaded on demand so `docx` stays out of the main bundle. */
export async function reportDocx(report: Report): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, BorderStyle, ShadingType, WidthType } = await import('docx')
  const runs = (text: string, italics = false, bold = false) => inlineRuns(text).map(run => new TextRun({ text: run.text, bold: bold || run.bold, italics }))
  // A4 less the default 1-inch margins, in twentieths of a point; Word and Docs both need explicit column widths.
  const tableWidth = 9026
  const table = (header: string[], rows: string[][]) => new Table({
    width: { size: tableWidth, type: WidthType.DXA },
    columnWidths: header.map(() => Math.floor(tableWidth / header.length)),
    rows: [header, ...rows].map((cells, rowIndex) => new TableRow({ tableHeader: rowIndex === 0, cantSplit: true, children: cells.map(cell => new TableCell({
      width: { size: Math.floor(tableWidth / header.length), type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: rowIndex === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF0FB' } : undefined,
      children: [new Paragraph({ spacing: { after: 0 }, children: runs(cell, false, rowIndex === 0) })],
    })) })),
  })
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(report.title)] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: report.meta.join(' · '), italics: true, color: '666666' })] }),
  ]
  for (const section of report.sections) {
    if (section.title) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(section.title)] }))
    for (const block of section.blocks) {
      if (block.kind === 'table') children.push(table(block.header, block.rows), new Paragraph({ spacing: { after: 0 }, children: [] }))
      else if (block.kind === 'paragraph') children.push(new Paragraph({ children: runs(block.text) }))
      else if (block.kind === 'quote') children.push(new Paragraph({ indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: '4D5EBE', space: 8 } }, children: runs(block.text, true) }))
      else if (block.kind === 'numbered') block.items.forEach((item, index) => children.push(new Paragraph({ indent: { left: 567, hanging: 340 }, children: [new TextRun(`${index + 1}. `), ...runs(item)] })))
      else for (const item of block.items) children.push(new Paragraph({ bullet: { level: 0 }, children: runs(item) }))
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
