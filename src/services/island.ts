import { liveActions, type LiveQuestion } from './liveChat'
import { visibleTranslation } from './translationView'
import type { AudioInput, InterimTranscript, NoteChatMessage, Subtitle, TranslationBlock } from './types'
import type { LiveChatStatus } from '../hooks/useLiveChat'
import type { SpeechVoice } from '../hooks/useSpeech'

/**
 * VietNote Island: the floating pill that shows the live transcript over other apps.
 * The main window owns the meeting and streams an `IslandState` to the island window;
 * the island sends questions and commands back. Placement math lives here so it can be tested.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface IslandScreen { key: string; frame: Rect; visible: Rect; notch: Size | null; primary: boolean }

export type Level = 'collapsed' | 'peek' | 'expanded'
export type Anchor = 'notch' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'left' | 'right'
/** Snapped to an anchor, or left where it was dropped (offset from the screen's corner). */
export type Placement = { anchor: Anchor } | { anchor: null; dx: number; dy: number }

export const PILL: Size = { width: 196, height: 38 }
export const LEVEL_SIZE: Record<Exclude<Level, 'collapsed'>, Size> = { peek: { width: 460, height: 178 }, expanded: { width: 520, height: 540 } }
/** Room on each side of the camera housing for the logo and the wave. */
const NOTCH_WING = 66
const MARGIN = 12
/** Dropped this close to an anchor, the pill snaps to it. */
export const SNAP_DISTANCE = 130
const anchors: Anchor[] = ['notch', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'left', 'right']

const center = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

/** At the notch the pill hugs the camera housing; everywhere else it is a plain pill. */
export const atNotch = (screen: IslandScreen, placement: Placement) => placement.anchor === 'notch' && screen.notch !== null

export function pillSize(screen: IslandScreen, placement: Placement): Size {
  return atNotch(screen, placement) && screen.notch ? { width: screen.notch.width + 2 * NOTCH_WING, height: screen.notch.height } : PILL
}

function anchorRect(screen: IslandScreen, anchor: Anchor, size: Size): Rect {
  const { frame, visible } = screen
  const left = visible.x + MARGIN, right = visible.x + visible.width - size.width - MARGIN
  const top = visible.y + MARGIN, bottom = visible.y + visible.height - size.height - MARGIN
  const middle = visible.y + (visible.height - size.height) / 2
  const at = (x: number, y: number) => ({ x, y, ...size })
  switch (anchor) {
    case 'notch': return at(frame.x + (frame.width - size.width) / 2, screen.notch ? frame.y : top)
    case 'top-left': return at(left, top)
    case 'top-right': return at(right, top)
    case 'bottom-left': return at(left, bottom)
    case 'bottom-right': return at(right, bottom)
    case 'left': return at(left, middle)
    case 'right': return at(right, middle)
  }
}

/** Where the collapsed pill sits on `screen`. */
export function pillRect(screen: IslandScreen, placement: Placement): Rect {
  const size = pillSize(screen, placement)
  if (placement.anchor) return anchorRect(screen, placement.anchor, size)
  const { visible } = screen
  return {
    x: clamp(screen.frame.x + placement.dx, visible.x, visible.x + visible.width - size.width),
    y: clamp(screen.frame.y + placement.dy, visible.y, visible.y + visible.height - size.height),
    ...size,
  }
}

/** Snaps a dropped pill to the nearest anchor within reach, otherwise keeps it where it is. */
export function snapPlacement(screen: IslandScreen, dropped: Rect): Placement {
  const point = center(dropped)
  let best: { anchor: Anchor; distance: number } | null = null
  for (const anchor of anchors) {
    const target = center(anchorRect(screen, anchor, PILL))
    const distance = Math.hypot(target.x - point.x, target.y - point.y)
    if (!best || distance < best.distance) best = { anchor, distance }
  }
  if (best && best.distance <= SNAP_DISTANCE) return { anchor: best.anchor }
  const rect = pillRect(screen, { anchor: null, dx: dropped.x - screen.frame.x, dy: dropped.y - screen.frame.y })
  return { anchor: null, dx: rect.x - screen.frame.x, dy: rect.y - screen.frame.y }
}

/** The pill an opened island was dragged from: its top edge when it grows down, its bottom edge when it grows up. */
export function pillForPanel(screen: IslandScreen, panel: Rect): Rect {
  const growsUp = center(panel).y > screen.frame.y + screen.frame.height / 2
  return { x: center(panel).x - PILL.width / 2, y: growsUp ? panel.y + panel.height - PILL.height : panel.y, ...PILL }
}

