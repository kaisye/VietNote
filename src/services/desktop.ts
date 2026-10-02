import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AudioInput, SpokenLanguage, MeetingNote, NoteGroup, StructuredMeetingSummary, TranscriptSegment, WorkerMessage } from './types'

export interface StoredNotes { notes: MeetingNote[]; groups: NoteGroup[] }
export interface AccountStatus { configured: boolean; email: string | null; balanceSeconds: number | null }
export interface CreditOffer { id: string; name: string; hours: number; bonus_hours: number; price_vnd: number; original_price_vnd: number | null; promo_label: string | null; promo_ends_at: string | null; highlight: boolean }
export interface OrderStatus { status: 'pending' | 'paid' | 'cancelled'; balance_seconds: number | null }
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
  startWorker: () => invoke<void>('start_worker'),
  accountSignedIn: () => invoke<boolean>('account_signed_in'),
  accountStatus: () => invoke<AccountStatus>('account_status'),
  accountSendCode: (email: string) => invoke<void>('account_send_code', { email }),
  accountVerify: (email: string, code: string) => invoke<void>('account_verify', { email, code }),
  accountSignOut: () => invoke<void>('account_sign_out'),
  accountOffers: () => invoke<CreditOffer[]>('account_offers'),
  accountBuy: (packageId: string) => invoke<number>('account_buy', { packageId }),
  accountOrderStatus: (orderCode: number) => invoke<OrderStatus>('account_order_status', { orderCode }),
  stopWorker: () => invoke<void>('stop_worker'),
  sendWorker: (payload: Record<string, unknown>) => invoke<void>('send_worker', { payload }),
  startCapture: (source: AudioInput) => invoke<void>('start_capture', { source }),
  stopCapture: () => invoke<void>('stop_capture'),
  summarizeSegments: (segments: TranscriptSegment[], previousSummary?: StructuredMeetingSummary) =>
    invoke<StructuredMeetingSummary>('summarize_segments', { segments, previousSummary: previousSummary ?? null }),
  suggestTitle: (transcript: string) => invoke<string>('suggest_title', { transcript }),
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
