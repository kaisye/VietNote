import { useEffect, useRef, useState } from 'react'
import { desktop, type AudioFile, type FileJobStatus, type LinkProgress } from '../services/desktop'
import { buildFileTranscript, fileCost, fileNoteTranscript } from '../services/fileTranscript'
import { emptyStructuredSummary, formatStructuredSummary } from '../services/notes'
import { requestSignIn } from '../services/credits'
import type { WriteOptions } from './useNoteDocuments'
import type { DocumentKind, Language, MeetingNote, StructuredMeetingSummary, TimedTranslation, TranscriptSegment } from '../services/types'

export type FileJobPhase = 'idle' | 'fetching' | 'picked' | 'uploading' | 'processing' | 'summarizing' | 'writing' | 'done' | 'error'

/** What the AI writes once the transcript and summary are saved: nothing more, or one document. */
export interface FollowUp {
  kind: DocumentKind | null; instruction: string
  /** Only the transcript (for subtitles): no summary, no document. */
  scriptOnly?: boolean
}
const FOLLOW_UP_KEY = 'fileFollowUp'
const loadFollowUp = (): FollowUp => {
  try { const value = JSON.parse(localStorage.getItem(FOLLOW_UP_KEY) ?? 'null'); if (value && 'kind' in value) return { kind: value.kind ?? null, instruction: String(value.instruction ?? ''), scriptOnly: value.scriptOnly === true } } catch { /* Defaults below. */ }
  return { kind: null, instruction: '' }
}

/** Survives a restart: a job already at Soniox is picked up again instead of being paid twice. */
interface SavedJob { jobId: string; file: AudioFile; language: Language; translate: boolean; startedAtMs: number; followUp?: FollowUp }
const STORAGE_KEY = 'fileJob'
const POLL_MS = 3000
const SUMMARY_CHUNK = 300

const load = (): SavedJob | null => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') } catch { return null } }
const save = (job: SavedJob | null) => { try { if (job) localStorage.setItem(STORAGE_KEY, JSON.stringify(job)); else localStorage.removeItem(STORAGE_KEY) } catch { /* Keep working without storage. */ } }

export function errorText(error: unknown, file: AudioFile | null): string {
  const code = error instanceof Error ? error.message : String(error)
  if (code === 'insufficient_credit') return file?.durationSeconds
    ? `Không đủ phút: file này cần khoảng ${Math.ceil(fileCost(file.durationSeconds) / 60)} phút. Hãy nạp thêm rồi thử lại.`
    : 'Không đủ phút để dịch file này. Hãy nạp thêm rồi thử lại.'
  if (code === 'signed_out') return 'Hãy đăng nhập tài khoản VietNote ở góc trái dưới.'
  if (code === 'offline' || code === 'upload_interrupted') return 'Mất kết nối khi gửi file. Phút đã giữ được hoàn lại; hãy thử lại.'
  if (code === 'upload_failed') return 'Máy chủ không nhận được file. Phút đã giữ được hoàn lại; hãy thử lại.'
  // Our own messages are already for people; provider errors stay in the console.
  if (/^(Không|Chưa|Hãy)/.test(code)) return code
  console.error('file job failed', code)
  return 'Không dịch được file này. Phút đã giữ được hoàn lại; hãy thử lại sau.'
}

/** The recording's start: its last write minus its length, i.e. roughly when the meeting began. */
const recordingStart = (file: AudioFile) => file.sourceUrl ? Date.now() : (file.modifiedMs ?? Date.now()) - (file.durationSeconds ?? 0) * 1000

export function linkErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (/^(Không|Chưa|Hãy|Đang|Link|Video|Âm thanh|Mất|Công cụ)/.test(code)) return code
  console.error('link fetch failed', code)
  return 'Không lấy được âm thanh từ link này. Hãy thử lại sau.'
}

/** Tells the summary what the recording is, so a video is not written up as a meeting. */
function describeSource(file: AudioFile): string {
  const title = file.name.replace(/\.[^.]+$/, '')
  if (!file.sourceUrl) return `file ghi âm do người dùng chọn, tên file "${title}" (có thể là cuộc họp, bài giảng, phỏng vấn…)`
  let host = file.sourceUrl
  try { host = new URL(file.sourceUrl).hostname.replace(/^www\./, '') } catch { /* Keep the link. */ }
  return `video/âm thanh từ link ${host}, tiêu đề "${title}"`
}

