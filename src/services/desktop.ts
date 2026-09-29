import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AudioChunk, AudioInput, SpokenLanguage, MeetingNote, NoteGroup, StructuredMeetingSummary, TranscriptSegment, WorkerMessage } from './types'

export interface StoredNotes { notes: MeetingNote[]; groups: NoteGroup[] }
export type SummaryAiProvider = 'nine_router' | 'groq'
export type AiKeyProvider = SummaryAiProvider | 'soniox'
export interface SummaryAiConfig { apiUrl: string; model: string; provider: SummaryAiProvider }
export interface AiProviderHealth { ready: boolean; message: string }
export type TtsVoiceId = 'thuc-day-di' | 'ngoc-huyen'
export interface TtsVoiceOption { id: TtsVoiceId; displayName: string; description: string }
export interface TtsVoiceConfig { selectedId: TtsVoiceId; voices: TtsVoiceOption[] }
export interface DiarizationModelStatus { installed: boolean; runtimeAvailable: boolean; downloading: boolean; partialBytes: number; sizeBytes: number; removable: boolean }
export interface DownloadProgress { downloaded: number; total: number }
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
  checkAiProvider: (provider: AiKeyProvider) => invoke<AiProviderHealth>('check_ai_provider', { provider }),
  getTtsVoiceConfig: () => invoke<TtsVoiceConfig>('get_tts_voice_config'),
  setTtsVoice: (voiceId: TtsVoiceId) => invoke<TtsVoiceConfig>('set_tts_voice', { voiceId }),
  startWorker: () => invoke<void>('start_worker'),
  aiKeyStatus: (provider: AiKeyProvider) => invoke<'saved' | 'environment' | 'none'>('ai_key_status', { provider }),
  setAiApiKey: (provider: AiKeyProvider, apiKey: string | null) => invoke<'saved' | 'environment' | 'none'>('set_ai_api_key', { provider, apiKey }),
  accessKeyStatus: () => invoke<boolean>('access_key_status'),
  setAccessKey: (accessKey: string) => invoke<boolean>('set_access_key', { accessKey }),
  stopWorker: () => invoke<void>('stop_worker'),
  sendWorker: (payload: Record<string, unknown>) => invoke<void>('send_worker', { payload }),
  startCapture: (source: AudioInput) => invoke<void>('start_capture', { source }),
  stopCapture: () => invoke<void>('stop_capture'),
  playAudio: (chunks: AudioChunk[], rate: number) => invoke<void>('play_audio', { chunks, rate }),
  stopAudio: () => invoke<void>('stop_audio'),
  summarizeSegments: (segments: TranscriptSegment[], previousSummary?: StructuredMeetingSummary) =>
    invoke<StructuredMeetingSummary>('summarize_segments', { segments, previousSummary: previousSummary ?? null }),
  translateParagraph: (text: string, sourceLanguage: SpokenLanguage, previousContext: string) => invoke<string>('translate_text', { text, sourceLanguage, previousContext }),
  diarizationModelStatus: () => invoke<DiarizationModelStatus>('diarization_model_status'),
  downloadDiarizationModel: () => invoke<DiarizationModelStatus>('download_diarization_model'),
  cancelDiarizationDownload: () => invoke<void>('cancel_diarization_download'),
  removeDiarizationModel: () => invoke<DiarizationModelStatus>('remove_diarization_model'),
  onDiarizationDownload: (callback: (progress: DownloadProgress) => void): Promise<UnlistenFn> => listen<DownloadProgress>('diarization-download', e => callback(e.payload)),
  openPermission: (kind: 'microphone' | 'screen') => invoke<void>('open_permission', { kind }),
  onWorker: (callback: (event: WorkerMessage) => void): Promise<UnlistenFn> => listen<WorkerMessage>('worker-message', e => callback(e.payload)),
  onStatus: (callback: (status: string) => void): Promise<UnlistenFn> => listen<string>('worker-status', e => callback(e.payload)),
}
