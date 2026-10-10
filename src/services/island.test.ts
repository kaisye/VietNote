import { describe, expect, it } from 'vitest'
import { islandChat, islandLines, openFrame, PILL, pillForPanel, pillRect, screenAt, snapPlacement, startScreen, subtitleDocks, subtitleFor, subtitleRect, type IslandScreen } from './island'
import type { Subtitle, TranslationBlock } from './types'

const laptop: IslandScreen = {
  key: 'laptop', primary: true, notch: { width: 200, height: 32 },
  frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 32, width: 1512, height: 880 },
}
const monitor: IslandScreen = {
  key: 'monitor', primary: false, notch: null,
  frame: { x: 1512, y: 0, width: 1920, height: 1080 }, visible: { x: 1512, y: 25, width: 1920, height: 1055 },
}

describe('island placement', () => {
  it('hugs the notch, and sits below the menu bar on a display without one', () => {
    expect(pillRect(laptop, { anchor: 'notch' })).toEqual({ x: 590, y: 0, width: 332, height: 32 })
    expect(pillRect(monitor, { anchor: 'notch' })).toEqual({ x: 1512 + (1920 - PILL.width) / 2, y: 37, ...PILL })
  })

  it('snaps a drop near a corner and keeps a drop in the open where it fell', () => {
    expect(snapPlacement(laptop, { x: 1290, y: 860, ...PILL })).toEqual({ anchor: 'bottom-right' })
    expect(snapPlacement(laptop, { x: 700, y: 30, ...PILL })).toEqual({ anchor: 'notch' })
    expect(snapPlacement(laptop, { x: 400, y: 400, ...PILL })).toEqual({ anchor: null, dx: 400, dy: 400 })
    // Dropped half off the screen, it is pulled back inside the visible area.
    expect(snapPlacement(laptop, { x: 600, y: 960, ...PILL })).toEqual({ anchor: null, dx: 600, dy: 912 - PILL.height })
  })

  it('grows down from the top half and up from the bottom half, staying on screen', () => {
    const top = openFrame(laptop, pillRect(laptop, { anchor: 'notch' }), { width: 520, height: 540 })
    expect(top).toEqual({ growsUp: false, frame: { x: 496, y: 0, width: 520, height: 540 } })
    const corner = openFrame(laptop, pillRect(laptop, { anchor: 'bottom-right' }), { width: 520, height: 540 })
    expect(corner.growsUp).toBe(true)
    expect(corner.frame.x + corner.frame.width).toBe(1512 - 12)
    expect(corner.frame.y + corner.frame.height).toBe(912 - 12)
  })

  it('places a dragged open island by the pill it opens from, so it can return to the notch', () => {
    const nearTop = { x: 480, y: 20, width: 520, height: 540 }
    expect(snapPlacement(laptop, pillForPanel(laptop, nearTop))).toEqual({ anchor: 'notch' })
    const low = { x: 200, y: 400, width: 520, height: 540 }
    const placement = snapPlacement(laptop, pillForPanel(laptop, low))
    // Reopened from that pill, the panel lands where it was dropped, nudged up off the Dock.
    expect(openFrame(laptop, pillRect(laptop, placement), { width: 520, height: 540 }).frame).toEqual({ ...low, y: 400 - 28 })
  })

  it('finds the display under a point and prefers the last one used', () => {
    expect(screenAt([laptop, monitor], { x: 2000, y: 300 })?.key).toBe('monitor')
    expect(screenAt([laptop, monitor], { x: 5000, y: 300 })?.key).toBe('monitor')
    expect(startScreen([monitor, laptop], 'monitor').key).toBe('monitor')
    expect(startScreen([monitor, laptop], 'gone').key).toBe('laptop')
  })
})

const entry = (id: string, sourceText: string): Subtitle => ({ id, timestamp: '2026-10-10T09:00:00Z', sourceText, audioSource: 'system', translatedText: '', startedAt: 0, generation: 1 })