/** The display under `point`, or the closest one. */
export function screenAt(screens: IslandScreen[], point: { x: number; y: number }): IslandScreen | undefined {
  const distance = (screen: IslandScreen) => {
    const { x, y, width, height } = screen.frame
    return Math.hypot(Math.max(x - point.x, 0, point.x - x - width), Math.max(y - point.y, 0, point.y - y - height))
  }
  return [...screens].sort((a, b) => distance(a) - distance(b))[0]
}

/**
 * The window frame for an opened island. It grows away from the pill: down from the top half
 * of the screen, up from the bottom half, and stays centered on the pill unless that would
 * push it off the screen.
 */
export function openFrame(screen: IslandScreen, pill: Rect, size: Size): { frame: Rect; growsUp: boolean } {
  const { frame: bounds } = screen
  const width = Math.min(size.width, bounds.width - 2 * MARGIN)
  const height = Math.min(size.height, bounds.height - 2 * MARGIN)
  const growsUp = center(pill).y > bounds.y + bounds.height / 2
  const x = clamp(center(pill).x - width / 2, bounds.x + MARGIN, bounds.x + bounds.width - width - MARGIN)
  const y = clamp(growsUp ? pill.y + pill.height - height : pill.y, bounds.y, bounds.y + bounds.height - height)
  return { frame: { x, y, width, height }, growsUp }
}

/** The screen to start on: the one used last, else the one with the notch, else the main one. */
export function startScreen(screens: IslandScreen[], last?: string) {
  return screens.find(screen => screen.key === last) ?? screens.find(screen => screen.notch) ?? screens.find(screen => screen.primary) ?? screens[0]
}

// ---- Subtitle mode ----------------------------------------------------------------------

export type IslandMode = 'island' | 'subtitle'
// Taller than the caption so the language menu can open above it.
export const SUBTITLE: Size = { width: 860, height: 190 }
/** Room left under the band for a video player's own controls. */
const SUBTITLE_LIFT = 96

/** The subtitle band: bottom-center by default, or where it was dragged on this display. */
export function subtitleRect(screen: IslandScreen, offset?: { dx: number; dy: number }): Rect {
  const { frame, visible } = screen
  const width = Math.min(SUBTITLE.width, visible.width - 2 * MARGIN), height = SUBTITLE.height
  const x = offset ? frame.x + offset.dx : visible.x + (visible.width - width) / 2
  const y = offset ? frame.y + offset.dy : visible.y + visible.height - height - SUBTITLE_LIFT
  return { x: clamp(x, visible.x, visible.x + visible.width - width), y: clamp(y, visible.y, visible.y + visible.height - height), width, height }
}

export interface Caption { id: string; source: string; translation?: string; translationLags: boolean }
/**
 * The caption to show: the sentence being spoken now, and its translation. Translation runs a
 * moment behind speech, so until the new sentence has one the previous sentence's stays up.
 */
export function subtitleFor(lines: IslandLine[], showTranslation: boolean): Caption | null {
  const latest = lines.at(-1)
  if (!latest) return null
  const previous = lines.at(-2)
  const lagging = !latest.translation && Boolean(previous?.translation)
  return {
    id: latest.id, source: latest.text,
    translation: showTranslation ? latest.translation ?? previous?.translation : undefined,
    translationLags: showTranslation && lagging,
  }
}

// ---- What the island shows -------------------------------------------------------------

export interface IslandLine { id: string; text: string; translation?: string; speaker?: string | null; interim?: boolean }
export interface IslandChat { question?: string; quote?: string; answer?: string; pending: boolean; error?: string }
export interface IslandState {
  /** A meeting or translation is running. */
  active: boolean; capturing: boolean; status: string; canStart: boolean
  /** Whether foreign speech is being translated; Vietnamese meetings have nothing to translate. */
  translation: 'on' | 'off' | 'unavailable'
  /** Where sound comes from: the sources switched on while recording, the chosen input otherwise. */
  source: AudioInput | null
  /** Reading translations aloud; null where there is no translation to read. */
  speech: { enabled: boolean; loading: boolean; voice: SpeechVoice } | null
  lines: IslandLine[]; chat: IslandChat | null
}

/** Enough history to scroll back through a video without flooding the event bridge. */
export const MAX_LINES = 200

export function islandLines(entries: Subtitle[], interim: InterimTranscript[], blocks: TranslationBlock[], max = MAX_LINES): IslandLine[] {
  const lines: IslandLine[] = entries.slice(-max).map(entry => ({
    id: entry.id, text: entry.sourceText, translation: visibleTranslation(blocks, entry.id)?.translatedText || undefined, speaker: entry.speaker,
  }))
  for (const item of interim) {
    const translation = blocks.find(block => block.kind === 'live' && block.id === item.id)?.translatedText || undefined
    lines.push({ id: item.id, text: item.text, translation, speaker: item.speaker, interim: true })
  }
  return lines.slice(-max)
}

