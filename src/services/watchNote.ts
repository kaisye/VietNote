import { desktop } from './desktop'
import { formatStructuredSummary } from './notes'
import type { MeetingNote, StructuredMeetingSummary, TranscriptSegment } from './types'
import { clock, type WatchLine } from './youtube'

const SUMMARY_CHUNK = 300

/** A saved video note contains only lines the viewer reached, never skipped captions. */
export function watchedVideoSegments(watched: WatchLine[]): TranscriptSegment[] {
  return watched.filter(line => line.source.trim()).map((line, index) => ({
    id: `video-${Math.round(line.start * 1000)}-${index}`,
    timestamp: clock(line.start),
    startedAt: line.start,
    endedAt: line.end,
    audioSource: 'video',
    rawText: line.source,
    cleanText: line.translation?.trim() || line.source,
  }))
}

export async function summarizeWatchedVideo(segments: TranscriptSegment[], title: string): Promise<StructuredMeetingSummary> {
  const source = `video YouTube "${title}"; chỉ tóm tắt các đoạn người dùng thực sự đã xem, không suy đoán nội dung ở khoảng bị tua qua`
  try { return await desktop.summarizeSegments(segments, undefined, source) } catch (error) {
    if (segments.length <= SUMMARY_CHUNK) throw error
    let summary: StructuredMeetingSummary | undefined
    for (let index = 0; index < segments.length; index += SUMMARY_CHUNK) summary = await desktop.summarizeSegments(segments.slice(index, index + SUMMARY_CHUNK), summary, source)
    return summary!
  }
}

export function buildWatchNote(video: { title: string; url: string }, watched: WatchLine[], structuredSummary?: StructuredMeetingSummary): MeetingNote {
  const createdAt = new Date().toISOString()
  const transcriptSegments = watchedVideoSegments(watched)
  const transcript = transcriptSegments.map(segment => `[${segment.timestamp}] ${segment.cleanText}${segment.rawText !== segment.cleanText ? `\nGốc: ${segment.rawText}` : ''}`).join('\n')
  return {
    id: crypto.randomUUID(), title: video.title.trim() || 'Video YouTube', groupID: null, source: 'link', createdAt, updatedAt: createdAt,
    duration: watched.reduce((sum, line) => sum + Math.max(0, line.end - line.start), 0),
    summary: structuredSummary ? formatStructuredSummary(structuredSummary) : 'Đang tạo tóm tắt từ những đoạn video đã xem…',
    ...(structuredSummary ? { structuredSummary } : { saving: true }),
    transcript: `Nguồn: ${video.url}\n\n${transcript}`,
    transcriptSegments,
  }
}
