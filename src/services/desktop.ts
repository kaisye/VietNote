import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AudioInput, Language, MeetingNote, NoteGroup, StructuredMeetingSummary, TranscriptSegment, WorkerMessage } from './types'

export interface StoredNotes { notes: MeetingNote[]; groups: NoteGroup[] }
export type SummaryAiProvider = 'nine_router' | 'groq'
export interface SummaryAiConfig { apiUrl: string; model: string; provider: SummaryAiProvider }
export type TtsVoiceId = 'thuc-day-di' | 'ngoc-huyen'
export interface TtsVoiceOption { id: TtsVoiceId; displayName: string; description: string }
export interface TtsVoiceConfig { selectedId: TtsVoiceId; voices: TtsVoiceOption[] }
const isDesktop = '__TAURI_INTERNALS__' in window
let saveQueue: Promise<void> = Promise.resolve()

export const desktop = {
  isDesktop,
  loadNotes: () => invoke<StoredNotes>('load_notes'),
  saveNotes: (payload: StoredNotes) => {
    saveQueue = saveQueue.catch(() => {}).then(() => invoke<void>('save_notes', { payload }))
    return saveQueue
  },
  getSummaryAiConfig: () => invoke<SummaryAiConfig>('get_summary_ai_config'),
  setSummaryAiConfig: (config: SummaryAiConfig) => invoke<SummaryAiConfig>('set_summary_ai_config', { config }),
  getTtsVoiceConfig: () => invoke<TtsVoiceConfig>('get_tts_voice_config'),
  setTtsVoice: (voiceId: TtsVoiceId) => invoke<TtsVoiceConfig>('set_tts_voice', { voiceId }),
  startWorker: () => invoke<void>('start_worker'),
  aiKeyStatus: (provider: SummaryAiProvider) => invoke<'saved' | 'environment' | 'none'>('ai_key_status', { provider }),
  setAiApiKey: (provider: SummaryAiProvider, apiKey: string | null) => invoke<'saved' | 'environment' | 'none'>('set_ai_api_key', { provider, apiKey }),
  accessKeyStatus: () => invoke<boolean>('access_key_status'),
  setAccessKey: (accessKey: string) => invoke<boolean>('set_access_key', { accessKey }),
  stopWorker: () => invoke<void>('stop_worker'),
  sendWorker: (payload: Record<string, unknown>) => invoke<void>('send_worker', { payload }),
  startCapture: (source: AudioInput) => invoke<void>('start_capture', { source }),
  stopCapture: () => invoke<void>('stop_capture'),
  summarizeSegments: (segments: TranscriptSegment[], previousSummary?: StructuredMeetingSummary) =>
    invoke<StructuredMeetingSummary>('summarize_segments', { segments, previousSummary: previousSummary ?? null }),
  translateParagraph: (text: string, sourceLanguage: Language, previousContext: string) => invoke<string>('translate_text', { text, sourceLanguage, previousContext }),
  openPermission: (kind: 'microphone' | 'screen') => invoke<void>('open_permission', { kind }),
  onWorker: (callback: (event: WorkerMessage) => void): Promise<UnlistenFn> => listen<WorkerMessage>('worker-message', e => callback(e.payload)),
  onStatus: (callback: (status: string) => void): Promise<UnlistenFn> => listen<string>('worker-status', e => callback(e.payload)),
}
