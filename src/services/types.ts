export type Page = 'home' | 'notes' | 'translate' | 'settings'
export type Appearance = 'system' | 'light' | 'dark'
export type Language = 'zh' | 'en' | 'vi'
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
  translatedText: string; startedAt: number; generation: number; rawText?: string
}
export interface TranscriptSegment {
  id: string; timestamp: string; startedAt: number; audioSource: string;
  rawText: string; cleanText: string
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
}
export interface SummarySnapshot {
  id: string; createdAt: string; text: string; entryCount: number; isManual: boolean
}
export interface WorkerMessage {
  type: string; message?: string; generation?: number; source?: string; text?: string;
  raw_text?: string; started_at?: number; vi_model_ready?: boolean; tts_voice?: string;
  asr_backend?: string; asr_model?: string; id?: string; pcm?: string; sample_rate?: number; voice?: string
}