/** The exchange in progress, or the latest finished one. */
export function islandChat(messages: NoteChatMessage[], status: LiveChatStatus | null): IslandChat | null {
  if (status) return {
    question: status.request.label ?? status.request.question, quote: status.request.quote,
    answer: status.answer?.answer, pending: status.pending, error: status.error,
  }
  let answer = messages.length - 1
  while (answer >= 0 && messages[answer].role !== 'assistant') answer--
  if (answer < 0) return null
  const question = messages[answer - 1]?.role === 'user' ? messages[answer - 1] : undefined
  return { question: question?.content, quote: question?.quote, answer: messages[answer].content, pending: false }
}

/** One-tap actions on a line picked in the island; the learner-oriented set. */
export const islandActions = [
  ...liveActions.filter(action => action.id !== 'reply'),
  { id: 'vocab', label: 'Từ vựng', question: 'Chọn các từ và cụm từ đáng học trong đoạn trích. Với mỗi mục ghi: nghĩa tiếng Việt theo ngữ cảnh, phiên âm IPA, và một câu ví dụ ngắn.' },
] as const

// ---- Bridge between the main window and the island --------------------------------------

export const islandEvents = {
  state: 'island:state', hello: 'island:hello', ask: 'island:ask', start: 'island:start', stop: 'island:stop', source: 'island:source',
  dismiss: 'island:dismiss', translate: 'island:translate', speech: 'island:speech', voice: 'island:voice', enabled: 'island:enabled', shortcut: 'island:shortcut',
} as const
export type IslandAsk = LiveQuestion

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent)

const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* Keep working without storage. */ } }

/** On by default on macOS, where the island is available. */
export const islandEnabled = () => isMac && read('islandEnabled') !== 'false'
export const saveIslandEnabled = (enabled: boolean) => write('islandEnabled', String(enabled))
export const islandMode = (): IslandMode => read('islandMode') === 'subtitle' ? 'subtitle' : 'island'
export const saveIslandMode = (mode: IslandMode) => write('islandMode', mode)
type Offsets = Record<string, { dx: number; dy: number }>
export const subtitleOffsets = (): Offsets => { try { return JSON.parse(read('islandSubtitle') ?? '{}') as Offsets } catch { return {} } }
export const saveSubtitleOffset = (screenKey: string, dx: number, dy: number) => write('islandSubtitle', JSON.stringify({ ...subtitleOffsets(), [screenKey]: { dx, dy } }))
export const islandPinned = () => read('islandPinned') === 'true'
export const saveIslandPinned = (pinned: boolean) => write('islandPinned', String(pinned))
/** What the island and subtitles show: the spoken language, the Vietnamese translation, or both. */
export type Display = 'source' | 'vietnamese' | 'both'
export const sourceOptions: { value: AudioInput; label: string }[] = [
  { value: 'system', label: 'Âm thanh máy' }, { value: 'microphone', label: 'Micro' }, { value: 'both', label: 'Cả hai' },
]
export function activeSource(microphone: boolean, system: boolean): AudioInput | null {
  return microphone && system ? 'both' : microphone ? 'microphone' : system ? 'system' : null
}
export const displayOptions: { value: Display; label: string }[] = [
  { value: 'source', label: 'Tiếng gốc' }, { value: 'vietnamese', label: 'Tiếng Việt' }, { value: 'both', label: 'Song ngữ' },
]
export function islandDisplay(): Display {
  const saved = read('islandDisplay')
  if (saved === 'source' || saved === 'vietnamese' || saved === 'both') return saved
  return read('islandTranslation') === 'false' ? 'source' : 'both'
}
export const saveIslandDisplay = (display: Display) => write('islandDisplay', display)
/** Without a translation running there is only the spoken language to show. */
export const shownDisplay = (display: Display, translation: IslandState['translation'] | undefined): Display => translation === 'on' ? display : 'source'

interface StoredPlacements { last?: string; screens: Record<string, Placement> }
export function loadPlacements(): StoredPlacements {
  try {
    const parsed = JSON.parse(read('islandPlacement') ?? '') as StoredPlacements
    return parsed && typeof parsed.screens === 'object' ? parsed : { screens: {} }
  } catch { return { screens: {} } }
}
/** Each display remembers where the pill was left on it. */
export function savePlacement(screenKey: string, placement: Placement) {
  const stored = loadPlacements()
  write('islandPlacement', JSON.stringify({ last: screenKey, screens: { ...stored.screens, [screenKey]: placement } }))
}
