import { useCallback, useEffect, useRef, useState } from 'react'
import { desktop, type AccountStatus } from '../services/desktop'
import { createNote, demoNote, emptyStructuredSummary, formatStructuredSummary, toTranscriptSegment } from '../services/notes'
import type { AudioInput, Cadence, InterimTranscript, Language, MeetingNote, NoteGroup, SpokenLanguage, StructuredMeetingSummary, Subtitle, TranslationBlock, WorkerMessage } from '../services/types'
import { useNoteChat } from './useNoteChat'
import { useLiveChat } from './useLiveChat'
import { requestSignIn } from '../services/credits'
import { useFileJob } from './useFileJob'
import { useNoteDocuments } from './useNoteDocuments'
import { useSpeech } from './useSpeech'

const now = () => new Date().toISOString()
const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length
const savedLanguage = (): Language => {
  const saved = localStorage.getItem('sourceLanguage')
  return saved === 'vi' || saved === 'en' || saved === 'zh' ? saved : 'auto'
}

const SIGN_IN_STATUS = 'Bấm Đăng nhập ở góc trái dưới để bắt đầu'

function audioIssueText(message?: string) {
  if (message?.startsWith('ASR reconnecting')) return 'Mất kết nối máy chủ nhận diện · đang kết nối lại…'
  if (message?.startsWith('ASR audio queue full')) return 'Mạng chậm · đã bỏ qua một đoạn âm thanh'
  if (message?.startsWith('VietNote credit exhausted')) return 'Đã hết phút sử dụng · xem tài khoản ở góc trái dưới'
  if (message?.startsWith('VietNote signed out')) return 'Phiên đăng nhập đã hết · đăng nhập lại ở góc trái dưới'
  // Raw errors name the speech provider; people only need to know something went wrong.
  if (message) console.error('audio issue', message)
  return 'Đã xảy ra lỗi xử lý âm thanh · đang thử lại'
}

