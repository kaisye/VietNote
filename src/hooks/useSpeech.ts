import { useRef, useState } from 'react'
import { desktop } from '../services/desktop'
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
  const [available, setAvailable] = useState(false)
  const availableRef = useRef(false)
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
  const staged = useRef<AudioChunk[]>([])
  const stagedSeconds = useRef(0)
  const playing = useRef(false)

  const clear = () => {
    staged.current = []; stagedSeconds.current = 0; playing.current = false; phrases.current.clear()
    void desktop.stopAudio().catch(() => {})
  }
  const flush = async () => {
    if (!staged.current.length) return
    const chunks = staged.current
    staged.current = []; stagedSeconds.current = 0; playing.current = true
    await desktop.playAudio(chunks, rateRef.current).catch(error => { setMessage(`Không phát được âm thanh: ${error}`); return 0 })
  }

  const load = () => void desktop.sendWorker({ type: 'tts_enable', voice: voiceIds[voiceRef.current] }).catch(() => {})
  const setEnabled = (value: boolean) => {
    enabledRef.current = value; setEnabledState(value)
    try { localStorage.setItem('speakTranslation', String(value)) } catch { /* private window */ }
    if (value) load()
    else { clear(); void desktop.sendWorker({ type: 'tts_disable' }).catch(() => {}) }
  }
  const setRate = (value: number) => {
    rateRef.current = value; setRateState(value)
    try { localStorage.setItem('ttsPlaybackRate', String(value)) } catch { /* private window */ }
  }

  /** A restarted worker forgets the voice; load it again if speech is on. */
  const onConnected = (canSpeak: boolean) => {
    availableRef.current = canSpeak; setAvailable(canSpeak)
    if (canSpeak && enabledRef.current) load()
  }
  /** Picking a voice also turns speech on: that is what the choice is for. */
  const setVoice = (value: SpeechVoice) => {
    voiceRef.current = value; setVoiceState(value)
    try { localStorage.setItem('ttsVoice', value) } catch { /* private window */ }
    if (enabledRef.current) load()
    else setEnabled(true)
  }

  const speak = (id: string, generation: number, text: string, speaker?: string) => {
    if (!availableRef.current || !enabledRef.current || stateRef.current !== 'ready' || !text.trim()) return
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
        setMessage(next === 'error' ? message.message ?? 'Không tải được giọng đọc' : '')
        return true
      }
      case 'tts_begin':
        // A new line while the last ones are still queued: jump to it instead of lagging further.
        // After silence, buffer a little again before the first chunk plays.
        if (message.generation === currentGeneration() && enabledRef.current && playing.current) {
          void desktop.playAudio([], rateRef.current).then(queued => {
            if (queued > MAX_BACKLOG_SECONDS) void desktop.stopAudio()
            else if (queued === 0 && !staged.current.length) playing.current = false
          }).catch(() => {})
        }
        return true
      case 'tts_audio': {
        if (!enabledRef.current || message.generation !== currentGeneration() || !message.pcm) return true
        const chunk: AudioChunk = { pcm: message.pcm, format: 'f32', sampleRate: message.sample_rate ?? 48000 }
        staged.current.push(chunk)
        stagedSeconds.current += message.pcm.length * 3 / 4 / 4 / chunk.sampleRate
        if (playing.current || stagedSeconds.current >= PREBUFFER_SECONDS) void flush()
        return true
      }
      case 'tts_end':
        if (message.generation === currentGeneration()) void flush()
        return true
      case 'tts_skipped': return true
      case 'tts_error': setMessage('Giọng đọc tạm thời lỗi, đang tiếp tục với câu sau'); return true
    }
    return false
  }

  return { available, enabled: enabled && available, setEnabled, state, message, rate, setRate, voice, setVoice, mode, setMode, translation, speak, handle, clear, onConnected }
}
export type Speech = ReturnType<typeof useSpeech>
