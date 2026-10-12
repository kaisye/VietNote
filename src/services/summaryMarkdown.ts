import type { MeetingNote, StructuredMeetingSummary, SummaryBullet } from './types'

/**
 * A note's summary as one Markdown text the user edits freely. Points the AI took from the
 * transcript end in a small link, `[09:41](#t=id1,id2)`, that opens those transcript lines.
 */
const EVIDENCE = '#t='
const EVIDENCE_LINK = /\s*\[[^\]\n]*\]\(#t=[^)\s]*\)/g

export const evidenceHref = (ids: string[]) => `${EVIDENCE}${ids.map(encodeURIComponent).join(',')}`
export function evidenceIds(href: string | null | undefined): string[] {
  if (!href?.startsWith(EVIDENCE)) return []
  return href.slice(EVIDENCE.length).split(',').filter(Boolean).map(decodeURIComponent)
}
export const hasEvidence = (markdown: string) => /\]\(#t=/.test(markdown)
/** For copying, exporting and the AI's reading: the links mean nothing outside the app. */
export const withoutEvidence = (markdown: string) => markdown.replace(EVIDENCE_LINK, '')

type Label = (id: string) => string | undefined
const escapeText = (text: string) => text.replace(/\s+/g, ' ').trim()

function evidence(ids: string[], label: Label): string {
  if (!ids.length) return ''
  const first = label(ids[0]) ?? 'nguồn'
  return ` [${ids.length > 1 ? `${first} +${ids.length - 1}` : first}](${evidenceHref(ids)})`
}

export function structuredToMarkdown(summary: StructuredMeetingSummary, label: Label = () => undefined): string {
  const parts: string[] = []
  const section = (title: string, lines: string[]) => { if (lines.length) parts.push(`## ${title}\n\n${lines.join('\n')}`) }
  const bullets = (items: SummaryBullet[], text: (item: SummaryBullet) => string = item => item.text) =>
    items.filter(item => text(item).trim()).map(item => `- ${escapeText(text(item))}${evidence(item.evidenceIds, label)}`)
  if (summary.tldr.trim()) parts.push(`## Tóm tắt nhanh\n\n${summary.tldr.trim()}`)
  section('Ý chính', bullets(summary.keyPoints))
  section('Quyết định', bullets(summary.decisions))
  section('Quyết định dự kiến', bullets(summary.tentativeDecisions))
  section('Vấn đề chưa chốt', summary.unresolvedTopics.filter(item => item.topic.trim()).map(item =>
    `- **${escapeText(item.topic)}**${item.options.length ? ` · Lựa chọn: ${item.options.map(escapeText).join(', ')}` : ''}${evidence(item.evidenceIds, label)}`))
  section('Việc cần làm', summary.actionItems.filter(item => item.task.trim()).map(item =>
    `- [ ] ${[item.owner, item.task, item.deadline].filter(value => value?.trim()).map(value => escapeText(value!)).join(' → ')}${evidence(item.evidenceIds, label)}`))
  section('Câu hỏi mở', bullets(summary.openQuestions))
  section('Tạm hoãn', summary.deferred.filter(item => item.text.trim()).map(item =>
    `- ${[item.text, item.target].filter(value => value?.trim()).map(value => escapeText(value!)).join(' → ')}${evidence(item.evidenceIds, label)}`))
  return parts.join('\n\n')
}

/** Headings of summaries saved as plain text, before summaries were Markdown. */
const PLAIN_HEADINGS: Record<string, string> = {
  'TÓM TẮT': 'Tóm tắt', 'TÓM TẮT NHANH': 'Tóm tắt nhanh', 'TÓM TẮT TỔNG QUAN': 'Tóm tắt tổng quan', 'Ý CHÍNH': 'Ý chính',
  'QUYẾT ĐỊNH': 'Quyết định', 'QUYẾT ĐỊNH TẠM THỜI': 'Quyết định dự kiến', 'VẤN ĐỀ CHƯA CHỐT': 'Vấn đề chưa chốt',
  'VIỆC CẦN LÀM': 'Việc cần làm', 'CÂU HỎI MỞ': 'Câu hỏi mở', 'NỘI DUNG TẠM HOÃN': 'Tạm hoãn',
}
export function plainToMarkdown(text: string): string {
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim()
    const heading = PLAIN_HEADINGS[trimmed.replace(/:$/, '').toLocaleUpperCase('vi-VN')]
    if (heading) return `## ${heading}`
    if (/^ĐOẠN \d+/i.test(trimmed)) return `### ${trimmed}`
    return line.replace(/^(\s*)[•·]\s*/, '$1- ')
  }).join('\n').replace(/\n*(#{2,3} [^\n]+)\n*/g, '\n\n$1\n\n').trim()
}

/** The summary to show and edit: the user's own text once there is one. */
export function noteMarkdown(note: MeetingNote, label?: Label): string {
  if (note.summaryMarkdown !== undefined) return note.summaryMarkdown
  if (note.structuredSummary) return structuredToMarkdown(note.structuredSummary, label ?? segmentTime(note))
  return plainToMarkdown(note.summary)
}

/** The clock time of a transcript line, as the evidence links show it. */
export function segmentTime(note: MeetingNote): Label {
  const times = new Map((note.transcriptSegments ?? []).map(segment => [segment.id, segment.timestamp]))
  return id => {
    const at = times.get(id)
    if (!at) return undefined
    const date = new Date(at)
    return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  }
}

/** The summary as plain reading text, for search, copying and the AI. */
export const noteSummaryText = (note: MeetingNote) => withoutEvidence(noteMarkdown(note)).trim()
