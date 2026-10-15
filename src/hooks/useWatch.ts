import { useMemo, useRef, useState } from 'react'
import { desktop, type AudioFile, type FileJobStatus } from '../services/desktop'
import { requestSignIn } from '../services/credits'
import { batchAt, batchOrder, heardWords, planBatches, seekSlices, speechLines, youtubeId, type Batch, type CaptionPiece, type VideoCaptions, type WatchLine } from '../services/youtube'
import { errorText, linkErrorText } from './useFileJob'
import { billablePlayback } from '../services/watchUsage'

export type WatchPhase = 'idle' | 'loading' | 'ready' | 'error'
export type WatchVideo = Omit<VideoCaptions, 'pieces'> & { url: string }
/** Hearing the video: its audio is fetched, sent for transcription, then transcribed. */
export interface Listening { stage: 'fetching' | 'uploading' | 'processing'; percent: number }

/** Batches translated at once. */
const PARALLEL = 2
/** Batches translated ahead of the one being watched, a few minutes of video: the rest waits until it is near. */
const AHEAD = 4
const TRIES = 3
const POLL_MS = 3000
const SEEK_SETTLE_MS = 160
const BILL_EVERY_SECONDS = 10

interface UsageMeter { session: string; videoId: string; total: number; sent: number; charging: boolean; pendingForce: boolean; playing: boolean; retryAt: number }
const usageMeter = (videoId = ''): UsageMeter => ({ session: crypto.randomUUID(), videoId, total: 0, sent: 0, charging: false, pendingForce: false, playing: false, retryAt: 0 })

interface SeekPart { batch: Batch; result?: WatchLine[]; done: boolean; tries: number; retryAt: number }
interface SeekPlan { parts: SeekPart[]; order: number[] }
const seekPlan = (split: NonNullable<ReturnType<typeof seekSlices>>): SeekPlan => ({
  parts: split.parts.map(batch => ({ batch, done: false, tries: 0, retryAt: 0 })),
  order: [split.quick, ...split.parts.map((_, at) => at).filter(at => at > split.quick), ...split.parts.map((_, at) => at).filter(at => at < split.quick)],
})

const loadError = (error: unknown) => {
  const code = String(error)
  if (code === 'not_youtube') return 'Đây không phải link video YouTube. Hãy dán link dạng youtube.com/watch?v=… hoặc youtu.be/….'
  if (code === 'not_embeddable') return 'Chủ video không cho phát ở ngoài YouTube. Hãy mở video trong trình duyệt rồi dùng Phiên dịch.'
  return code
}
/** Errors no retry fixes: the account, not the batch. */
const stops = (error: string) => /đăng nhập|hết phút|chưa cấu hình/i.test(error)

/**
 * A YouTube video with Vietnamese subtitles translated ahead of the voice: its captions are
 * read when it opens, then translated batch by batch from the part being watched. A video
 * without captions can be heard instead: its audio is transcribed first, then translated alike.
 */
