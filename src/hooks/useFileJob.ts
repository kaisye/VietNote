import { useEffect, useRef, useState } from 'react'
import { desktop, type AudioFile, type FileJobStatus } from '../services/desktop'
import { buildFileTranscript, fileCost, fileNoteTranscript } from '../services/fileTranscript'
import { emptyStructuredSummary, formatStructuredSummary } from '../services/notes'
import { requestSignIn } from '../services/credits'
import type { Language, MeetingNote, StructuredMeetingSummary, TranscriptSegment } from '../services/types'

export type FileJobPhase = 'idle' | 'picked' | 'uploading' | 'processing' | 'summarizing' | 'done' | 'error'

/** Survives a restart: a job already at Soniox is picked up again instead of being paid twice. */
interface SavedJob { jobId: string; file: AudioFile; language: Language; translate: boolean; startedAtMs: number }
const STORAGE_KEY = 'fileJob'
const POLL_MS = 3000
const SUMMARY_CHUNK = 300

const load = (): SavedJob | null => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') } catch { return null } }
const save = (job: SavedJob | null) => { try { if (job) localStorage.setItem(STORAGE_KEY, JSON.stringify(job)); else localStorage.removeItem(STORAGE_KEY) } catch { /* Keep working without storage. */ } }

function errorText(error: unknown, file: AudioFile | null): string {
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
const recordingStart = (file: AudioFile) => (file.modifiedMs ?? Date.now()) - (file.durationSeconds ?? 0) * 1000

async function summarize(segments: TranscriptSegment[]): Promise<StructuredMeetingSummary> {
  try { return await desktop.summarizeSegments(segments) } catch (error) {
    // Too long for one request: fold the transcript in chunks into one summary.
    if (segments.length <= SUMMARY_CHUNK) throw error
    let summary: StructuredMeetingSummary | undefined
    for (let index = 0; index < segments.length; index += SUMMARY_CHUNK) summary = await desktop.summarizeSegments(segments.slice(index, index + SUMMARY_CHUNK), summary)
    return summary!
  }
}

/** Transcribing a recorded file into a note; lives in the app model so it keeps running across pages. */
export function useFileJob(addNote: (note: MeetingNote) => void, refreshAccount: () => void) {
  const [phase, setPhase] = useState<FileJobPhase>('idle')
  const [file, setFile] = useState<AudioFile | null>(null)
  const [language, setLanguage] = useState<Language>('auto')
  const [translate, setTranslate] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [noteId, setNoteId] = useState<string | null>(null)
  const [charged, setCharged] = useState<number | null>(null)
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
    let structured = emptyStructuredSummary()
    let summary = ''
    try { structured = await summarize(segments); summary = formatStructuredSummary(structured) } catch { summary = 'Chưa tạo được tóm tắt · bản ghi đã được lưu.' }
    const title = structured.title || job.file.name.replace(/\.[^.]+$/, '')
    const note: MeetingNote = { id: crypto.randomUUID(), title, groupID: null, createdAt: new Date(job.startedAtMs).toISOString(), updatedAt: new Date().toISOString(), duration: result.audio_seconds ?? job.file.durationSeconds ?? 0, summary, structuredSummary: structured, transcriptSegments: segments, transcript: fileNoteTranscript(segments, paragraphs) }
    addNote(note)
    save(null)
    // The note holds the transcript now; Soniox's copy can go.
    void desktop.fileJobCleanup(job.jobId).catch(() => {})
    if (running.current !== run) return
    setNoteId(note.id); setPhase('done')
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
      setFile(picked); setPhase('picked'); setError(''); setNoteId(null); setCharged(null)
    } catch (failure) { setError(String(failure)); setPhase(file ? 'picked' : 'error') }
  }

  const start = async () => {
    if (!file || !['picked', 'error'].includes(phase)) return
    if (!await desktop.accountSignedIn().catch(() => false)) { requestSignIn(); return }
    const run = ++running.current
    const current = file
    setError(''); setProgress(0); setPhase('uploading')
    let job: SavedJob | null = null
    try {
      const started = await desktop.fileJobStart(current.name, current.durationSeconds)
      job = { jobId: started.job_id, file: current, language, translate: translate && language !== 'vi', startedAtMs: recordingStart(current) }
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

  const reset = () => { running.current += 1; setFile(null); setPhase('idle'); setError(''); setNoteId(null); setCharged(null); setProgress(0) }

  return { phase, file, language, setLanguage, translate, setTranslate, progress, error, noteId, charged, pick, start, cancel, reset }
}

export type FileJob = ReturnType<typeof useFileJob>