async function summarize(segments: TranscriptSegment[], source: string): Promise<StructuredMeetingSummary> {
  try { return await desktop.summarizeSegments(segments, undefined, source) } catch (error) {
    // Too long for one request: fold the transcript in chunks into one summary.
    if (segments.length <= SUMMARY_CHUNK) throw error
    let summary: StructuredMeetingSummary | undefined
    for (let index = 0; index < segments.length; index += SUMMARY_CHUNK) summary = await desktop.summarizeSegments(segments.slice(index, index + SUMMARY_CHUNK), summary, source)
    return summary!
  }
}

/** Transcribing a recorded file into a note; lives in the app model so it keeps running across pages. */
export function useFileJob(addNote: (note: MeetingNote) => void, refreshAccount: () => void, write: (noteId: string, options: WriteOptions) => Promise<string | null>) {
  const [phase, setPhase] = useState<FileJobPhase>('idle')
  const [file, setFile] = useState<AudioFile | null>(null)
  const [language, setLanguage] = useState<Language>('auto')
  const [translate, setTranslate] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [noteId, setNoteId] = useState<string | null>(null)
  const [charged, setCharged] = useState<number | null>(null)
  const [linkProgress, setLinkProgress] = useState<LinkProgress | null>(null)
  const [followUp, setFollowUpState] = useState<FollowUp>(loadFollowUp)
  const [written, setWritten] = useState(false)
  /** The transcript as soon as it is ready, shown while the summary and document are written. */
  const [preview, setPreview] = useState<{ segments: TranscriptSegment[]; translations: TimedTranslation[]; createdAt: string } | null>(null)
  const setFollowUp = (value: FollowUp) => { setFollowUpState(value); try { localStorage.setItem(FOLLOW_UP_KEY, JSON.stringify(value)) } catch { /* Not remembered. */ } }
  const running = useRef(0)

  const finish = async (job: SavedJob, run: number) => {
    setPhase('processing')
    let result: FileJobStatus
    for (;;) {
      if (running.current !== run) return
      result = await desktop.fileJobStatus(job.jobId)
      if (result.status === 'completed' || result.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
    if (running.current !== run) return
    if (result.status === 'failed') throw new Error(result.error ?? 'transcription_failed')
    setCharged(result.charged_seconds ?? null)
    refreshAccount()
    setPhase('summarizing')
    const { segments, paragraphs } = buildFileTranscript(result.tokens ?? [], job.startedAtMs)
    if (!segments.length) throw new Error('Không nghe thấy lời nói nào trong file.')
    if (running.current === run) setPreview({ segments, translations: paragraphs.map(paragraph => ({ entryIds: paragraph.entryIds, text: paragraph.translatedText })), createdAt: new Date(job.startedAtMs).toISOString() })
    const scriptOnly = Boolean(job.followUp?.scriptOnly)
    let structured = emptyStructuredSummary()
    let summary = ''
    if (!scriptOnly) try { structured = await summarize(segments, describeSource(job.file)); summary = formatStructuredSummary(structured) } catch { summary = 'Chưa tạo được tóm tắt · bản ghi đã được lưu.' }
    // A video's own title says more than one guessed from its words.
    const title = (job.file.sourceUrl ? '' : structured.title) || job.file.name.replace(/\.[^.]+$/, '')
    const note: MeetingNote = { id: crypto.randomUUID(), title, groupID: null, source: job.file.sourceUrl ? 'link' : 'file', createdAt: new Date(job.startedAtMs).toISOString(), updatedAt: new Date().toISOString(), duration: result.audio_seconds ?? job.file.durationSeconds ?? 0, summary, structuredSummary: scriptOnly ? undefined : structured, transcriptSegments: segments, translations: paragraphs.map(paragraph => ({ entryIds: paragraph.entryIds, text: paragraph.translatedText })), transcript: `${job.file.sourceUrl ? `Nguồn: ${job.file.sourceUrl}\n\n` : ''}${fileNoteTranscript(segments, paragraphs)}` }
    addNote(note)
    save(null)
    // The note holds the transcript now; Soniox's copy can go.
    void desktop.fileJobCleanup(job.jobId).catch(() => {})
    if (running.current !== run) return
    setNoteId(note.id)
    const follow = job.followUp
    if (!scriptOnly && follow?.kind && (follow.kind !== 'custom' || follow.instruction.trim())) {
      setPhase('writing')
      // A failed write keeps its error on the note, where it can be retried.
      const documentId = await write(note.id, { kind: follow.kind, length: 'medium', instruction: follow.instruction })
      if (running.current !== run) return
      setWritten(Boolean(documentId))
    }
    setPhase('done')
  }

  const fail = (failure: unknown, run: number, current: AudioFile | null) => {
    if (running.current !== run) return
    setError(errorText(failure, current)); setPhase('error')
  }

  // Pick up a job that was still running when the app closed.
  useEffect(() => {
    const saved = load()
    if (!saved || !desktop.isDesktop) return
    const run = ++running.current
    setFile(saved.file); setLanguage(saved.language); setTranslate(saved.translate)
    finish(saved, run).catch(failure => { save(null); fail(failure, run, saved.file) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    try {
      const picked = await desktop.pickAudioFile()
      if (!picked) return
      setFile(picked); setPhase('picked'); setError(''); setNoteId(null); setCharged(null); setWritten(false); setPreview(null)
    } catch (failure) { setError(String(failure)); setPhase(file ? 'picked' : 'error') }
  }

  /** Fetches the audio behind a link; it then waits, like a picked file, for "Bắt đầu dịch". */
  const fetchLink = async (url: string) => {
    if (phase === 'fetching' || !url.trim()) return
    // Signed out: say so before downloading anything.
    if (!await desktop.accountSignedIn().catch(() => false)) { requestSignIn(); return }
    const run = ++running.current
    setError(''); setNoteId(null); setCharged(null); setFile(null); setLinkProgress(null); setPreview(null); setPhase('fetching')
    try {
      const fetched = await desktop.fetchLinkAudio(url, setLinkProgress)
      if (running.current !== run) return
      // The purpose was chosen with the link: go straight on to transcribing.
      setFile(fetched)
      await begin(fetched)
    } catch (failure) {
      if (running.current !== run) return
      const code = failure instanceof Error ? failure.message : String(failure)
      if (code === 'cancelled') { setPhase('idle'); return }
      setError(linkErrorText(failure)); setPhase('error')
    }
  }

  const cancelLink = () => { running.current += 1; void desktop.cancelLinkAudio().catch(() => {}); setPhase('idle'); setLinkProgress(null) }

  const start = () => { if (file && ['picked', 'error'].includes(phase)) void begin(file) }

  const begin = async (current: AudioFile) => {
    if (!await desktop.accountSignedIn().catch(() => false)) { requestSignIn(); setPhase('picked'); return }
    const run = ++running.current
    setError(''); setProgress(0); setWritten(false); setPreview(null); setPhase('uploading')
    let job: SavedJob | null = null
    try {
      const started = await desktop.fileJobStart(current.name, current.durationSeconds)
      job = { jobId: started.job_id, file: current, language, translate: translate && language !== 'vi', startedAtMs: recordingStart(current), followUp }
      refreshAccount()
      await desktop.fileJobUpload(job.jobId, current.path, job.language, job.translate, setProgress)
      save(job)
      await finish(job, run)
    } catch (failure) {
      // An upload that never reached Soniox is refunded.
      if (job && !load()) void desktop.fileJobCancel(job.jobId).catch(() => {}).finally(refreshAccount)
      save(null)
      fail(failure, run, current)
    }
  }

  const cancel = () => {
    const saved = load()
    running.current += 1
    if (saved) void desktop.fileJobCancel(saved.jobId).catch(() => {}).finally(refreshAccount)
    save(null)
    setPhase(file ? 'picked' : 'idle'); setProgress(0)
  }

  const reset = () => { running.current += 1; setFile(null); setPhase('idle'); setError(''); setNoteId(null); setCharged(null); setProgress(0); setWritten(false); setPreview(null) }

  return { phase, file, language, setLanguage, translate, setTranslate, progress, error, noteId, charged, linkProgress, followUp, setFollowUp, written, preview, pick, fetchLink, cancelLink, start, cancel, reset }
}

export type FileJob = ReturnType<typeof useFileJob>
