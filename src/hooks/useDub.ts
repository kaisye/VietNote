import { useRef, useState } from 'react'
import { desktop } from '../services/desktop'
import { dubRate, dubbable, type WatchLine } from '../services/youtube'
import type { AudioChunk, WorkerMessage } from '../services/types'
import type { Speech } from './useSpeech'

/** The video's own sound while it is dubbed, in percent: the voice and music stay faintly audible. */
export const DUB_VOLUME = 20
/** Lines read aloud this far ahead of the video, in seconds. */
const AHEAD = 45
/** Lines read at once; the voice also serves live reading, so it is not flooded. */
const IN_FLIGHT = 2
/** A request with no answer by then is given up (the voice restarted or was reset). */
const GIVE_UP_MS = 20_000
/** A line reached more than this late (after a skip) is left out rather than read out of step. */
const LATE = 0.8

interface Voice { chunks: AudioChunk[]; seconds: number; done: boolean; failed: boolean }
const PREFIX = 'dub:'
const chunkSeconds = (chunk: AudioChunk) => chunk.pcm.length * 3 / 4 / 4 / chunk.sampleRate
const keyOf = (line: WatchLine) => `${line.start.toFixed(2)}|${line.translation}`
const savedOn = () => { try { return localStorage.getItem('watchDub') === 'true' } catch { return false } }

/**
 * Dubs a video in Vietnamese: each translated line is read aloud ahead of time, then played
 * as its words are spoken, sped up when the Vietnamese runs longer than the original.
 */
export function useDub(speech: Speech) {
  const [on, setOnState] = useState(savedOn)
  const onRef = useRef(on)
  const voices = useRef(new Map<string, Voice>())
  const requests = useRef(new Map<string, { key: string; at: number }>())
  const played = useRef(new Set<string>())
  const last = useRef({ time: -1, playing: false })
  const counter = useRef(0)

  const silence = () => { void desktop.stopAudio().catch(() => {}) }
  const setOn = (value: boolean) => {
    onRef.current = value; setOnState(value)
    try { localStorage.setItem('watchDub', String(value)) } catch { /* private window */ }
    if (!value) silence()
  }
  /** Forgets every line, e.g. for another video. */
  const reset = () => { voices.current.clear(); requests.current.clear(); played.current.clear(); last.current = { time: -1, playing: false }; silence() }

  /** Reads the next lines ahead of `time`, a few at a time, and drops those long past. */
  const prepare = (lines: WatchLine[], time: number) => {
    const now = Date.now()
    for (const [id, request] of requests.current) if (now - request.at > GIVE_UP_MS) { requests.current.delete(id); voices.current.delete(request.key) }
    for (const [key] of voices.current) if (Number(key.split('|')[0]) < time - 30) voices.current.delete(key)
    for (const line of lines) {
      if (requests.current.size >= IN_FLIGHT || line.start > time + AHEAD) break
      if (line.start < time - LATE || !dubbable(line)) continue
      const key = keyOf(line)
      if (voices.current.has(key)) continue
      const id = `${PREFIX}${++counter.current}`
      if (!speech.synthesize(id, line.translation!)) break
      voices.current.set(key, { chunks: [], seconds: 0, done: false, failed: false })
      requests.current.set(id, { key, at: now })
    }
  }

  /** The player's position, several times a second: reads ahead, and plays the line now due. */
  const tick = (lines: WatchLine[], time: number, playing: boolean) => {
    const before = last.current
    last.current = { time, playing }
    if (!onRef.current) return
    const skipped = before.time >= 0 && (time < before.time - 0.5 || time > before.time + 2)
    // Paused or skipped: what was being said no longer fits the picture.
    if ((before.playing && !playing) || skipped) { silence(); played.current.clear() }
    prepare(lines, time)
    if (!playing) return
    let index = -1
    for (let at = 0; at < lines.length && lines[at].start <= time + 0.05; at++) index = at
    const line = lines[index]
    if (!line || time - line.start > LATE || !dubbable(line)) return
    const key = keyOf(line)
    const voice = voices.current.get(key)
    if (!voice?.done || voice.failed || played.current.has(key)) return
    played.current.add(key)
    const next = lines[index + 1]
    const rate = dubRate(voice.seconds, (next?.start ?? line.end + 1.5) - time)
    void desktop.playAudio(voice.chunks, rate, true).catch(() => {})
  }

  /** Takes the voice's answers to our requests; returns true when the message was one. */
  const handle = (message: WorkerMessage) => {
    const id = message.id
    if (!id?.startsWith(PREFIX)) return false
    const request = requests.current.get(id)
    const voice = request && voices.current.get(request.key)
    if (!request || !voice) return true
    if (message.type === 'tts_audio' && message.pcm) {
      const chunk: AudioChunk = { pcm: message.pcm, format: 'f32', sampleRate: message.sample_rate ?? 48000 }
      voice.chunks.push(chunk); voice.seconds += chunkSeconds(chunk)
    } else if (message.type === 'tts_end') { voice.done = true; requests.current.delete(id) }
    else if (message.type === 'tts_skipped' || message.type === 'tts_error') { voice.failed = true; voice.done = true; requests.current.delete(id) }
    return true
  }

  return { on, setOn, tick, handle, reset }
}
export type Dub = ReturnType<typeof useDub>