describe('island content', () => {
  it('pairs lines with their translation and appends speech still being recognized', () => {
    const blocks: TranslationBlock[] = [
      { id: 'b1', entryIds: ['e1'], sourceText: 'Hello', translatedText: 'Xin chào', createdAt: '', pending: false, kind: 'live' },
      { id: 'i2', entryIds: [], sourceText: '', translatedText: 'Đang dịch', createdAt: '', pending: true, kind: 'live' },
    ]
    const lines = islandLines([entry('e1', 'Hello')], [
      { id: 'i1', text: 'How are', source: 'system', startedAt: 0 },
      { id: 'i2', text: 'Nice to', source: 'microphone', startedAt: 0 },
    ], blocks)
    // Source text streams right away; the live translation joins it when it arrives.
    expect(lines).toEqual([
      { id: 'e1', text: 'Hello', translation: 'Xin chào', speaker: undefined },
      { id: 'i1', text: 'How are', translation: undefined, speaker: undefined, interim: true },
      { id: 'i2', text: 'Nice to', translation: 'Đang dịch', speaker: undefined, interim: true },
    ])
    expect(islandLines(Array.from({ length: 5 }, (_, index) => entry(`e${index}`, 'x')), [], [], 3).map(line => line.id)).toEqual(['e2', 'e3', 'e4'])
  })

  it('shows the question in flight, or else the last answered one', () => {
    const at = '2026-10-10T09:00:00Z'
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'Ý chính?', createdAt: at },
      { id: 'a1', role: 'assistant' as const, content: 'Ba ý.', createdAt: at },
    ]
    expect(islandChat(messages, null)).toEqual({ question: 'Ý chính?', quote: undefined, answer: 'Ba ý.', pending: false })
    expect(islandChat(messages, { pending: true, request: { question: 'Dịch', label: 'Dịch', quote: 'Hello' }, answer: { answer: 'Xin', evidenceIds: [] } }))
      .toEqual({ question: 'Dịch', quote: 'Hello', answer: 'Xin', pending: true, error: undefined })
    expect(islandChat([], null)).toBeNull()
  })
})

describe('subtitle mode', () => {
  it('sits bottom-center above the player controls, or where it was dragged', () => {
    expect(subtitleRect(laptop)).toEqual({ x: 326, y: 912 - 190 - 96, width: 860, height: 190 })
    expect(subtitleRect(laptop, { dx: 5000, dy: 100 })).toEqual({ x: 1512 - 860, y: 100, width: 860, height: 190 })
    // Dragged up to the top centre, it docks back into the island; elsewhere along the top it doesn't.
    expect(subtitleDocks(laptop, { x: 326 + 60, y: laptop.visible.y + 10, width: 860, height: 190 })).toBe(true)
    expect(subtitleDocks(laptop, { x: 326, y: 400, width: 860, height: 190 })).toBe(false)
    expect(subtitleDocks(laptop, { x: 0, y: laptop.visible.y, width: 860, height: 190 })).toBe(false)
    // Dropped near the centre line or the usual height, the caption snaps onto it.
    expect(subtitleRect(laptop, { dx: 326 + 40, dy: 912 - 190 - 96 - 50 })).toEqual(subtitleRect(laptop))
    expect(subtitleRect(laptop, { dx: 326 + 40, dy: 100 })).toEqual({ x: 326, y: 100, width: 860, height: 190 })
    expect(subtitleRect(laptop, { dx: 100, dy: 912 - 190 - 96 + 30 })).toEqual({ x: 100, y: 912 - 190 - 96, width: 860, height: 190 })
  })

  it('captions the sentence being spoken, keeping the last translation until the new one arrives', () => {
    const done = { id: 'a', text: 'Hello there.', translation: 'Xin chào.' }
    const speaking = { id: 'b', text: 'How are', interim: true }
    expect(subtitleFor([done, speaking], true)).toEqual({ id: 'b', source: 'How are', translation: 'Xin chào.', translationLags: true })
    expect(subtitleFor([done, { ...speaking, translation: 'Bạn' }], true)).toEqual({ id: 'b', source: 'How are', translation: 'Bạn', translationLags: false })
    expect(subtitleFor([done, speaking], false)).toEqual({ id: 'b', source: 'How are', translation: undefined, translationLags: false })
    expect(subtitleFor([], true)).toBeNull()
  })
})
