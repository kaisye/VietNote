export type Page = 'home' | 'notes' | 'translate' | 'settings'
export type Appearance = 'system' | 'light' | 'dark'
/** Meeting setting; 'auto' lets Gemini Live Translate detect the spoken language. */
export type Language = 'auto' | 'zh' | 'en' | 'vi'
export type SpokenLanguage = Exclude<Language, 'auto'>
export type AudioInput = 'microphone' | 'system' | 'both'
export type Cadence = 'words' | 'minutes'

export interface NoteGroup { id: string; name: string }
export interface MeetingNote {
  id: string; title: string; createdAt: string; updatedAt: string; duration: number;
  summary: string; transcript: string; groupID?: string | null; isDemo?: boolean;
  structuredSummary?: StructuredMeetingSummary; transcriptSegments?: TranscriptSegment[]; saving?: boolean
}
export interface Subtitle {
  id: string; timestamp: string; sourceText: string; audioSource: string;
  translatedText: string; startedAt: number; generation: number; rawText?: string;
  endedAt?: number; speaker?: string | null; speakerProvisional?: boolean; language?: SpokenLanguage
}
export interface TranscriptSegment {
  id: string; timestamp: string; startedAt: number; audioSource: string;
  rawText: string; cleanText: string; endedAt?: number; speaker?: string | null; speakerProvisional?: boolean
}
export interface SummaryBullet { id: string; text: string; evidenceIds: string[] }
export interface UnresolvedTopic extends SummaryBullet { topic: string; options: string[]; status: 'No final decision' }
export interface ActionItem { id: string; owner?: string | null; task: string; deadline?: string | null; evidenceIds: string[] }
export interface DeferredItem extends SummaryBullet { target?: string | null }
export interface StructuredMeetingSummary {
  tldr: string;
  keyPoints: SummaryBullet[];
  decisions: SummaryBullet[];
  tentativeDecisions: SummaryBullet[];
  unresolvedTopics: UnresolvedTopic[];
  actionItems: ActionItem[];
  openQuestions: SummaryBullet[];
  deferred: DeferredItem[];
}
export interface TranslationBlock {
  id: string; entryIds: string[]; sourceText: string; translatedText: string;
  createdAt: string; pending: boolean
  /** 'live' = per-utterance Gemini Live Translate; otherwise an LLM paragraph translation (saved to notes). */
  kind?: 'live' | 'paragraph'
  failed?: boolean
}
export interface SummarySnapshot {
  id: string; createdAt: string; text: string; entryCount: number; isManual: boolean
}
export interface WorkerMessage {
  type: string; message?: string; generation?: number; source?: string; text?: string;
  raw_text?: string; started_at?: number; vi_model_ready?: boolean; tts_voice?: string;
  asr_backend?: string; asr_model?: string; id?: string; pcm?: string; sample_rate?: number; voice?: string;
  final?: boolean; live?: boolean; model?: string; language?: SpokenLanguage; pcm_format?: 'f32le' | 's16le';
  ready?: boolean; ended_at?: number; speaker?: string | null; speaker_provisional?: boolean
}
export interface InterimTranscript { id: string; text: string; source: string; startedAt: number; speaker?: string | null }
export interface LiveTranslation { id: string; text: string; source: string; startedAt: number; final: boolean }

/** Base64 little-endian PCM handed to the native player (f32 = ZeroTTS, s16 = Gemini Live). */
export type AudioChunk = { pcm: string; format: 'f32' | 's16'; sampleRate: number }