export function useAppModel() {
  const [status, setStatus] = useState('Đang khởi động…')
  // Set while an audio warning is shown so the first recognized speech can clear it.
  const audioIssueRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [diarizationStatus, setDiarizationStatus] = useState('Đang kiểm tra nhận diện người nói…')
  const [diarizationReady, setDiarizationReady] = useState(false)
  const diarizationFlush = useRef<{ id: string; resolve: () => void } | null>(null)
  const [busy, setBusy] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [meetingActive, setMeetingActive] = useState(false)
  const [asrKeyAvailable, setAsrKeyAvailable] = useState(false)
  const [startRequested, setStartRequested] = useState(false)
  // The idle screen hides `status` once the worker is ready, so a failed start needs its own slot.
  const [startError, setStartError] = useState('')
  const [sourceLanguage, setSourceLanguageState] = useState<Language>(savedLanguage)
  const [audioInput, setAudioInputState] = useState<AudioInput>('system')
  const [translateForeign, setTranslateForeignState] = useState(() => localStorage.getItem('translateForeign') !== 'false')
  const [entries, setEntries] = useState<Subtitle[]>([])
  const [interimTranscripts, setInterimTranscripts] = useState<InterimTranscript[]>([])
  const [translationBlocks, setTranslationBlocks] = useState<TranslationBlock[]>([])
  const [overallSummary, setOverallSummary] = useState('')
  const [summaryStatus, setSummaryStatus] = useState('Bản tóm tắt sẽ xuất hiện sau câu nói đầu tiên.')
  const [summaryCadence, setSummaryCadence] = useState<Cadence>('words')
  const [cadenceValue, setCadenceValue] = useState(150)
  const [notes, setNotes] = useState<MeetingNote[]>([demoNote])
  const [noteGroups, setNoteGroups] = useState<NoteGroup[]>([])
  const [savingNoteID, setSavingNoteID] = useState<string | null>(null)
  const [savingNoteGroupID, setSavingNoteGroupID] = useState<string | null>(null)
  const savingNoteIDRef = useRef<string | null>(null)
  const [vietnameseASRStatus, setVietnameseASRStatus] = useState('Đang chuẩn bị nhận diện…')
  const [translationStatus, setTranslationStatus] = useState('Đang chuẩn bị dịch')
  const entriesRef = useRef<Subtitle[]>([])
  const translationBlocksRef = useRef<TranslationBlock[]>([])
  const overallSummaryRef = useRef('')
  const [suggestedTitle, setSuggestedTitle] = useState('')
  const [account, setAccount] = useState<AccountStatus | null>(null)
  const overallStructuredRef = useRef<StructuredMeetingSummary>(emptyStructuredSummary())
  const notesRef = useRef<MeetingNote[]>([demoNote])
  const groupsRef = useRef<NoteGroup[]>([])
  const meetingRef = useRef(false)
  const capturingRef = useRef(false)
  const asrKeyStatusRef = useRef<'checking' | 'available' | 'missing'>('checking')
  const generationRef = useRef(0)
  const speech = useSpeech(() => generationRef.current)
  const languageRef = useRef<Language>(sourceLanguage)
  // Spoken language per utterance id; in auto mode Vietnamese turns get no live translation.
  const spokenLanguageRef = useRef(new Map<string, SpokenLanguage>())
  // Speaker per utterance id, so its translation is read in that speaker's voice.
  const speakerRef = useRef(new Map<string, string>())
  const audioRef = useRef<AudioInput>('system')
  // The microphone and system audio can each be switched off and on while a recording runs.
  const [microphoneOn, setMicrophoneOn] = useState(false)
  const [systemAudioOn, setSystemAudioOn] = useState(false)
  const microphoneRef = useRef(false)
  const systemAudioRef = useRef(false)
  const sourceBusy = useRef(false)
  const cadenceRef = useRef<Cadence>('words')
  const cadenceValueRef = useRef(150)
  const overallSummaryCursor = useRef(0)
  const summaryBusy = useRef(false)
  // Bumped per meeting so a summary still in flight from the previous meeting cannot write into the next one.
  const meetingSessionRef = useRef(0)
  const stoppingRef = useRef(false)
  const summaryTaskRef = useRef<Promise<void> | null>(null)
  const translationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const translationCursorRef = useRef(0)
  const translationContextRef = useRef('')
  const translationIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const translationMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSummaryAt = useRef(Date.now())
  const meetingStartedAt = useRef(Date.now())
  /** A listening session started outside a meeting (the translator page): saved as its own note on stop. */
  const translationSession = useRef<{ startedAt: number; firstEntry: number } | null>(null)
  const generationPending = useRef(false)
  const liveTranslationRef = useRef(false)
  const translateForeignRef = useRef(translateForeign)
  // The switch lives in the meeting UI; the standalone translator always translates.
  const translating = () => languageRef.current !== 'vi' && (!meetingRef.current || translateForeignRef.current)

  const publishEntries = (next: Subtitle[]) => { entriesRef.current = next; setEntries(next) }
  const publishTranslationBlocks = (next: TranslationBlock[]) => { translationBlocksRef.current = next; setTranslationBlocks(next) }
  const publishOverallSummary = (next: string) => { overallSummaryRef.current = next; setOverallSummary(next) }
  const publishStructured = (next: StructuredMeetingSummary) => { overallStructuredRef.current = next; setSuggestedTitle(next.title ?? '') }
  const publishNotes = (nextNotes: MeetingNote[], nextGroups: NoteGroup[]) => {
    notesRef.current = nextNotes; groupsRef.current = nextGroups
    setNotes(nextNotes); setNoteGroups(nextGroups)
  }
  const notesForStorage = (nextNotes: MeetingNote[]) => nextNotes.filter(note => !note.isDemo).map(({ saving: _saving, ...note }) => note)
  const persist = useCallback((nextNotes: MeetingNote[], nextGroups: NoteGroup[]) => {
    notesRef.current = nextNotes; groupsRef.current = nextGroups
    setNotes(nextNotes); setNoteGroups(nextGroups)
    if (desktop.isDesktop) void desktop.saveNotes({ notes: notesForStorage(nextNotes), groups: nextGroups }).catch(error => setStatus(`Không lưu được ghi chú: ${error}`))
  }, [])

  const noteChat = useNoteChat(notesRef, groupsRef, persist)
  const noteDocuments = useNoteDocuments(notesRef, groupsRef, persist)
  const liveChat = useLiveChat(() => ({ title: 'Cuộc họp đang diễn ra', summary: overallSummaryRef.current, entries: entriesRef.current }))

  useEffect(() => {
    if (!desktop.isDesktop) { setStatus('Hãy mở ứng dụng VietNote để sử dụng'); return }
    let disposed = false
    const unlisten: Array<() => void> = []
    void desktop.loadNotes().then(data => { if (!disposed) persist([demoNote, ...data.notes.filter(n => !n.isDemo)], data.groups) }).catch(error => setStatus(`Không đọc được ghi chú: ${error}`))
    const workerEvents = desktop.onWorker(message => { if (!disposed) handleWorkerRef.current(message) }).then(fn => { unlisten.push(fn) })
    const statusEvents = desktop.onStatus(value => { if (!disposed) { setStatus(/loading/i.test(value) ? 'Đang khởi động…' : /closed|exited/i.test(value) ? 'Đã dừng' : /failed|missing/i.test(value) ? 'Không thể khởi động' : value); if (/loading|exited|closed|failed|missing/i.test(value)) { setReady(false); if (/exited|closed|failed|missing/i.test(value)) { setStartRequested(false); setBusy(false) } } } }).then(fn => { unlisten.push(fn) })
    void desktop.accountSignedIn().then(available => {
      if (disposed) return
      asrKeyStatusRef.current = available ? 'available' : 'missing'
      setAsrKeyAvailable(available)
      setStatus(available ? 'Sẵn sàng sử dụng' : SIGN_IN_STATUS)
    }).catch(() => {
      if (disposed) return
      asrKeyStatusRef.current = 'missing'; setAsrKeyAvailable(false)
      setStatus('Đang chuẩn bị nhận diện…')
    })
    // The worker can be ready within milliseconds, so start it only once its messages are heard;
    // a worker that is already running repeats its "connected" message to the new listener.
    void Promise.all([workerEvents, statusEvents]).then(() => desktop.startWorker()).catch(() => setStatus('Không khởi động được dịch vụ nhận diện'))
    return () => { disposed = true; unlisten.forEach(fn => fn()) }
  }, [persist])

  const clearTranslationTimers = () => {
    if (translationIdleTimerRef.current) clearTimeout(translationIdleTimerRef.current)
    if (translationMaxTimerRef.current) clearTimeout(translationMaxTimerRef.current)
    translationIdleTimerRef.current = null; translationMaxTimerRef.current = null
  }
  const resetTranslations = () => {
    clearTranslationTimers(); publishTranslationBlocks([]); liveTranslationRef.current = false; spokenLanguageRef.current.clear(); speakerRef.current.clear()
    translationCursorRef.current = 0; translationContextRef.current = ''; translationQueueRef.current = Promise.resolve()
  }
  const setSourceLanguage = (value: Language) => {
    languageRef.current = value; setSourceLanguageState(value); localStorage.setItem('sourceLanguage', value)
    publishEntries([]); setInterimTranscripts([]); resetTranslations()
  }
  const spokenLanguage = (message: WorkerMessage): SpokenLanguage =>
    message.language ?? (languageRef.current === 'auto' ? 'vi' : languageRef.current)
  const setTranslateForeign = (value: boolean) => {
    translateForeignRef.current = value; setTranslateForeignState(value); localStorage.setItem('translateForeign', String(value))
    // Toggling never back-fills: only speech after the switch is (not) translated.
    clearTranslationTimers(); translationCursorRef.current = entriesRef.current.length
    if (!value) { publishTranslationBlocks(translationBlocksRef.current.filter(block => !block.pending)); speech.clear() }
    if (meetingRef.current) setTranslationStatus(value ? 'Đã bật dịch sang tiếng Việt' : 'Đã tắt dịch tiếng nước ngoài')
  }
  const setAudioInput = (value: AudioInput) => { audioRef.current = value; setAudioInputState(value); publishEntries([]); setInterimTranscripts([]); resetTranslations() }
  const setCadence = (value: Cadence) => { cadenceRef.current = value; setSummaryCadence(value); cadenceValueRef.current = value === 'words' ? 150 : 1; setCadenceValue(cadenceValueRef.current) }
  const setCadenceAmount = (value: number) => { cadenceValueRef.current = value; setCadenceValue(value) }

  const summarize = async (force = false) => {
    if (summaryBusy.current || !meetingRef.current || stoppingRef.current) return
    const session = meetingSessionRef.current
    const current = entriesRef.current
    const cursor = overallSummaryCursor.current
    if (current.length <= cursor) return
    const newEntries = current.slice(cursor)
    const due = cadenceRef.current === 'words'
      ? newEntries.reduce((sum, entry) => sum + countWords(entry.sourceText), 0) >= cadenceValueRef.current
      : Date.now() - lastSummaryAt.current >= cadenceValueRef.current * 60000
    if (!force && !due) return
    summaryBusy.current = true
    setSummaryStatus('Đang cập nhật tóm tắt…')
    const task = (async () => {
      try {
        // Incremental merge: only the transcript since the last update is sent
        // along with the current overall summary, not the whole meeting.
        const result = await desktop.summarizeSegments(newEntries.map(toTranscriptSegment), cursor ? overallStructuredRef.current : undefined)
        if (session !== meetingSessionRef.current) return
        publishStructured(result)
        publishOverallSummary(formatStructuredSummary(result))
        overallSummaryCursor.current = cursor + newEntries.length
        lastSummaryAt.current = Date.now()
        setSummaryStatus(`Đã cập nhật lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`)
      } catch (error) { if (session === meetingSessionRef.current) setSummaryStatus(`Chưa tóm tắt được: ${error}`) }
      finally { if (session === meetingSessionRef.current) { summaryBusy.current = false; summaryTaskRef.current = null } }
    })()
    summaryTaskRef.current = task
    await task
  }

  const flushTranslationParagraph = () => {
    if (!translating()) return
    clearTranslationTimers()
    const start = translationCursorRef.current
    // Auto mode mixes languages; Vietnamese utterances need no translation.
    const paragraphEntries = entriesRef.current.slice(start).filter(entry => entry.language !== 'vi')
    translationCursorRef.current = entriesRef.current.length
    if (!paragraphEntries.length) return
    const block: TranslationBlock = {
      id: crypto.randomUUID(),
      entryIds: paragraphEntries.map(entry => entry.id),
      sourceText: paragraphEntries.map(entry => entry.sourceText).join(' '),
      translatedText: 'Đang chuẩn hóa và dịch cả đoạn…',
      createdAt: now(),
      pending: true,
      kind: 'paragraph',
    }
    publishTranslationBlocks([...translationBlocksRef.current, block])
    const zhEntries = paragraphEntries.filter(entry => entry.language === 'zh').length
    const language: SpokenLanguage = zhEntries * 2 > paragraphEntries.length ? 'zh' : 'en'
    // In live mode Soniox already translated each utterance; the paragraph
    // pass only produces the more accurate text that is saved to the note.
    const live = liveTranslationRef.current
    translationQueueRef.current = translationQueueRef.current.then(async () => {
      try {
        const translatedText = await desktop.translateParagraph(block.sourceText, language, translationContextRef.current)
        translationContextRef.current = block.sourceText
        publishTranslationBlocks(translationBlocksRef.current.map(item => item.id === block.id ? { ...item, translatedText, pending: false } : item))
        setTranslationStatus(live ? 'Dịch trực tiếp · chuẩn hóa theo đoạn' : `${language === 'en' ? 'Anh' : 'Trung'} → Việt theo đoạn`)
        // Without live translation, the paragraph is the first Vietnamese there is to read aloud.
        const last = paragraphEntries.at(-1)
        if (!live && capturingRef.current && last?.generation === generationRef.current) speech.speak(block.id, last.generation, translatedText, last.speaker ?? undefined)
        if (meetingRef.current) await summarize(overallSummaryCursor.current === 0)
      } catch (error) {
        publishTranslationBlocks(translationBlocksRef.current.map(item => item.id === block.id ? { ...item, translatedText: 'Chưa dịch được đoạn này.', pending: false, failed: true } : item))
        setTranslationStatus(`Không dịch được: ${error}`)
      }
    })
  }

  const scheduleTranslationParagraph = () => {
    if (!translating()) return
    const pendingEntries = entriesRef.current.slice(translationCursorRef.current).filter(entry => entry.language !== 'vi')
    if (!pendingEntries.length) return
    if (!translationMaxTimerRef.current) translationMaxTimerRef.current = setTimeout(flushTranslationParagraph, 20000)
    if (translationIdleTimerRef.current) clearTimeout(translationIdleTimerRef.current)
    translationIdleTimerRef.current = setTimeout(flushTranslationParagraph, 4000)
    if (pendingEntries.reduce((sum, entry) => sum + countWords(entry.sourceText), 0) >= 80) flushTranslationParagraph()
  }

  const handleWorker = (message: WorkerMessage) => {
    if (speech.handle(message)) return
    switch (message.type) {
      case 'diarization_status':
        setDiarizationReady(message.ready ?? false)
        setDiarizationStatus(message.message ?? '')
        break
      case 'speaker_update':
        if (message.generation !== generationRef.current) break
        publishEntries(entriesRef.current.map(entry => entry.id === message.id
          ? { ...entry, speaker: message.speaker, speakerProvisional: message.speaker_provisional } : entry))
        break
      case 'diarization_finished':
        if (diarizationFlush.current && message.id === diarizationFlush.current.id) diarizationFlush.current.resolve()
        break
      case 'connected':
        setReady(true)
        setStatus('Sẵn sàng sử dụng')
        setVietnameseASRStatus('Nhận diện sẵn sàng')
        speech.onConnected(Boolean(message.tts_available))
        break
      case 'transcript': {
        // While a meeting is stopping the worker still flushes the running live turn.
        if (!(capturingRef.current || meetingRef.current) || message.generation !== generationRef.current || !message.text) break
        setInterimTranscripts(current => current.filter(item => item.source !== (message.source ?? 'system')))
        const text = message.text
        if (meetingRef.current && countWords(text) >= 8 && entriesRef.current.slice(-20).some(entry => entry.sourceText.toLocaleLowerCase() === text.toLocaleLowerCase() && Date.now() - new Date(entry.timestamp).getTime() < 90000)) break
        const language = spokenLanguage(message)
        spokenLanguageRef.current.set(message.id ?? '', language)
        if (message.id && message.speaker) speakerRef.current.set(message.id, message.speaker)
        const needsTranslation = language !== 'vi' && translating()
        const startedAt = message.started_at ?? Date.now() / 1000
        const entry: Subtitle = { id: message.id ?? crypto.randomUUID(), timestamp: new Date(startedAt * 1000).toISOString(), sourceText: text, rawText: message.raw_text ?? text, audioSource: message.source ?? 'system', translatedText: '', startedAt, generation: generationRef.current, endedAt: message.ended_at, speaker: message.speaker, speakerProvisional: message.speaker_provisional, language }
        publishEntries(meetingRef.current || languageRef.current !== 'vi' ? [...entriesRef.current, entry] : [...entriesRef.current, entry].slice(-8))
        if (!needsTranslation) {
          if (meetingRef.current) void summarize(overallSummaryCursor.current === 0)
          break
        }
        if (liveTranslationRef.current && meetingRef.current) void summarize(overallSummaryCursor.current === 0)
        scheduleTranslationParagraph()
        break
      }
      case 'transcript_interim': {
        if (!capturingRef.current || message.generation !== generationRef.current || !message.text) break
        if (audioIssueRef.current) { audioIssueRef.current = false; setStatus(`● Listening — ${audioRef.current}`) }
        const source = message.source ?? 'system'
        const language = spokenLanguage(message)
        if (message.id) spokenLanguageRef.current.set(message.id, language)
        if (message.id && message.speaker) speakerRef.current.set(message.id, message.speaker)
        const interim = { id: message.id ?? `${message.generation}:${source}`, text: message.text, source, startedAt: message.started_at ?? Date.now() / 1000, speaker: message.speaker }
        setInterimTranscripts(current => [...current.filter(item => item.source !== source), interim])
        break
      }
      // The microphone line turned out to be the speakers' echo of system audio.
      case 'transcript_retract': {
        if (message.generation !== generationRef.current || !message.id) break
        setInterimTranscripts(current => current.filter(item => item.id !== message.id))
        publishTranslationBlocks(translationBlocksRef.current.filter(block => block.id !== message.id))
        break
      }
      case 'translation_mode':
        if (message.generation !== generationRef.current) break
        liveTranslationRef.current = Boolean(message.live)
        setTranslationStatus(languageRef.current !== 'vi' && !translating() ? 'Đã tắt dịch tiếng nước ngoài' : message.live ? (languageRef.current === 'auto' ? 'Dịch trực tiếp · tự động nhận diện → Việt' : 'Dịch trực tiếp · Anh/Trung → Việt') : languageRef.current === 'vi' ? 'Không cần dịch' : 'Dịch theo đoạn')
        break
      case 'live_translation': {
        if (!(capturingRef.current || meetingRef.current) || message.generation !== generationRef.current || !message.id || !message.text) break
        if (spokenLanguageRef.current.get(message.id) === 'vi' || !translating()) break
        setTranslationStatus('Dịch trực tiếp · đang dịch sang tiếng Việt')
        // Published before the transcript is final too: the interim row shows it in
        // place of the still-changing source text.
        const startedAt = message.started_at ?? Date.now() / 1000
        const block: TranslationBlock = { id: message.id, entryIds: [message.id], sourceText: '', translatedText: message.text, createdAt: new Date(startedAt * 1000).toISOString(), pending: !message.final, kind: 'live' }
        publishTranslationBlocks([...translationBlocksRef.current.filter(value => value.id !== message.id), block])
        if (capturingRef.current) speech.translation(message.id, message.generation, message.stable ?? '', message.text, Boolean(message.final), speakerRef.current.get(message.id))
        break
      }
      case 'warning': case 'error': audioIssueRef.current = true; setStatus(audioIssueText(message.message)); break
    }
  }
  const handleWorkerRef = useRef(handleWorker)
  handleWorkerRef.current = handleWorker

  const start = async () => {
    if (capturingRef.current || generationPending.current || !ready) return
    generationPending.current = true; setBusy(true); setStartError('')
    generationRef.current += 1
    try {
      await desktop.sendWorker({ type: 'reset', generation: generationRef.current, language: languageRef.current })
      await desktop.startCapture(audioRef.current)
      microphoneRef.current = audioRef.current !== 'system'; setMicrophoneOn(microphoneRef.current)
      systemAudioRef.current = audioRef.current !== 'microphone'; setSystemAudioOn(systemAudioRef.current)
      capturingRef.current = true; setCapturing(true); setStatus(`● Listening — ${audioRef.current}`)
      translationSession.current = meetingRef.current ? null : { startedAt: Date.now(), firstEntry: entriesRef.current.length }
    } catch (error) { setStatus(`Capture stopped: ${error}`); setStartError(`Không ghi âm được: ${error}`); meetingRef.current = false; setMeetingActive(false) }
    finally { generationPending.current = false; setBusy(false) }
  }
  const toggleSource = async (source: 'microphone' | 'system') => {
    if (!capturingRef.current || sourceBusy.current) return
    sourceBusy.current = true
    const ref = source === 'microphone' ? microphoneRef : systemAudioRef
    const setOn = source === 'microphone' ? setMicrophoneOn : setSystemAudioOn
    const setNative = source === 'microphone' ? desktop.setMicrophone : desktop.setSystemAudio
    const name = source === 'microphone' ? 'micro' : 'âm thanh máy'
    const enabled = !ref.current
    try {
      if (enabled) {
        await desktop.sendWorker({ type: 'open_source', source })
        await setNative(true)
      } else {
        // Stop capturing first so the worker's close is the source's last word.
        await setNative(false)
        await desktop.sendWorker({ type: 'close_source', source })
        setInterimTranscripts(current => current.filter(item => item.source !== source))
      }
      ref.current = enabled; setOn(enabled)
      const other = source === 'microphone' ? systemAudioRef.current : microphoneRef.current
      setStatus(enabled ? `● Đã bật ${name}` : other ? `● Đã tắt ${name} · chỉ thu ${source === 'microphone' ? 'âm thanh máy' : 'micro'}` : `● Đã tắt ${name} · tạm dừng thu`)
    } catch (error) { setStatus(`Không đổi được ${name}: ${error}`) }
    finally { sourceBusy.current = false }
  }
  /** Switches a running recording to `target`, one source at a time (each switch is exclusive). */
  const setSources = async (target: AudioInput) => {
    const wantMicrophone = target !== 'system', wantSystem = target !== 'microphone'
    if (wantSystem !== systemAudioRef.current) await toggleSource('system')
    if (wantMicrophone !== microphoneRef.current) await toggleSource('microphone')
  }
  const startMeeting = async () => {
    // Recognition, translation and summaries all run on the account's credit.
    if (desktop.isDesktop && !await desktop.accountSignedIn().catch(() => false)) {
      setStatus(SIGN_IN_STATUS)
      requestSignIn()
      return
    }
    if (!ready) {
      if (asrKeyAvailable) { setStartRequested(true); setBusy(true); setStatus('Đang kết nối…') }
      return
    }
    meetingSessionRef.current += 1; summaryBusy.current = false; summaryTaskRef.current = null
    publishEntries([]); publishOverallSummary(''); publishStructured(emptyStructuredSummary()); resetTranslations()
    setInterimTranscripts([]); liveChat.reset()
    overallSummaryCursor.current = 0; lastSummaryAt.current = Date.now(); meetingStartedAt.current = Date.now()
    setSummaryStatus('Đang lắng nghe · bản tóm tắt bắt đầu sau câu đầu tiên')
    setTranslationStatus(languageRef.current === 'vi' ? 'Không cần dịch' : !translateForeignRef.current ? 'Đã tắt dịch tiếng nước ngoài' : languageRef.current === 'auto' ? 'Tự động nhận diện → Việt' : `${languageRef.current === 'en' ? 'Anh' : 'Trung'} → Việt theo đoạn`)
    meetingRef.current = true; setMeetingActive(true)
    await start()
  }
  // `discard` ends the meeting without a final summary or a saved note.
  const stop = async (saveOptions?: { title: string; groupID: string | null }, discard = false) => {
    const wasMeeting = meetingRef.current && !discard
    const translation = !meetingRef.current && !discard ? translationSession.current : null
    translationSession.current = null
    const started = new Date(meetingStartedAt.current)
    const defaultTitle = `Cuộc họp · ${started.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}`
    const pendingNoteID = wasMeeting ? crypto.randomUUID() : null
    if (pendingNoteID) {
      const pendingNote: MeetingNote = { id: pendingNoteID, title: saveOptions?.title.trim() || defaultTitle, groupID: saveOptions?.groupID ?? null, createdAt: started.toISOString(), updatedAt: now(), duration: 0, summary: '', transcript: '', saving: true }
      publishNotes([pendingNote, ...notesRef.current], groupsRef.current)
      savingNoteIDRef.current = pendingNoteID; setSavingNoteID(pendingNoteID); setSavingNoteGroupID(pendingNote.groupID ?? null)
    }
    setMeetingActive(false); setBusy(true)
    stoppingRef.current = true
    capturingRef.current = false; setCapturing(false)
    microphoneRef.current = false; setMicrophoneOn(false)
    systemAudioRef.current = false; setSystemAudioOn(false)
    setInterimTranscripts([])
    speech.clear()
    try {
      await desktop.stopCapture()
      // Wait for the native stream tail and speaker updates before saving notes.
      if (!discard) await new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
          diarizationFlush.current = null
          setDiarizationStatus('Hết thời gian chờ; một số nhãn người nói vẫn tạm thời.')
          resolve()
        }, 10000)
        diarizationFlush.current = { id, resolve: () => { clearTimeout(timer); diarizationFlush.current = null; resolve() } }
        void desktop.sendWorker({ type: 'finish_diarization', id }).catch(error => {
          clearTimeout(timer); diarizationFlush.current = null; reject(error)
        })
      })
      if (!discard) { flushTranslationParagraph(); await translationQueueRef.current }
      meetingRef.current = false
      generationRef.current += 1
      await desktop.sendWorker({ type: 'reset', generation: generationRef.current, language: languageRef.current })
    }
    catch (error) { setStatus(`Không dừng được capture: ${error}`) }
    meetingRef.current = false
    // Snapshot the finished meeting, then release the UI: the final summary and
    // save run in the background so a new meeting can start without missing speech.
    const session = meetingSessionRef.current
    const entriesSnapshot = entriesRef.current
    const blocksSnapshot = translationBlocksRef.current
    const startedAtMs = meetingStartedAt.current
    const endedAtMs = Date.now()
    const overallCursorSnapshot = overallSummaryCursor.current
    const chatSnapshot = liveChat.messagesRef.current
    stoppingRef.current = false
    setBusy(false)
    setStatus(ready ? 'Stopped — ready to restart' : 'Worker unavailable')
    if (discard) {
      meetingSessionRef.current += 1
      publishEntries([]); publishOverallSummary(''); publishStructured(emptyStructuredSummary()); resetTranslations(); liveChat.reset()
      setSummaryStatus('Đã bỏ cuộc họp · không lưu ghi chú')
    }
    if (translation) { await saveTranslation(translation, entriesSnapshot, blocksSnapshot, endedAtMs); return }
    if (!wasMeeting) return
    let structured = overallStructuredRef.current
    try {
      // The saved note is regenerated from the full source transcript so an
      // early provisional classification cannot silently become permanent.
      if (entriesSnapshot.length) {
        structured = await desktop.summarizeSegments(entriesSnapshot.map(toTranscriptSegment))
        if (session === meetingSessionRef.current) { publishStructured(structured); publishOverallSummary(formatStructuredSummary(structured)) }
      }
    } catch (error) {
      // A long transcript can exceed the provider's per-request token limit; fall
      // back to merging only the not-yet-summarized tail into the live summary.
      const tail = entriesSnapshot.slice(overallCursorSnapshot)
      try {
        if (!tail.length) throw error
        structured = await desktop.summarizeSegments(tail.map(toTranscriptSegment), overallCursorSnapshot ? structured : undefined)
        if (session === meetingSessionRef.current) { publishStructured(structured); publishOverallSummary(formatStructuredSummary(structured)) }
      } catch (fallbackError) { if (session === meetingSessionRef.current) setSummaryStatus(`Chưa tạo được bản tổng kết cuối: ${fallbackError}`) }
    }
    const summary = formatStructuredSummary(structured)
    const sourceTranscript = entriesSnapshot.map(entry => `${new Date(entry.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · ${entry.audioSource === 'microphone' ? 'Microphone' : 'System audio'}${entry.speaker ? ` · ${entry.speaker}` : ''}: ${entry.sourceText}`).join('\n')
    // Notes keep the LLM paragraph translation; Soniox live lines only fill in
    // paragraphs whose LLM pass failed.
    const liveText = new Map(blocksSnapshot.filter(block => block.kind === 'live' && !block.pending).map(block => [block.id, block.translatedText]))
    const paragraphs = blocksSnapshot.filter(block => block.kind !== 'live').map(block => block.failed
      ? block.entryIds.map(id => liveText.get(id)).filter(Boolean).join(' ') || block.translatedText
      : block.translatedText)
    const translatedTranscript = !paragraphs.length ? '' : `\n\nBẢN DỊCH TIẾNG VIỆT THEO ĐOẠN\n${paragraphs.map((text, index) => `ĐOẠN ${index + 1}\n${text}`).join('\n\n')}`
    // A title left at the date-based default is replaced by the final summary's suggestion.
    const chosenTitle = saveOptions?.title.trim() || defaultTitle
    const note: MeetingNote = { id: pendingNoteID!, title: chosenTitle === defaultTitle && structured.title ? structured.title : chosenTitle, groupID: saveOptions?.groupID ?? null, createdAt: started.toISOString(), updatedAt: now(), duration: (endedAtMs - startedAtMs) / 1000, summary: summary || 'Chưa có tóm tắt · vui lòng kiểm tra kết nối.', structuredSummary: structured, transcriptSegments: entriesSnapshot.map(toTranscriptSegment), transcript: sourceTranscript + translatedTranscript, saving: true }
    // Answers that arrived while the final summary ran still belong to this meeting.
    const chatMessages = session === meetingSessionRef.current ? liveChat.messagesRef.current : chatSnapshot
    if (chatMessages.length) note.chatMessages = chatMessages
    const completedNotes = notesRef.current.map(item => item.id === note.id ? note : item)
    publishNotes(completedNotes, groupsRef.current)
    try {
      if (desktop.isDesktop) await desktop.saveNotes({ notes: notesForStorage(completedNotes), groups: groupsRef.current })
      publishNotes(notesRef.current.map(item => item.id === note.id ? { ...item, saving: false } : item), groupsRef.current)
    } catch (error) { setStatus(`Không lưu được ghi chú: ${error}`) }
    finally {
      // Another meeting may have been stopped meanwhile; only clear our own marker.
      if (savingNoteIDRef.current === note.id) { savingNoteIDRef.current = null; setSavingNoteID(null); setSavingNoteGroupID(null) }
    }
  }
  /** A translator-page session becomes a note titled "Phiên dịch": the Vietnamese paragraphs, then the source transcript. */
  const saveTranslation = async (session: { startedAt: number; firstEntry: number }, allEntries: Subtitle[], blocks: TranslationBlock[], endedAtMs: number) => {
    const entries = allEntries.slice(session.firstEntry)
    if (!entries.length) return
    const ids = new Set(entries.map(entry => entry.id))
    const liveText = new Map(blocks.filter(block => block.kind === 'live' && !block.pending && ids.has(block.id)).map(block => [block.id, block.translatedText]))
    const paragraphs = blocks.filter(block => block.kind !== 'live' && block.entryIds.some(id => ids.has(id)))
      .map(block => block.failed ? block.entryIds.map(id => liveText.get(id)).filter(Boolean).join(' ') || block.translatedText : block.translatedText)
      .filter(text => text.trim())
    // Translation off or a Vietnamese source: the live lines are all there is.
    const translated = paragraphs.length ? paragraphs : [...liveText.values()].filter(text => text.trim()).length ? [[...liveText.values()].join(' ')] : []
    const started = new Date(session.startedAt)
    const sourceTranscript = entries.map(entry => `${new Date(entry.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · ${entry.audioSource === 'microphone' ? 'Microphone' : 'System audio'}${entry.speaker ? ` · ${entry.speaker}` : ''}: ${entry.sourceText}`).join('\n')
    const note: MeetingNote = {
      id: crypto.randomUUID(), title: `Phiên dịch · ${started.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}`, groupID: null,
      createdAt: started.toISOString(), updatedAt: now(), duration: (endedAtMs - session.startedAt) / 1000,
      summary: translated.map((text, index) => `ĐOẠN ${index + 1}\n${text}`).join('\n\n'),
      transcriptSegments: entries.map(toTranscriptSegment),
      transcript: sourceTranscript + (translated.length ? `\n\nBẢN DỊCH TIẾNG VIỆT THEO ĐOẠN\n${translated.map((text, index) => `ĐOẠN ${index + 1}\n${text}`).join('\n\n')}` : ''),
    }
    const nextNotes = [note, ...notesRef.current]
    publishNotes(nextNotes, groupsRef.current)
    try { if (desktop.isDesktop) await desktop.saveNotes({ notes: notesForStorage(nextNotes), groups: groupsRef.current }); setStatus(`Đã lưu “${note.title}” vào Ghi chú`) }
    catch (error) { setStatus(`Không lưu được bản phiên dịch: ${error}`) }
  }
  const newNote = (groupID?: string | null) => { const note = createNote(groupID); persist([note, ...notesRef.current], groupsRef.current); return note.id }
  const updateNote = (id: string, patch: Partial<Pick<MeetingNote, 'title' | 'summary' | 'groupID'>>) => persist(notesRef.current.map(note => note.id === id && !note.isDemo ? { ...note, ...patch, ...(patch.summary === undefined ? {} : { structuredSummary: undefined }), updatedAt: now() } : note), groupsRef.current)
  const addNote = (note: MeetingNote) => persist([note, ...notesRef.current], groupsRef.current)
  const deleteNote = (id: string) => persist(notesRef.current.filter(note => note.id !== id || note.isDemo), groupsRef.current)
  const createGroup = (raw: string) => { const name = raw.trim(); if (!name || groupsRef.current.some(g => g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return null; const group = { id: crypto.randomUUID(), name }; persist(notesRef.current, [...groupsRef.current, group]); return group.id }
  const renameGroup = (id: string, raw: string) => { const name = raw.trim(); if (!name || groupsRef.current.some(g => g.id !== id && g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return false; persist(notesRef.current, groupsRef.current.map(g => g.id === id ? { ...g, name } : g)); return true }
  const deleteGroup = (id: string) => persist(notesRef.current.map(note => note.groupID === id ? { ...note, groupID: null } : note), groupsRef.current.filter(g => g.id !== id))
  // Asks for a name only when no summary has produced one yet.
  const [titlePending, setTitlePending] = useState(false)
  const suggestTitleNow = async () => {
    if (overallStructuredRef.current.title || !entriesRef.current.length) return
    const session = meetingSessionRef.current
    setTitlePending(true)
    try {
      const title = await desktop.suggestTitle(entriesRef.current.map(entry => entry.sourceText).join('\n'))
      if (session === meetingSessionRef.current && title && !overallStructuredRef.current.title) setSuggestedTitle(title)
    } catch { /* the date-based name stays available */ }
    finally { setTitlePending(false) }
  }

  const summarizeNow = async () => {
    if (translating()) { flushTranslationParagraph(); await translationQueueRef.current }
    await summarize(true)
  }


  useEffect(() => {
    if (!ready || !startRequested) return
    setStartRequested(false); setBusy(false)
    void startMeeting()
  }, [ready, startRequested])

  const refreshAccount = useCallback(async () => {
    if (!desktop.isDesktop) return
    try { setAccount(await desktop.accountStatus()) } catch { /* keep the last known balance */ }
  }, [])
  useEffect(() => {
    void refreshAccount()
    // Minutes count down while a meeting records.
    const timer = window.setInterval(() => void refreshAccount(), 60_000)
    return () => window.clearInterval(timer)
  }, [refreshAccount])
  const fileJob = useFileJob(addNote, () => void refreshAccount())

  return { account, refreshAccount, status, startError, ready, diarizationReady, diarizationStatus, busy, capturing, meetingActive, sourceLanguage, setSourceLanguage, translateForeign, setTranslateForeign, audioInput, setAudioInput, microphoneOn, toggleMicrophone: () => void toggleSource('microphone'), systemAudioOn, toggleSystemAudio: () => void toggleSource('system'), setSources,
    entries, interimTranscripts, translationBlocks, overallSummary, suggestedTitle, titlePending, suggestTitleNow: () => void suggestTitleNow(), summaryStatus, summaryCadence, setSummaryCadence: setCadence,
    cadenceValue, setCadenceValue: setCadenceAmount, notes, noteGroups, savingNoteID, savingNoteGroupID, vietnameseASRStatus, translationStatus,
    canStartMeeting: ready || asrKeyAvailable, canSummarizeNow: meetingActive && !summaryBusy.current && (entries.length > overallSummaryCursor.current || (translating() && entries.length > translationCursorRef.current)),
    noteChat, noteDocuments, liveChat, speech, start, startMeeting, stop, summarizeNow: () => void summarizeNow(), newNote, addNote, updateNote, deleteNote, fileJob, createGroup, renameGroup, deleteGroup, meetingStartedAt: meetingStartedAt.current }
}

export type AppModel = ReturnType<typeof useAppModel>