export function useWatch(onCharged: () => void) {
  const [phase, setPhase] = useState<WatchPhase>('idle')
  const [video, setVideo] = useState<WatchVideo | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [translated, setTranslated] = useState<Record<number, WatchLine[]>>({})
  const [error, setError] = useState('')
  const [translateError, setTranslateError] = useState('')
  const [listening, setListening] = useState<Listening | null>(null)
  const [listenError, setListenError] = useState('')
  const [usageError, setUsageError] = useState('')
  /** `token` changes with the video, `plan` with its subtitles (captions, then heard words). */
  const job = useRef({ token: 0, plan: 0, listen: 0, listenJob: null as string | null, fetching: false, video: null as WatchVideo | null, batches: [] as Batch[], result: {} as Record<number, WatchLine[]>, done: new Set<number>(), running: new Set<number>(), tries: new Map<number, number>(), retryAt: new Map<number, number>(), parts: new Map<number, SeekPlan>(), pendingSeek: null as number | null, seekTimer: null as ReturnType<typeof setTimeout> | null, current: 0, stopped: false })
  /** Where the video was left, so it opens there again after visiting another page. */
  const position = useRef(0)
  const usage = useRef<UsageMeter>(usageMeter())

  const lines = useMemo(() => batches.flatMap((batch, index) => translated[index] ?? batch.draft), [batches, translated])
  const [done, setDone] = useState(0)

  /** Charges a cumulative counter, so retries cannot debit the same watched seconds twice. */
  function flushUsage(meter = usage.current, force = false) {
    if (!meter.videoId) return
    const target = Math.floor(meter.total)
    if (target <= meter.sent || (!force && target - meter.sent < BILL_EVERY_SECONDS)) return
    if (Date.now() < meter.retryAt) return
    if (meter.charging) { meter.pendingForce ||= force; return }
    meter.charging = true
    void desktop.watchCharge(meter.session, meter.videoId, target).then(() => {
      meter.sent = Math.max(meter.sent, target)
      meter.retryAt = 0
      setUsageError('')
      onCharged()
    }).catch(failure => {
      meter.retryAt = Date.now() + 5000
      const code = String(failure)
      if (code === 'signed_out') requestSignIn()
      setUsageError(code === 'insufficient_credit' ? 'Đã hết phút sử dụng. Hãy nạp thêm để tiếp tục xem.' : code === 'signed_out' ? 'Hãy đăng nhập để tiếp tục xem video.' : 'Chưa trừ được phút xem. VietNote sẽ thử lại khi video tiếp tục.')
    }).finally(() => {
      meter.charging = false
      const pending = meter.pendingForce
      meter.pendingForce = false
      if (pending) flushUsage(meter, true)
    })
  }

  const translate = async (index: number) => {
    const state = job.current
    const { plan: token, video } = state
    const seek = state.parts.get(index)
    const partIndex = seek?.order.find(at => !seek.parts[at].done && seek.parts[at].tries < TRIES)
    const part = partIndex === undefined ? null : seek!.parts[partIndex]
    const batch = part?.batch ?? state.batches[index]
    if (!video || !batch || (seek && !part) || (part?.retryAt ?? state.retryAt.get(index) ?? 0) > Date.now()) return
    state.running.add(index)
    // The sentences just before give the model context for the first lines.
    const before = [
      ...(state.result[index - 1] ?? state.batches[index - 1]?.draft ?? []),
      ...(seek && partIndex !== undefined ? seek.parts.slice(0, partIndex).flatMap(item => item.result ?? item.batch.draft) : []),
    ].slice(-3).map(line => line.source)
    try {
      const lines = batch.words
        ? speechLines(batch.words, await desktop.translateSpeech(batch.words.map(word => word.text), video.language, before))
        : await desktop.translateCaptions(batch.draft.map(line => line.source), video.language, before).then(texts => batch.draft.map((line, at) => ({ ...line, translation: texts[at] || undefined })))
      if (state.plan !== token) return
      if (part && seek) {
        part.result = lines; part.done = true
        state.result[index] = seek.parts.flatMap(item => item.result ?? item.batch.draft)
        if (seek.parts.every(item => item.done)) { state.done.add(index); state.parts.delete(index) }
      } else { state.done.add(index); state.result[index] = lines; state.retryAt.delete(index) }
      setTranslated({ ...state.result }); setDone(state.done.size)
      setTranslateError('')
    } catch (failure) {
      if (state.plan !== token) return
      const message = String(failure)
      const tries = part ? ++part.tries : (state.tries.get(index) ?? 0) + 1
      if (!part) state.tries.set(index, tries)
      if (stops(message)) { state.stopped = true; setTranslateError(message) }
      else if (tries >= TRIES) {
        if (part && seek) {
          part.done = true; part.result = part.batch.draft
          state.result[index] = seek.parts.flatMap(item => item.result ?? item.batch.draft)
          if (seek.parts.every(item => item.done)) { state.done.add(index); state.parts.delete(index) }
          setTranslated({ ...state.result }); setDone(state.done.size)
        }
        setTranslateError('Có đoạn chưa dịch được, phụ đề gốc được hiện thay.')
      }
      else {
        if (part) part.retryAt = Date.now() + 2900
        else state.retryAt.set(index, Date.now() + 2900)
        setTimeout(() => {
          if (state.plan !== token || state.stopped) return
          if (state.current === index && state.parts.has(index) && !state.running.has(index)) void translate(index)
          pump()
        }, 3000)
      }
    } finally {
      if (state.plan === token) {
        state.running.delete(index)
        // Keep the just-sought batch moving even if two old batches still occupy the normal slots.
        if (state.current === index && state.parts.has(index) && state.running.size >= PARALLEL && !state.stopped) void translate(index)
        pump()
      }
    }
  }

  /** Starts the next batches: the one being watched, those just after it, then the one before. */
  function pump() {
    const state = job.current
    if (state.stopped || state.pendingSeek !== null) return
    for (const index of batchOrder(Math.min(state.batches.length, state.current + AHEAD + 1), state.current)) {
      if (state.running.size >= PARALLEL) break
      if (index < state.current - 1) break
      if (state.done.has(index) || state.running.has(index) || (state.tries.get(index) ?? 0) >= TRIES || (state.retryAt.get(index) ?? 0) > Date.now()) continue
      void translate(index)
    }
  }

  /** Shows a video's subtitles from its words, dropping any earlier ones and their translations. */
  const show = (video: WatchVideo | null, pieces: CaptionPiece[]) => {
    const state = job.current
    if (state.seekTimer) clearTimeout(state.seekTimer)
    state.plan++
    const planned = video ? planBatches({ pieces, kind: video.kind, language: video.language }) : []
    Object.assign(state, { video, batches: planned, result: {}, done: new Set(), running: new Set(), tries: new Map(), retryAt: new Map(), parts: new Map(), pendingSeek: null, seekTimer: null, current: batchAt(planned, position.current), stopped: false })
    planned.forEach((batch, index) => { if (!batch.words && batch.draft.every(line => line.translation !== undefined)) state.done.add(index) })
    if (position.current > 2 && planned[state.current] && !state.done.has(state.current)) {
      const split = seekSlices(planned[state.current], position.current)
      if (split && split.parts.length > 1) state.parts.set(state.current, seekPlan(split))
    }
    setVideo(video); setBatches(planned); setTranslated({}); setDone(state.done.size); setTranslateError('')
    pump()
  }

  const load = async (url: string) => {
    const state = job.current
    const token = ++state.token
    stopListening()
    flushUsage(usage.current, true)
    position.current = Number(/[?&]t=(\d+)/.exec(url)?.[1] ?? 0)
    show(null, []); setError('')
    const id = youtubeId(url)
    if (!id) { setPhase('error'); setError(loadError('not_youtube')); return }
    usage.current = usageMeter(id); setUsageError('')
    setPhase('loading')
    try {
      const { pieces, ...captions } = await desktop.youtubeCaptions(url)
      if (state.token !== token) return
      show({ ...captions, url }, pieces); setPhase('ready')
    } catch (failure) {
      if (state.token !== token) return
      setPhase('error'); setError(loadError(failure))
    }
  }

  /** The player reports where it is; translation moves there when the viewer skips ahead or back. */
  const watching = (time: number, isPlaying = false) => {
    const previous = position.current
    position.current = time
    const state = job.current
    const elapsed = billablePlayback(previous, time, isPlaying, state.video?.kind)
    // Caption videos are charged by actual forward playback. Seeking and the fully
    // processed "heard" path are excluded; the latter is already charged by file-job.
    const meter = usage.current
    if (elapsed > 0) {
      meter.total += elapsed
      flushUsage()
    } else if (!isPlaying && meter.playing) flushUsage(meter, true)
    meter.playing = isPlaying
    const current = batchAt(state.batches, time)
    const changed = current !== state.current
    state.current = current
    if (Math.abs(time - previous) > 2) {
      if (state.seekTimer) clearTimeout(state.seekTimer)
      state.pendingSeek = null; state.seekTimer = null
      if (state.batches[current] && !state.done.has(current) && !state.running.has(current) && !state.parts.has(current)) {
        const token = state.plan
        state.pendingSeek = current
        state.seekTimer = setTimeout(() => {
          if (state.plan !== token) return
          state.seekTimer = null; state.pendingSeek = null
          if (state.current === current && !state.done.has(current) && !state.running.has(current)) {
            const split = seekSlices(state.batches[current], position.current)
            if (split && split.parts.length > 1) {
              state.parts.set(current, seekPlan(split))
              void translate(current) // Urgent request may run while earlier batches finish.
            }
          }
          pump()
        }, SEEK_SETTLE_MS)
        return
      }
    }
    if (changed) pump()
  }

  /**
   * Hears the video: fetches its audio, has it transcribed (charged like a file), then shows
   * subtitles from the words heard in place of the captions.
   */
  const listen = async () => {
    const state = job.current
    const video = state.video
    if (!video || state.listenJob !== null || listening) return
    if (!await desktop.accountSignedIn().catch(() => false)) { requestSignIn(); return }
    const run = ++state.listen
    const current = () => state.listen === run
    let audio: AudioFile | null = null
    let uploaded = false
    setListenError(''); setListening({ stage: 'fetching', percent: 0 })
    try {
      state.fetching = true
      audio = await desktop.fetchLinkAudio(video.url, progress => { if (current()) setListening({ stage: 'fetching', percent: progress.stage === 'downloading' ? progress.percent : 0 }) })
        .finally(() => { if (current()) state.fetching = false })
      if (!current()) return
      setListening({ stage: 'uploading', percent: 0 })
      const started = await desktop.fileJobStart(audio.name, audio.durationSeconds ?? video.duration, 'watch')
      state.listenJob = started.job_id
      onCharged()
      const language = ['en', 'zh', 'vi'].includes(video.language) ? video.language as 'en' | 'zh' | 'vi' : 'auto'
      await desktop.fileJobUpload(started.job_id, audio.path, language, false, percent => { if (current()) setListening({ stage: 'uploading', percent }) })
      uploaded = true
      if (!current()) return
      setListening({ stage: 'processing', percent: 0 })
      let result: FileJobStatus
      for (;;) {
        result = await desktop.fileJobStatus(started.job_id)
        if (!current()) return
        if (result.status === 'completed' || result.status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
      }
      state.listenJob = null
      onCharged()
      if (result.status === 'failed') throw new Error(result.error ?? 'transcription_failed')
      // The words are on screen now; the service's copy can go.
      void desktop.fileJobCleanup(started.job_id).catch(() => {})
      const heard = heardWords(result.tokens ?? [])
      if (!heard.pieces.length) throw new Error('Không nghe thấy lời nói nào trong video này.')
      if (!current() || state.video !== video) return
      setListening(null)
      show({ ...video, kind: 'heard', language: heard.language }, heard.pieces)
    } catch (failure) {
      if (!current()) return
      // Minutes held for an upload that never arrived are given back.
      if (state.listenJob && !uploaded) void desktop.fileJobCancel(state.listenJob).catch(() => {}).finally(onCharged)
      state.listenJob = null
      const code = failure instanceof Error ? failure.message : String(failure)
      setListening(null)
      setListenError(code === 'cancelled' ? '' : audio ? errorText(failure, audio) : linkErrorText(failure))
    }
  }

  /** Stops hearing the video; minutes held for it are given back. */
  function stopListening() {
    const state = job.current
    state.listen++
    // Only our own fetch: the file page may be fetching another link.
    if (state.fetching) void desktop.cancelLinkAudio().catch(() => {})
    state.fetching = false
    if (state.listenJob) void desktop.fileJobCancel(state.listenJob).catch(() => {}).finally(onCharged)
    state.listenJob = null
    setListening(null); setListenError('')
  }

  const close = () => {
    job.current.token++
    stopListening()
    flushUsage(usage.current, true)
    usage.current = usageMeter()
    show(null, []); setPhase('idle'); setError('')
  }
  /** After an account problem is fixed (signed in, topped up), carry on translating. */
  const retry = () => { job.current.stopped = false; job.current.tries.clear(); setTranslateError(''); pump() }

  /** Where translation has got to, in batches. */
  const progress = { done, total: batches.length }

  return { phase, video, lines, progress, error, translateError, listening, listenError, usageError, load, close, retry, watching, listen, stopListening, position }
}
export type Watch = ReturnType<typeof useWatch>
