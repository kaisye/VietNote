import { useEffect, useRef, useState } from 'react'
import { desktop, type VoicePackProgress, type VoicePackStatus } from '../services/desktop'
import { createPhraseReader } from '../services/speechChunks'
import type { AudioChunk, WorkerMessage } from '../services/types'

export type SpeechState = 'off' | 'loading' | 'ready' | 'error'
export const speechRates = [1, 1.15, 1.25, 1.4] as const
export type SpeechVoice = 'auto' | 'female' | 'male'
/** Bundled ZeroTTS voices: clear newsreader voices keep up best with live speech. 'auto' lets
 * the worker match each speaker's voice from their pitch. */
const voiceIds: Record<SpeechVoice, string> = { auto: 'auto', female: 'baotrang', male: 'quangminh' }
/** `stream` reads each finalized phrase right away; `sentence` waits for the whole sentence. */
export type SpeechMode = 'stream' | 'sentence'
export const modeOptions: { value: SpeechMode; label: string }[] = [{ value: 'stream', label: 'Theo cụm · nhanh' }, { value: 'sentence', label: 'Cả câu · tự nhiên' }]
export const voiceOptions: { value: SpeechVoice; label: string }[] = [{ value: 'auto', label: 'Theo người nói' }, { value: 'female', label: 'Giọng nữ' }, { value: 'male', label: 'Giọng nam' }]

/** Speech queued past this falls behind the video; the newest line replaces it. */
const MAX_BACKLOG_SECONDS = 5
/** Buffered before the first chunk plays, so a slow chunk does not stutter. */
const PREBUFFER_SECONDS = 0.25

/** What the voice is saying now: its line, and that line's translation read out so far. */
export interface Voiced { id: string; text: string }
const chunkSeconds = (chunk: AudioChunk) => chunk.pcm.length * 3 / 4 / 4 / chunk.sampleRate
/**
 * When each request in a batch starts to sound, in seconds from now: the batch was just queued
 * behind whatever is still playing, and `queued` is everything left to play, at `rate`.
 */
export function firstSounds(batch: { key: string; chunk: AudioChunk }[], queued: number, rate: number): Map<string, number> {
  const starts = new Map<string, number>()
  let at = queued - batch.reduce((total, item) => total + chunkSeconds(item.chunk), 0) / rate
  for (const item of batch) {
    if (!starts.has(item.key)) starts.set(item.key, Math.max(0, at))
    at += chunkSeconds(item.chunk) / rate
  }
  return starts
}

const savedRate = () => {
  try {
    const value = Number(localStorage.getItem('ttsPlaybackRate'))
    return (speechRates as readonly number[]).includes(value) ? value : 1.15
  } catch { return 1.15 }
}
const savedVoice = (): SpeechVoice => {
  try { const value = localStorage.getItem('ttsVoice'); return value === 'male' || value === 'female' ? value : 'auto' } catch { return 'auto' }
}
const savedMode = (): SpeechMode => { try { return localStorage.getItem('ttsMode') === 'sentence' ? 'sentence' : 'stream' } catch { return 'stream' } }
const savedEnabled = () => { try { return localStorage.getItem('speakTranslation') === 'true' } catch { return false } }

/**
 * Reads live Vietnamese translations aloud with the local ZeroTTS voice. The worker
 * loads the model only while this is on; audio plays natively so the system-audio
 * capture does not hear it again.
 */
