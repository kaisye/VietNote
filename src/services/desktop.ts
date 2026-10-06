import { invoke, Channel } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AudioInput, SpokenLanguage, MeetingNote, NoteGroup, StructuredMeetingSummary, TranscriptSegment, WorkerMessage } from './types'

export interface NoteChatRequest {
  title: string; summary: string; transcript: string; segments: TranscriptSegment[];
  history: { role: 'user' | 'assistant'; content: string }[]; question: string
  quote?: string; live?: boolean
}
export interface NoteChatAnswer { answer: string; evidenceIds: string[]; incomplete?: boolean }
export interface StoredNotes { notes: MeetingNote[]; groups: NoteGroup[] }
export interface AccountStatus { configured: boolean; email: string | null; balanceSeconds: number | null }
export interface CreditOffer { id: string; name: string; hours: number; bonus_hours: number; price_vnd: number; original_price_vnd: number | null; promo_label: string | null; promo_ends_at: string | null; highlight: boolean }
export interface OrderStatus { status: 'pending' | 'paid' | 'cancelled'; balance_seconds: number | null }
export interface DiarizationModelStatus { installed: boolean; runtimeAvailable: boolean; downloading: boolean; partialBytes: number; sizeBytes: number; removable: boolean }
export interface DownloadProgress { downloaded: number; total: number }
const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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
  setMicrophone: (enabled: boolean) => invoke<void>('set_microphone', { enabled }),
  setSystemAudio: (enabled: boolean) => invoke<void>('set_system_audio', { enabled }),
  summarizeSegments: (segments: TranscriptSegment[], previousSummary?: StructuredMeetingSummary) =>
    invoke<StructuredMeetingSummary>('summarize_segments', { segments, previousSummary: previousSummary ?? null }),
  askNote: (request: NoteChatRequest, onProgress?: (answer: NoteChatAnswer) => void) => {
    const onProgressChannel = new Channel<NoteChatAnswer>()
    onProgressChannel.onmessage = answer => onProgress?.(answer)
    return invoke<NoteChatAnswer>('ask_note', { request, onProgress: onProgressChannel })
  },
  suggestTitle: (transcript: string) => invoke<string>('suggest_title', { transcript }),
  translateParagraph: (text: string, sourceLanguage: SpokenLanguage, previousContext: string) => invoke<string>('translate_text', { text, sourceLanguage, previousContext }),
  diarizationModelStatus: () => invoke<DiarizationModelStatus>('diarization_model_status'),
  downloadDiarizationModel: () => invoke<DiarizationModelStatus>('download_diarization_model'),
  cancelDiarizationDownload: () => invoke<void>('cancel_diarization_download'),
  removeDiarizationModel: () => invoke<DiarizationModelStatus>('remove_diarization_model'),
  onDiarizationDownload: (callback: (progress: DownloadProgress) => void): Promise<UnlistenFn> => listen<DownloadProgress>('diarization-download', e => callback(e.payload)),
  openPermission: (kind: 'microphone' | 'screen') => invoke<void>('open_permission', { kind }),
  /** Native Save dialog; resolves to the saved path, or null when cancelled. */
  saveExport: (fileName: string, data: string) => invoke<string | null>('save_export', { fileName, data }),
  revealFile: (path: string) => invoke<void>('reveal_file', { path }),
  printPage: () => invoke<void>('print_page'),
  /** macOS only: renders the page's print view straight to a PDF the user picks. */
  savePdf: (fileName: string) => invoke<string | null>('save_pdf', { fileName }),
  openLink: (url: string) => invoke<void>('open_link', { url }),
  onWorker: (callback: (event: WorkerMessage) => void): Promise<UnlistenFn> => listen<WorkerMessage>('worker-message', e => callback(e.payload)),
  onStatus: (callback: (status: string) => void): Promise<UnlistenFn> => listen<string>('worker-status', e => callback(e.payload)),
}
