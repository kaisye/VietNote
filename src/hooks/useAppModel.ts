import { useCallback, useEffect, useRef, useState } from 'react'
import { desktop } from '../services/desktop'
import { createNote, demoNote, emptyStructuredSummary, formatStructuredSummary, toTranscriptSegment } from '../services/notes'
import type { AudioInput, Cadence, Language, MeetingNote, NoteGroup, StructuredMeetingSummary, Subtitle, SummarySnapshot, TranslationBlock, WorkerMessage } from '../services/types'

const now = () => new Date().toISOString()
const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

export function useAppModel() {
  const [status, setStatus] = useState('Đang khởi động…')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [meetingActive, setMeetingActive] = useState(false)
  const [asrKeyAvailable, setAsrKeyAvailable] = useState(false)
  const [startRequested, setStartRequested] = useState(false)
  const [sourceLanguage, setSourceLanguageState] = useState<Language>('vi')
  const [audioInput, setAudioInputState] = useState<AudioInput>('both')
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [speechRate, setSpeechRateState] = useState(() => {
    const saved = Number(localStorage.getItem('ttsPlaybackRate'))
    return [1, 1.15, 1.25, 1.4, 1.5].includes(saved) ? saved : 1.25
  })
  const [entries, setEntries] = useState<Subtitle[]>([])
  const [translationBlocks, setTranslationBlocks] = useState<TranslationBlock[]>([])
  const [summaryHistory, setSummaryHistory] = useState<SummarySnapshot[]>([])
  const [overallSummary, setOverallSummary] = useState('')
  const [summaryStatus, setSummaryStatus] = useState('Bản tóm tắt sẽ xuất hiện sau câu nói đầu tiên.')
  const [summaryCadence, setSummaryCadence] = useState<Cadence>('words')
  const [cadenceValue, setCadenceValue] = useState(60)
  const [notes, setNotes] = useState<MeetingNote[]>([demoNote])
  const [noteGroups, setNoteGroups] = useState<NoteGroup[]>([])
  const [savingNoteID, setSavingNoteID] = useState<string | null>(null)
  const [savingNoteGroupID, setSavingNoteGroupID] = useState<string | null>(null)
  const [vietnameseASRStatus, setVietnameseASRStatus] = useState('Đang chuẩn bị nhận diện…')
  const [ttsStatus, setTtsStatus] = useState('Đang tải giọng đọc…')
  const [ttsVoiceName, setTtsVoiceName] = useState('Giọng Nam')
  const [translationStatus, setTranslationStatus] = useState('Đang chuẩn bị dịch')
  const entriesRef = useRef<Subtitle[]>([])
  const translationBlocksRef = useRef<TranslationBlock[]>([])
  const historyRef = useRef<SummarySnapshot[]>([])
  const overallSummaryRef = useRef('')
  const overallStructuredRef = useRef<StructuredMeetingSummary>(emptyStructuredSummary())
  const notesRef = useRef<MeetingNote[]>([demoNote])
  const groupsRef = useRef<NoteGroup[]>([])
  const meetingRef = useRef(false)
  const capturingRef = useRef(false)
  const asrKeyStatusRef = useRef<'checking' | 'available' | 'missing'>('checking')
  const generationRef = useRef(0)
  const languageRef = useRef<Language>('vi')
  const audioRef = useRef<AudioInput>('both')
  const speechRef = useRef(true)
  const speechRateRef = useRef(speechRate)
  const cadenceRef = useRef<Cadence>('words')
  const cadenceValueRef = useRef(60)
  const summaryCursor = useRef(0)
  const overallSummaryCursor = useRef(0)
  const manualCursor = useRef(0)
  const summaryBusy = useRef(false)
  const summaryTaskRef = useRef<Promise<void> | null>(null)
  const translationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const translationCursorRef = useRef(0)
  const translationContextRef = useRef('')
  const translationIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const translationMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSummaryAt = useRef(Date.now())
  const meetingStartedAt = useRef(Date.now())
  const generationPending = useRef(false)
  const audioContext = useRef<AudioContext | null>(null)
  const audioNextTime = useRef(0)
  const stagedAudio = useRef<AudioBuffer[]>([])
  const stagedDuration = useRef(0)
  const playbackStarted = useRef(false)
  const activeVoiceRef = useRef('giọng đã chọn')

  const publishEntries = (next: Subtitle[]) => { entriesRef.current = next; setEntries(next) }
  const publishTranslationBlocks = (next: TranslationBlock[]) => { translationBlocksRef.current = next; setTranslationBlocks(next) }
  const publishHistory = (next: SummarySnapshot[]) => { historyRef.current = next; setSummaryHistory(next) }
  const publishOverallSummary = (next: string) => { overallSummaryRef.current = next; setOverallSummary(next) }
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

  useEffect(() => {
    if (!desktop.isDesktop) { setStatus('Hãy mở ứng dụng VietNote để sử dụng'); return }
    let disposed = false
    const unlisten: Array<() => void> = []
    void desktop.loadNotes().then(data => { if (!disposed) persist([demoNote, ...data.notes.filter(n => !n.isDemo)], data.groups) }).catch(error => setStatus(`Không đọc được ghi chú: ${error}`))
    void desktop.onWorker(message => { if (!disposed) handleWorkerRef.current(message) }).then(fn => unlisten.push(fn))
    void desktop.onStatus(value => { if (!disposed) { setStatus(/loading/i.test(value) ? 'Đang khởi động…' : /closed|exited/i.test(value) ? 'Đã dừng' : /failed|missing/i.test(value) ? 'Không thể khởi động' : value); if (/loading|exited|closed|failed|missing/i.test(value)) { setReady(false); if (/exited|closed|failed|missing/i.test(value)) { setStartRequested(false); setBusy(false) } } } }).then(fn => unlisten.push(fn))
    void desktop.aiKeyStatus('groq').then(keyStatus => {
      if (disposed) return
      const available = keyStatus === 'saved' || keyStatus === 'environment'
      asrKeyStatusRef.current = available ? 'available' : 'missing'
      setAsrKeyAvailable(available)
      setStatus(available ? 'Sẵn sàng sử dụng' : 'Đang chuẩn bị nhận diện…')
    }).catch(() => {
      if (disposed) return
      asrKeyStatusRef.current = 'missing'; setAsrKeyAvailable(false)
      setStatus('Đang chuẩn bị nhận diện…')
    })
    void desktop.startWorker().catch(() => setStatus('Không khởi động được dịch vụ nhận diện'))
    return () => { disposed = true; unlisten.forEach(fn => fn()) }
  }, [persist])

  const clearTranslationTimers = () => {
    if (translationIdleTimerRef.current) clearTimeout(translationIdleTimerRef.current)
    if (translationMaxTimerRef.current) clearTimeout(translationMaxTimerRef.current)
    translationIdleTimerRef.current = null; translationMaxTimerRef.current = null
  }
  const resetTranslations = () => {
    clearTranslationTimers(); publishTranslationBlocks([])
    translationCursorRef.current = 0; translationContextRef.current = ''; translationQueueRef.current = Promise.resolve()
  }
  const setSourceLanguage = (value: Language) => { languageRef.current = value; setSourceLanguageState(value); publishEntries([]); resetTranslations() }
  const setAudioInput = (value: AudioInput) => { audioRef.current = value; setAudioInputState(value); publishEntries([]); resetTranslations() }
  const setCadence = (value: Cadence) => { cadenceRef.current = value; setSummaryCadence(value); cadenceValueRef.current = value === 'words' ? 60 : 1; setCadenceValue(cadenceValueRef.current) }
  const setCadenceAmount = (value: number) => { cadenceValueRef.current = value; setCadenceValue(value) }
  const clearPlayback = () => { void audioContext.current?.close(); audioContext.current = null; audioNextTime.current = 0; stagedAudio.current = []; stagedDuration.current = 0; playbackStarted.current = false }
  const setSpeech = (value: boolean) => { speechRef.current = value; setSpeechEnabled(value); if (!value) clearPlayback() }
  const setSpeechRate = (value: number) => {
    const next = [1, 1.15, 1.25, 1.4, 1.5].includes(value) ? value : 1.25
    speechRateRef.current = next; setSpeechRateState(next); localStorage.setItem('ttsPlaybackRate', String(next))
  }

  const summarize = async (force = false, manual = false) => {
    if (summaryBusy.current || !meetingRef.current) return
    const cursor = manual ? manualCursor.current : summaryCursor.current
    const current = entriesRef.current
    if (current.length <= cursor) return
    const newEntries = current.slice(cursor)
    const newOverallEntries = current.slice(overallSummaryCursor.current)
    const due = cadenceRef.current === 'words'
      ? newEntries.reduce((sum, entry) => sum + countWords(entry.sourceText), 0) >= cadenceValueRef.current
      : Date.now() - lastSummaryAt.current >= cadenceValueRef.current * 60000
    if (!force && !due) return
    summaryBusy.current = true
    const end = cursor + newEntries.length
    setSummaryStatus(manual ? 'Đang tóm tắt đoạn được đánh dấu…' : 'Đang cập nhật tóm tắt…')
    const task = (async () => {
      try {
        const [latestResult, overallResult] = await Promise.allSettled([
          desktop.summarizeSegments(newEntries.map(toTranscriptSegment)),
          newOverallEntries.length ? desktop.summarizeSegments(current.map(toTranscriptSegment), overallStructuredRef.current) : Promise.resolve(overallStructuredRef.current),
        ])
        if (latestResult.status === 'fulfilled') {
          publishHistory([...historyRef.current, { id: crypto.randomUUID(), createdAt: now(), text: formatStructuredSummary(latestResult.value), entryCount: newEntries.length, isManual: manual }])
          if (manual) manualCursor.current = end; else summaryCursor.current = end
        }
        if (overallResult.status === 'fulfilled') {
          overallStructuredRef.current = overallResult.value
          publishOverallSummary(formatStructuredSummary(overallResult.value))
          overallSummaryCursor.current = current.length
        }
        if (latestResult.status === 'rejected' && overallResult.status === 'rejected') throw latestResult.reason
        lastSummaryAt.current = Date.now()
        const partial = latestResult.status === 'rejected' || overallResult.status === 'rejected' ? ' · một phần chưa cập nhật' : ''
        setSummaryStatus(`Đã cập nhật lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}${partial}`)
      } catch (error) { setSummaryStatus(`Chưa tóm tắt được: ${error}`) }
      finally { summaryBusy.current = false; summaryTaskRef.current = null }
    })()
    summaryTaskRef.current = task
    await task
  }

  const flushTranslationParagraph = () => {
    if (languageRef.current === 'vi') return
    clearTranslationTimers()
    const start = translationCursorRef.current
    const paragraphEntries = entriesRef.current.slice(start)
    if (!paragraphEntries.length) return
    translationCursorRef.current = entriesRef.current.length
    const block: TranslationBlock = {
      id: crypto.randomUUID(),
      entryIds: paragraphEntries.map(entry => entry.id),
      sourceText: paragraphEntries.map(entry => entry.sourceText).join(' '),
      translatedText: 'Đang chuẩn hóa và dịch cả đoạn…',
      createdAt: now(),
      pending: true,
    }
    publishTranslationBlocks([...translationBlocksRef.current, block])
    const language = languageRef.current
    translationQueueRef.current = translationQueueRef.current.then(async () => {
      try {
        const translatedText = await desktop.translateParagraph(block.sourceText, language, translationContextRef.current)
        translationContextRef.current = block.sourceText
        publishTranslationBlocks(translationBlocksRef.current.map(item => item.id === block.id ? { ...item, translatedText, pending: false } : item))
        setTranslationStatus(`${language === 'en' ? 'Anh' : 'Trung'} → Việt theo đoạn`)
        if (meetingRef.current) await summarize(historyRef.current.length === 0)
        const lastEntry = paragraphEntries.at(-1)
        if (speechRef.current && audioRef.current === 'system' && capturingRef.current && lastEntry?.generation === generationRef.current) {
          void desktop.sendWorker({ type: 'synthesize', id: block.id, generation: lastEntry.generation, text: translatedText })
        }
      } catch (error) {
        publishTranslationBlocks(translationBlocksRef.current.map(item => item.id === block.id ? { ...item, translatedText: 'Chưa dịch được đoạn này.', pending: false } : item))
        setTranslationStatus(`Không dịch được: ${error}`)
      }
    })
  }

  const scheduleTranslationParagraph = () => {
    const pendingEntries = entriesRef.current.slice(translationCursorRef.current)
    if (!pendingEntries.length) return
    if (!translationMaxTimerRef.current) translationMaxTimerRef.current = setTimeout(flushTranslationParagraph, 20000)
    if (translationIdleTimerRef.current) clearTimeout(translationIdleTimerRef.current)
    translationIdleTimerRef.current = setTimeout(flushTranslationParagraph, 4000)
    if (pendingEntries.reduce((sum, entry) => sum + countWords(entry.sourceText), 0) >= 80) flushTranslationParagraph()
  }

  const flushPlayback = () => {
    const context = audioContext.current
    if (!context || !stagedAudio.current.length) return
    for (const buffer of stagedAudio.current) {
      const source = context.createBufferSource()
      source.buffer = buffer; source.connect(context.destination)
      const begin = Math.max(context.currentTime + 0.06, audioNextTime.current)
      source.playbackRate.value = speechRateRef.current
      source.start(begin); audioNextTime.current = begin + buffer.duration / speechRateRef.current
    }
    stagedAudio.current = []; stagedDuration.current = 0; playbackStarted.current = true
  }

  const playPCM = (encoded: string, sampleRate: number) => {
    if (!speechRef.current) return
    try {
      const binary = atob(encoded)
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
      const samples = new Float32Array(bytes.buffer)
      const context = audioContext.current ?? new AudioContext()
      audioContext.current = context
      const buffer = context.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      stagedAudio.current.push(buffer); stagedDuration.current += buffer.duration
      if (playbackStarted.current || stagedDuration.current >= 0.8) flushPlayback()
    } catch (error) { setTtsStatus(`Không phát được âm thanh: ${error}`) }
  }

  const handleWorker = (message: WorkerMessage) => {
    switch (message.type) {
      case 'connected':
        setReady(true)
        setStatus('Sẵn sàng sử dụng')
        setVietnameseASRStatus('Nhận diện sẵn sàng')
        activeVoiceRef.current = message.tts_voice ?? 'giọng đã chọn'
        setTtsVoiceName(activeVoiceRef.current)
        setTtsStatus(`Giọng đọc sẵn sàng — ${activeVoiceRef.current}`)
        break
      case 'transcript': {
        if (!capturingRef.current || message.generation !== generationRef.current || !message.text) break
        const text = message.text
        if (meetingRef.current && countWords(text) >= 8 && entriesRef.current.slice(-20).some(entry => entry.sourceText.toLocaleLowerCase() === text.toLocaleLowerCase() && Date.now() - new Date(entry.timestamp).getTime() < 90000)) break
        const language = languageRef.current
        const needsTranslation = language !== 'vi'
        const startedAt = message.started_at ?? Date.now() / 1000
        const entry: Subtitle = { id: crypto.randomUUID(), timestamp: new Date(startedAt * 1000).toISOString(), sourceText: text, rawText: message.raw_text ?? text, audioSource: message.source ?? 'system', translatedText: '', startedAt, generation: generationRef.current }
        publishEntries(meetingRef.current || needsTranslation ? [...entriesRef.current, entry] : [...entriesRef.current, entry].slice(-8))
        if (!needsTranslation) {
          if (meetingRef.current) void summarize(historyRef.current.length === 0)
          break
        }
        scheduleTranslationParagraph()
        break
      }
      // Keep the existing AudioContext and schedule the next utterance after the
      // previous one. Closing it here truncates audio that is still playing.
      case 'tts_begin': if (message.generation === generationRef.current) { activeVoiceRef.current = message.voice ?? activeVoiceRef.current; setTtsVoiceName(activeVoiceRef.current); setTtsStatus(`Speaking — ${activeVoiceRef.current}`) } break
      case 'tts_audio': if (message.pcm && message.generation === generationRef.current) playPCM(message.pcm, message.sample_rate ?? 48000); break
      case 'tts_end': if (message.generation === generationRef.current) { flushPlayback(); setTtsStatus(`Đang dùng ${activeVoiceRef.current}`) } break
      case 'tts_error': setTtsStatus('Giọng đọc tạm thời không khả dụng'); break
      case 'warning': case 'error': setStatus('Đã xảy ra lỗi xử lý âm thanh'); break
    }
  }
  const handleWorkerRef = useRef(handleWorker)
  handleWorkerRef.current = handleWorker

  const start = async () => {
    if (capturingRef.current || generationPending.current || !ready) return
    generationPending.current = true; setBusy(true)
    generationRef.current += 1
    try {
      await desktop.sendWorker({ type: 'reset', generation: generationRef.current, language: languageRef.current })
      await desktop.startCapture(audioRef.current)
      capturingRef.current = true; setCapturing(true); setStatus(`● Listening — ${audioRef.current}`)
    } catch (error) { setStatus(`Capture stopped: ${error}`); meetingRef.current = false; setMeetingActive(false) }
    finally { generationPending.current = false; setBusy(false) }
  }
  const startMeeting = async () => {
    if (!ready) {
      if (asrKeyAvailable) { setStartRequested(true); setBusy(true); setStatus('Đang kết nối…') }
      return
    }
    publishEntries([]); publishHistory([]); publishOverallSummary(''); overallStructuredRef.current = emptyStructuredSummary(); resetTranslations()
    summaryCursor.current = 0; overallSummaryCursor.current = 0; manualCursor.current = 0; lastSummaryAt.current = Date.now(); meetingStartedAt.current = Date.now()
    setSummaryStatus('Đang lắng nghe · bản tóm tắt bắt đầu sau câu đầu tiên')
    setTranslationStatus(languageRef.current === 'vi' ? 'Không cần dịch' : `${languageRef.current === 'en' ? 'Anh' : 'Trung'} → Việt theo đoạn`)
    setSpeech(false); meetingRef.current = true; setMeetingActive(true)
    await start()
  }
  const stop = async (saveOptions?: { title: string; groupID: string | null }) => {
    const wasMeeting = meetingRef.current
    const started = new Date(meetingStartedAt.current)
    const defaultTitle = `Cuộc họp · ${started.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}`
    const pendingNoteID = wasMeeting ? crypto.randomUUID() : null
    if (pendingNoteID) {
      const pendingNote: MeetingNote = { id: pendingNoteID, title: saveOptions?.title.trim() || defaultTitle, groupID: saveOptions?.groupID ?? null, createdAt: started.toISOString(), updatedAt: now(), duration: 0, summary: '', transcript: '', saving: true }
      publishNotes([pendingNote, ...notesRef.current], groupsRef.current)
      setSavingNoteID(pendingNoteID); setSavingNoteGroupID(pendingNote.groupID ?? null)
    }
    setMeetingActive(false); setBusy(true)
    capturingRef.current = false; setCapturing(false)
    clearPlayback()
    try {
      await desktop.stopCapture()
      flushTranslationParagraph()
      await translationQueueRef.current
      meetingRef.current = false
      generationRef.current += 1
      await desktop.sendWorker({ type: 'reset', generation: generationRef.current, language: languageRef.current })
    }
    catch (error) { setStatus(`Không dừng được capture: ${error}`) }
    meetingRef.current = false
    if (wasMeeting) {
      await summaryTaskRef.current
      try {
        // The saved note is regenerated from the full source transcript so an
        // early provisional classification cannot silently become permanent.
        if (entriesRef.current.length) {
          overallStructuredRef.current = await desktop.summarizeSegments(entriesRef.current.map(toTranscriptSegment))
          publishOverallSummary(formatStructuredSummary(overallStructuredRef.current))
        }
      } catch (error) { setSummaryStatus(`Chưa tạo được bản tổng kết cuối: ${error}`) }
      const summary = formatStructuredSummary(overallStructuredRef.current)
      const sourceTranscript = entriesRef.current.map(entry => `${new Date(entry.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · ${entry.audioSource === 'microphone' ? 'Microphone' : 'System audio'}: ${entry.sourceText}`).join('\n')
      const translatedTranscript = languageRef.current === 'vi' ? '' : `\n\nBẢN DỊCH TIẾNG VIỆT THEO ĐOẠN\n${translationBlocksRef.current.map((block, index) => `ĐOẠN ${index + 1}\n${block.translatedText}`).join('\n\n')}`
      const note: MeetingNote = { id: pendingNoteID!, title: saveOptions?.title.trim() || defaultTitle, groupID: saveOptions?.groupID ?? null, createdAt: started.toISOString(), updatedAt: now(), duration: (Date.now() - meetingStartedAt.current) / 1000, summary: summary || 'Chưa có tóm tắt · vui lòng kiểm tra kết nối.', structuredSummary: overallStructuredRef.current, transcriptSegments: entriesRef.current.map(toTranscriptSegment), transcript: sourceTranscript + translatedTranscript, saving: true }
      const completedNotes = notesRef.current.map(item => item.id === note.id ? note : item)
      publishNotes(completedNotes, groupsRef.current)
      try {
        if (desktop.isDesktop) await desktop.saveNotes({ notes: notesForStorage(completedNotes), groups: groupsRef.current })
        publishNotes(completedNotes.map(item => item.id === note.id ? { ...item, saving: false } : item), groupsRef.current)
      } catch (error) { setStatus(`Không lưu được ghi chú: ${error}`) }
      finally { setSavingNoteID(null); setSavingNoteGroupID(null) }
    }
    setBusy(false)
    setStatus(ready ? 'Stopped — ready to restart' : 'Worker unavailable')
  }
  const newNote = (groupID?: string | null) => { const note = createNote(groupID); persist([note, ...notesRef.current], groupsRef.current); return note.id }
  const updateNote = (id: string, patch: Partial<Pick<MeetingNote, 'title' | 'summary' | 'groupID'>>) => persist(notesRef.current.map(note => note.id === id && !note.isDemo ? { ...note, ...patch, ...(patch.summary === undefined ? {} : { structuredSummary: undefined }), updatedAt: now() } : note), groupsRef.current)
  const deleteNote = (id: string) => persist(notesRef.current.filter(note => note.id !== id || note.isDemo), groupsRef.current)
  const createGroup = (raw: string) => { const name = raw.trim(); if (!name || groupsRef.current.some(g => g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return null; const group = { id: crypto.randomUUID(), name }; persist(notesRef.current, [...groupsRef.current, group]); return group.id }
  const renameGroup = (id: string, raw: string) => { const name = raw.trim(); if (!name || groupsRef.current.some(g => g.id !== id && g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return false; persist(notesRef.current, groupsRef.current.map(g => g.id === id ? { ...g, name } : g)); return true }
  const deleteGroup = (id: string) => persist(notesRef.current.map(note => note.groupID === id ? { ...note, groupID: null } : note), groupsRef.current.filter(g => g.id !== id))
  const summarizeNow = async () => {
    if (languageRef.current !== 'vi') { flushTranslationParagraph(); await translationQueueRef.current }
    await summarize(true, true)
  }

  const readySummaryUnits = entries.length

  useEffect(() => {
    if (!ready || !startRequested) return
    setStartRequested(false); setBusy(false)
    void startMeeting()
  }, [ready, startRequested])

  return { status, ready, busy, capturing, meetingActive, sourceLanguage, setSourceLanguage, audioInput, setAudioInput,
    speechEnabled, setSpeechEnabled: setSpeech, speechRate, setSpeechRate, entries, translationBlocks, summaryHistory, overallSummary, summaryStatus, summaryCadence, setSummaryCadence: setCadence,
    cadenceValue, setCadenceValue: setCadenceAmount, notes, noteGroups, savingNoteID, savingNoteGroupID, vietnameseASRStatus, ttsStatus, ttsVoiceName, translationStatus,
    canStartMeeting: ready || asrKeyAvailable, canSummarizeNow: meetingActive && !summaryBusy.current && (readySummaryUnits > manualCursor.current || (languageRef.current !== 'vi' && entries.length > translationCursorRef.current)),
    start, startMeeting, stop, summarizeNow: () => void summarizeNow(), newNote, updateNote, deleteNote, createGroup, renameGroup, deleteGroup, meetingStartedAt: meetingStartedAt.current }
}

export type AppModel = ReturnType<typeof useAppModel>
