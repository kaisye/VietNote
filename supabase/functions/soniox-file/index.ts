// Transcribes a recorded file with Soniox's async API against the caller's credit.
// A file second costs FILE_RATE of a streaming second.
//   POST {action:"start", filename, estimated_seconds?}   -> {job_id, reserved_seconds, balance_seconds}
//   POST ?action=upload&job_id=&language=&translate=1    (raw file body) -> {status:"processing"}
//   POST {action:"status", job_id}  -> {status:"processing"} | {status:"completed", tokens, audio_seconds, charged_seconds} | {status:"failed", error}
//   POST {action:"cleanup", job_id} -> deletes the transcript at Soniox once the app saved it
//   POST {action:"cancel", job_id}  -> stops the job and refunds it if it was not charged yet
import { admin, json, SONIOX_API, sonioxKey } from '../_shared/credits.ts'

const FILE_RATE = 0.75
// Soniox caps a file at 300 minutes.
const MAX_FILE_SECONDS = 300 * 60
const MIN_RESERVE = 60
const HINTS: Record<string, string[]> = { vi: ['vi', 'en'], en: ['en'], zh: ['zh'], auto: ['vi', 'en', 'zh'] }

type Job = { id: string; user_id: string; status: string; reserved_seconds: number; charged_seconds: number | null; audio_seconds: number | null; soniox_file_id: string | null; transcription_id: string | null; error: string | null }

const soniox = (path: string, init: RequestInit = {}) =>
  fetch(`${SONIOX_API}${path}`, { ...init, headers: { Authorization: `Bearer ${sonioxKey()}`, ...(init.headers ?? {}) } })

