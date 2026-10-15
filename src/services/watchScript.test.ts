import { describe, expect, it } from 'vitest'
import { collectWatched } from './watchScript'

const lines = [
  { start: 0, end: 1, source: 'First' },
  { start: 1, end: 2, source: 'Second' },
  { start: 2, end: 3, source: 'Third' },
  { start: 20, end: 21, source: 'After seek' },
]

describe('watched script history', () => {
  it('keeps watched lines but does not reveal those skipped by a seek', () => {
    const first = collectWatched([], lines, -1, 0.3)
    const next = collectWatched(first, lines, 0.3, 2.2)
    expect(next.map(line => line.source)).toEqual(['First', 'Second', 'Third'])
    expect(collectWatched(next, lines, 2.2, 20.2).map(line => line.source)).toEqual(['First', 'Second', 'Third', 'After seek'])
  })
  it('updates a watched line when its translation arrives', () => {
    const watched = collectWatched([], lines, -1, 0.3)
    const updated = lines.map((line, index) => index ? line : { ...line, translation: 'Đầu tiên' })
    expect(collectWatched(watched, updated, 20.2, 20.3)[0].translation).toBe('Đầu tiên')
    expect(collectWatched(watched, updated, 0.3, 0.3).filter(line => line.start === 0)).toHaveLength(1)
  })
})
