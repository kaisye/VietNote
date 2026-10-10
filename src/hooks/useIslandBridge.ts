import { useEffect, useMemo, useRef } from 'react'
import { emitTo, listen } from '@tauri-apps/api/event'
import { desktop } from '../services/desktop'
import { activeSource, islandChat, islandEnabled, islandEvents, islandLines, type IslandAsk, type IslandState } from '../services/island'
import type { AppModel } from './useAppModel'
import type { AudioInput } from '../services/types'
import type { SpeechVoice } from './useSpeech'

/** Emits at most this often while speech streams in. */
const THROTTLE_MS = 80

/**
 * Main-window side of VietNote Island: streams the live transcript and Q&A to the island
 * window and runs the questions and commands it sends back.
 */
export function useIslandBridge(model: AppModel, onStart: () => void) {
  const state = useMemo<IslandState>(() => ({
    active: model.meetingActive || model.capturing,
    capturing: model.capturing,
    status: model.status,
    canStart: model.canStartMeeting && !model.busy && !model.meetingActive && !model.capturing,
    source: model.capturing ? activeSource(model.microphoneOn, model.systemAudioOn) : model.audioInput,
    translation: model.sourceLanguage === 'vi' ? 'unavailable' : model.translateForeign ? 'on' : 'off',
    speech: model.sourceLanguage === 'vi' || !model.speech.installed ? null : { enabled: model.speech.enabled, loading: model.speech.enabled && model.speech.state === 'loading', voice: model.speech.voice },
    lines: islandLines(model.entries, model.interimTranscripts, model.translationBlocks),
    chat: islandChat(model.liveChat.messages, model.liveChat.status),
  }), [model.meetingActive, model.capturing, model.status, model.canStartMeeting, model.busy, model.sourceLanguage, model.translateForeign, model.audioInput, model.speech.installed, model.speech.enabled, model.speech.state, model.speech.voice, model.microphoneOn, model.systemAudioOn, model.entries, model.interimTranscripts, model.translationBlocks, model.liveChat.messages, model.liveChat.status])
  const latest = useRef(state)
  latest.current = state
  const modelRef = useRef(model)
  modelRef.current = model
  const onStartRef = useRef(onStart)
  onStartRef.current = onStart
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentAt = useRef(0)

  const send = () => {
    timer.current = null
    sentAt.current = Date.now()
    void emitTo('island', islandEvents.state, latest.current).catch(() => {})
  }
  useEffect(() => {
    if (!desktop.isDesktop || !islandEnabled() || timer.current) return
    timer.current = setTimeout(send, Math.max(0, THROTTLE_MS - (Date.now() - sentAt.current)))
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!desktop.isDesktop) return
    const subscriptions = [
      listen(islandEvents.hello, () => send()),
      listen<IslandAsk>(islandEvents.ask, event => void modelRef.current.liveChat.ask(event.payload)),
      listen<boolean>(islandEvents.translate, event => modelRef.current.setTranslateForeign(event.payload)),
      listen<boolean>(islandEvents.speech, event => modelRef.current.speech.setEnabled(event.payload)),
      listen<SpeechVoice>(islandEvents.voice, event => modelRef.current.speech.setVoice(event.payload)),
      listen(islandEvents.dismiss, () => modelRef.current.liveChat.dismissError()),
      // Stopping from the island saves the meeting under its suggested name, without the dialog.
      listen(islandEvents.stop, () => {
        const model = modelRef.current
        if (model.busy || !(model.meetingActive || model.capturing)) return
        void model.stop(model.meetingActive ? { title: model.suggestedTitle, groupID: null } : undefined)
      }),
      // Picking a source while recording switches it live; before that it picks the input and starts.
      listen<AudioInput>(islandEvents.source, event => {
        const model = modelRef.current
        if (model.capturing) { void model.setSources(event.payload); return }
        if (!latest.current.canStart) return
        model.setAudioInput(event.payload)
        onStartRef.current()
        void model.startMeeting()
      }),
      listen(islandEvents.start, () => {
        if (!latest.current.canStart) return
        onStartRef.current()
        void modelRef.current.startMeeting()
      }),
    ]
    return () => {
      if (timer.current) clearTimeout(timer.current)
      // A stale id here would block every later update.
      timer.current = null
      subscriptions.forEach(subscription => void subscription.then(unlisten => unlisten()))
    }
  }, [])
}