/** Wraps the request body in a multipart form without buffering it: files can be hundreds of MB. */
function multipart(body: ReadableStream<Uint8Array>, filename: string) {
  const boundary = crypto.randomUUID().replaceAll('-', '')
  const encoder = new TextEncoder()
  const safe = filename.replace(/["\r\n]/g, '_').slice(0, 200) || 'audio'
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const reader = body.getReader()
  let started = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) { started = true; controller.enqueue(head); return }
      const { done, value } = await reader.read()
      if (done) { controller.enqueue(tail); controller.close() } else controller.enqueue(value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
  return { stream, contentType: `multipart/form-data; boundary=${boundary}` }
}

async function forget(job: Job) {
  if (job.soniox_file_id) await soniox(`/files/${job.soniox_file_id}`, { method: 'DELETE' }).catch(() => {})
  if (job.transcription_id) await soniox(`/transcriptions/${job.transcription_id}`, { method: 'DELETE' }).catch(() => {})
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const db = admin()
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const { data: auth, error: authError } = await db.auth.getUser(token)
  if (authError || !auth.user) return json({ error: 'unauthorized' }, 401)
  const user = auth.user
  const url = new URL(request.url)
  const upload = url.searchParams.get('action') === 'upload'
  const body = upload ? {} : await request.json().catch(() => ({})) as { action?: string; job_id?: string; filename?: string; estimated_seconds?: number }
  const action = upload ? 'upload' : body.action
  const jobId = upload ? url.searchParams.get('job_id') : body.job_id

  if (action === 'start') {
    // A job reserved but never uploaded (the app quit mid-upload) gives its credit back.
    const { data: stale } = await db.from('file_jobs').select('id').eq('user_id', user.id).eq('status', 'reserved')
      .lt('created_at', new Date(Date.now() - 2 * 3600_000).toISOString())
    for (const { id } of stale ?? []) await db.rpc('refund_file_job', { p_job: id, p_status: 'cancelled' })
    const { data: profile } = await db.from('profiles').select('balance_seconds').eq('id', user.id).single()
    const balance = profile?.balance_seconds ?? 0
    const estimate = Number(body.estimated_seconds)
    // Reserve what the estimated length costs plus a little slack; without an
    // estimate hold what is left (up to the longest file) and settle afterwards.
    const need = Number.isFinite(estimate) && estimate > 0
      ? Math.max(MIN_RESERVE, Math.ceil(Math.min(estimate, MAX_FILE_SECONDS) * FILE_RATE) + 30)
      : Math.max(MIN_RESERVE, Math.min(balance, Math.ceil(MAX_FILE_SECONDS * FILE_RATE)))
    const { data, error } = await db.rpc('reserve_file_job', { p_user: user.id, p_need: need, p_filename: String(body.filename ?? '').slice(0, 300) })
    if (error) {
      if (error.message.includes('insufficient_credit')) return json({ error: 'insufficient_credit', needed_seconds: need, balance_seconds: balance }, 402)
      return json({ error: 'reserve_failed' }, 500)
    }
    const job = (data as { job_id: string; reserved_seconds: number; balance_seconds: number }[])[0]
    return json(job)
  }

  if (!jobId) return json({ error: 'job_id_required' }, 400)
  const { data: found } = await db.from('file_jobs').select('*').eq('id', jobId).eq('user_id', user.id).maybeSingle()
  const job = found as Job | null
  if (!job) return json({ error: 'job_missing' }, 404)

  if (action === 'upload') {
    if (job.status !== 'reserved' || !request.body) return json({ error: 'job_not_ready' }, 409)
    const filename = decodeURIComponent(request.headers.get('x-filename') ?? 'audio')
    try {
      const form = multipart(request.body, filename)
      const uploaded = await soniox('/files', { method: 'POST', body: form.stream, headers: { 'Content-Type': form.contentType }, duplex: 'half' } as RequestInit)
      if (!uploaded.ok) throw new Error(`upload_${uploaded.status}`)
      const file = await uploaded.json() as { id: string }
      await db.from('file_jobs').update({ soniox_file_id: file.id }).eq('id', job.id)
      job.soniox_file_id = file.id
      const language = url.searchParams.get('language') ?? 'auto'
      const created = await soniox('/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'stt-async-v5', file_id: file.id,
          language_hints: HINTS[language] ?? HINTS.auto,
          enable_language_identification: true, enable_speaker_diarization: true,
          client_reference_id: job.id,
          ...(url.searchParams.get('translate') === '1' ? { translation: { type: 'one_way', target_language: 'vi' } } : {}),
        }),
      })
      if (!created.ok) throw new Error(`transcription_${created.status}`)
      const transcription = await created.json() as { id: string }
      await db.from('file_jobs').update({ transcription_id: transcription.id, status: 'processing' }).eq('id', job.id)
      return json({ status: 'processing' })
    } catch (error) {
      await forget(job)
      await db.rpc('refund_file_job', { p_job: job.id, p_status: 'failed', p_error: String(error) })
      return json({ error: 'upload_failed' }, 502)
    }
  }

  if (action === 'status') {
    if (job.status === 'failed' || job.status === 'cancelled') return json({ status: 'failed', error: job.error ?? job.status })
    if (!job.transcription_id) return json({ status: 'uploading' })
    if (job.status === 'processing') {
      const response = await soniox(`/transcriptions/${job.transcription_id}`)
      if (!response.ok) return json({ status: 'processing' })
      const state = await response.json() as { status: string; audio_duration_ms?: number; error_message?: string }
      if (state.status === 'error') {
        await forget(job)
        await db.rpc('refund_file_job', { p_job: job.id, p_status: 'failed', p_error: state.error_message ?? 'soniox_error' })
        return json({ status: 'failed', error: state.error_message ?? 'soniox_error' })
      }
      if (state.status !== 'completed') return json({ status: 'processing' })
      const audio = Math.ceil((state.audio_duration_ms ?? 0) / 1000)
      const { data: charged, error } = await db.rpc('settle_file_job', { p_job: job.id, p_audio_seconds: audio, p_rate: FILE_RATE })
      if (error) return json({ error: 'settle_failed' }, 500)
      job.charged_seconds = charged as number; job.audio_seconds = audio
      // The audio is no longer needed; the transcript stays until the app saved it.
      if (job.soniox_file_id) await soniox(`/files/${job.soniox_file_id}`, { method: 'DELETE' }).catch(() => {})
    }
    const transcript = await soniox(`/transcriptions/${job.transcription_id}/transcript`)
    if (!transcript.ok) return json({ status: 'failed', error: 'transcript_missing' })
    const { tokens } = await transcript.json() as { tokens: { text: string; start_ms: number; end_ms: number; speaker?: string; language?: string; translation_status?: string }[] }
    return json({
      status: 'completed', audio_seconds: job.audio_seconds, charged_seconds: job.charged_seconds,
      // [text, start_ms, end_ms, speaker, language, is_translation]: about half the size of the raw tokens.
      tokens: tokens.map(t => [t.text, t.start_ms, t.end_ms, t.speaker ?? null, t.language ?? null, t.translation_status === 'translation' ? 1 : 0]),
    })
  }

  if (action === 'cleanup') {
    await forget(job)
    await db.from('file_jobs').update({ soniox_file_id: null, transcription_id: null }).eq('id', job.id)
    return json({ ok: true })
  }

  if (action === 'cancel') {
    await forget(job)
    await db.rpc('refund_file_job', { p_job: job.id, p_status: 'cancelled' })
    return json({ ok: true })
  }

  return json({ error: 'unknown_action' }, 400)
})