export function useSpeech(currentGeneration: () => number) {
  const [enabled, setEnabledState] = useState(savedEnabled)
  // Until the worker says otherwise there is no voice to offer.
  const [runtime, setRuntime] = useState(false)
  const runtimeRef = useRef(false)
  // The voice itself is a separate download.
  const [pack, setPack] = useState<VoicePackStatus | null>(null)
  const packRef = useRef<VoicePackStatus | null>(null)
  const [progress, setProgress] = useState<VoicePackProgress | null>(null)
  const [packError, setPackError] = useState('')
  const publishPack = (value: VoicePackStatus) => { packRef.current = value; setPack(value) }
  const installed = () => Boolean(runtimeRef.current && packRef.current?.path)
  const [state, setState] = useState<SpeechState>('off')
  const [message, setMessage] = useState('')
  const [rate, setRateState] = useState(savedRate)
  const [voice, setVoiceState] = useState(savedVoice)
  const voiceRef = useRef(voice)
  const [mode, setModeState] = useState(savedMode)
  const modeRef = useRef(mode)
  const phrases = useRef(createPhraseReader())
  const enabledRef = useRef(enabled)
  const stateRef = useRef<SpeechState>('off')
  const rateRef = useRef(rate)
  const staged = useRef<{ key: string; chunk: AudioChunk }[]>([])
  const stagedSeconds = useRef(0)
  const playing = useRef(false)
  // Text sent to the voice, by request, until its first sound plays.
  const requests = useRef(new Map<string, { line: string; part: number; text: string; timed?: boolean }>())
  const readSoFar = useRef(new Map<string, string>())
  const cues = useRef<ReturnType<typeof setTimeout>[]>([])
  const [voiced, setVoiced] = useState<Voiced | null>(null)

  /** Queued sound was dropped: so are the captions waiting for it. */
  const dropCues = () => {
    cues.current.forEach(clearTimeout); cues.current = []
    for (const [key, request] of requests.current) if (request.timed) requests.current.delete(key)
  }
  const clear = () => {
    staged.current = []; stagedSeconds.current = 0; playing.current = false; phrases.current.clear()
    dropCues(); requests.current.clear(); readSoFar.current.clear(); setVoiced(null)
    void desktop.stopAudio().catch(() => {})
  }
  /** Shows a request's text as its first sound plays. */
  const cue = (key: string) => {
    const request = requests.current.get(key)
    requests.current.delete(key)
    if (!request) return
    const before = request.part > 0 ? readSoFar.current.get(request.line) : undefined
    const text = before ? `${before} ${request.text}` : request.text
    readSoFar.current.set(request.line, text)
    if (readSoFar.current.size > 50) readSoFar.current.delete(readSoFar.current.keys().next().value!)
    setVoiced({ id: request.line, text })
  }
  const flush = async (end = false) => {
    if (!staged.current.length && !end) return
    const batch = staged.current
    staged.current = []; stagedSeconds.current = 0; playing.current = true
    const queued = await desktop.playAudio(batch.map(item => item.chunk), rateRef.current, end).catch(error => { setMessage(`Không phát được âm thanh: ${error}`); return null })
    if (queued === null) return
    // Each request's caption waits for its first sound.
    for (const [key, seconds] of firstSounds(batch, queued, rateRef.current)) {
      const request = requests.current.get(key)
      if (!request || request.timed) continue
      request.timed = true
      cues.current.push(setTimeout(() => cue(key), seconds * 1000))
    }
  }

  const load = () => {
    if (!installed()) return
    void desktop.sendWorker({ type: 'tts_enable', voice: voiceIds[voiceRef.current], model_dir: packRef.current?.path }).catch(() => {})
  }
  useEffect(() => {
    if (!desktop.isDesktop) return
    void desktop.voicePackStatus().then(status => {
      publishPack(status)
      if (status.downloading) setProgress({ downloaded: status.partialBytes, total: status.sizeBytes, unpacking: false })
      fetchInBackground()
    }).catch(() => {})
    const unlisten = desktop.onVoicePackDownload(setProgress)
    return () => { void unlisten.then(stop => stop()) }
  }, [])
  const fetching = useRef(false)
  // Set when someone turned reading on before the voice arrived: switch it on once it does.
  const wanted = useRef(false)
  const triedInBackground = useRef(false)
  /** Fetches the voice. A background fetch stays silent; one asked for turns reading on after. */
  const download = async (background = false) => {
    if (!background) { wanted.current = true; setPackError('') }
    if (fetching.current) return
    fetching.current = true
    setProgress({ downloaded: packRef.current?.partialBytes ?? 0, total: packRef.current?.sizeBytes ?? 0, unpacking: false })
    try {
      publishPack(await desktop.downloadVoicePack())
      setProgress(null)
      if (wanted.current) { wanted.current = false; setEnabled(true) }
    } catch (error) {
      setProgress(null)
      // An interrupted download resumes next time; only someone waiting for it hears why.
      if (wanted.current) setPackError(String(error))
      void desktop.voicePackStatus().then(publishPack).catch(() => {})
    } finally { fetching.current = false }
  }
  /** Fetched quietly once per launch, so the voice is ready by the time anyone turns reading on. */
  const fetchInBackground = () => {
    const status = packRef.current
    if (triedInBackground.current || !runtimeRef.current || !status?.available || status.path || status.downloading) return
    triedInBackground.current = true
    void download(true)
  }
  const cancelDownload = () => { wanted.current = false; void desktop.cancelVoicePackDownload().catch(() => {}) }
  const setEnabled = (value: boolean) => {
    if (value && !installed()) { if (runtimeRef.current && packRef.current?.available) void download(); return }
    enabledRef.current = value; setEnabledState(value)
    try { localStorage.setItem('speakTranslation', String(value)) } catch { /* private window */ }
    if (value) load()
    else { clear(); if (!heldRef.current) void desktop.sendWorker({ type: 'tts_disable' }).catch(() => {}) }
  }
  /** Set while something other than live reading (a dubbed video) needs the voice loaded. */
  const heldRef = useRef(false)
  const hold = (value: boolean) => {
    if (heldRef.current === value) return
    heldRef.current = value
    if (value) { if (stateRef.current !== 'ready' && stateRef.current !== 'loading') load() }
    else if (!enabledRef.current) void desktop.sendWorker({ type: 'tts_disable' }).catch(() => {})
  }
  /** Reads `text` for someone other than live reading; its audio comes back under `id`. */
  const synthesize = (id: string, text: string) => {
    if (!installed() || stateRef.current !== 'ready' || !text.trim()) return false
    void desktop.sendWorker({ type: 'synthesize', id, generation: currentGeneration(), text, speaker: null }).catch(() => {})
    return true
  }
  const setRate = (value: number) => {
    rateRef.current = value; setRateState(value)
    try { localStorage.setItem('ttsPlaybackRate', String(value)) } catch { /* private window */ }
  }

  /** A restarted worker forgets the voice; load it again if speech is on. */
  const onConnected = (canSpeak: boolean) => {
    runtimeRef.current = canSpeak; setRuntime(canSpeak)
    if (enabledRef.current || heldRef.current) load()
    fetchInBackground()
  }
  /** Picking a voice also turns speech on: that is what the choice is for. */
  const setVoice = (value: SpeechVoice) => {
    voiceRef.current = value; setVoiceState(value)
    try { localStorage.setItem('ttsVoice', value) } catch { /* private window */ }
    if (enabledRef.current) load()
    else setEnabled(true)
  }

  const speak = (id: string, generation: number, text: string, speaker?: string) => {
    if (!installed() || !enabledRef.current || stateRef.current !== 'ready' || !text.trim()) return
    // Phrase keys are `line#offset`; a whole sentence or paragraph is keyed by its own id.
    const [, line = id, offset] = /^(.*)#(\d+)$/.exec(id) ?? []
    requests.current.set(id, { line, part: Number(offset ?? 0), text: text.trim() })
    void desktop.sendWorker({ type: 'synthesize', id, generation, text, speaker: speaker ?? null }).catch(() => {})
  }
  const setMode = (value: SpeechMode) => {
    modeRef.current = value; setModeState(value); phrases.current.clear()
    try { localStorage.setItem('ttsMode', value) } catch { /* private window */ }
  }
  /** Called with every live translation update; reads phrases or whole sentences per the mode. */
  const translation = (id: string, generation: number, stable: string, text: string, final: boolean, speaker?: string) => {
    if (!enabledRef.current || stateRef.current !== 'ready') return
    if (modeRef.current === 'sentence') { if (final) speak(id, generation, text, speaker); return }
    const phrase = phrases.current.next(id, stable, text, final)
    if (phrase) speak(phrase.key, generation, phrase.text, speaker)
  }

  /** Returns true when the message was a speech message. */
  const handle = (message: WorkerMessage) => {
    switch (message.type) {
      case 'tts_status': {
        const next = (message.state ?? 'off') as SpeechState
        stateRef.current = next; setState(next)
        // The worker's detail (model paths, runtime errors) goes to its log, not on screen.
        setMessage(next === 'error' ? 'Không tải được giọng đọc · hãy thử bật lại' : '')
        return true
      }
      case 'tts_begin':
        // A new line while the last ones are still queued: jump to it instead of lagging further.
        // After silence, buffer a little again before the first chunk plays.
        if (message.generation === currentGeneration() && enabledRef.current && playing.current) {
          void desktop.playAudio([], rateRef.current).then(queued => {
            if (queued > MAX_BACKLOG_SECONDS) { dropCues(); void desktop.stopAudio() }
            else if (queued === 0 && !staged.current.length) playing.current = false
          }).catch(() => {})
        }
        return true
      case 'tts_audio': {
        if (!enabledRef.current || message.generation !== currentGeneration() || !message.pcm) return true
        const chunk: AudioChunk = { pcm: message.pcm, format: 'f32', sampleRate: message.sample_rate ?? 48000 }
        staged.current.push({ key: message.id ?? '', chunk })
        stagedSeconds.current += chunkSeconds(chunk)
        if (playing.current || stagedSeconds.current >= PREBUFFER_SECONDS) void flush()
        return true
      }
      case 'tts_end':
        if (message.generation === currentGeneration()) void flush(true)
        return true
      case 'tts_skipped': if (message.id) requests.current.delete(message.id); return true
      case 'tts_error': setMessage('Giọng đọc tạm thời lỗi, đang tiếp tục với câu sau'); return true
    }
    return false
  }

  const ready = runtime && Boolean(pack?.path)
  return { available: runtime && Boolean(pack?.available), installed: ready, sizeBytes: pack?.sizeBytes ?? 0, progress, packError, download, cancelDownload,
    enabled: enabled && ready, setEnabled, hold, synthesize, state, message, rate, setRate, voice, setVoice, mode, setMode, translation, speak, handle, clear, onConnected, voiced }
}
export type Speech = ReturnType<typeof useSpeech>
