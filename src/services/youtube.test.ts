import { describe, expect, it } from 'vitest'
import { batchOrder, captionLines, dubbable, dubRate, heardWords, lineAt, planBatches, speechLines, youtubeId, type CaptionPiece } from './youtube'

const words = (start: number, text: string, step = 0.3): CaptionPiece[] => text.split(' ').map((word, index) => ({ start: start + index * step, end: start + (index + 1) * step, text: word }))

describe('youtubeId', () => {
  it('reads the id from common links', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=arj7oStGLkU&t=4s')).toBe('arj7oStGLkU')
    expect(youtubeId('https://m.youtube.com/watch?feature=share&v=arj7oStGLkU')).toBe('arj7oStGLkU')
    expect(youtubeId('https://youtu.be/arj7oStGLkU?si=x')).toBe('arj7oStGLkU')
    expect(youtubeId('https://www.youtube.com/shorts/arj7oStGLkU')).toBe('arj7oStGLkU')
    expect(youtubeId('https://www.youtube.com/@channel')).toBeNull()
    expect(youtubeId('https://vimeo.com/76979871')).toBeNull()
  })
})

describe('captionLines', () => {
  it('joins lines made by people into sentences', () => {
    const lines = captionLines([
      { start: 12.6, end: 14, text: 'So in college,' },
      { start: 15.3, end: 16.9, text: 'I was a government major,' },
      { start: 16.9, end: 19.4, text: 'which means I had to write a lot of papers.' },
      { start: 19.4, end: 21.5, text: 'Now, when a normal student writes a paper,' },
    ], 'manual')
    expect(lines.map(line => line.source)).toEqual(['So in college, I was a government major, which means I had to write a lot of papers.', 'Now, when a normal student writes a paper,'])
    expect(lines[0]).toMatchObject({ start: 12.6, end: 19.4 })
  })

  it('splits recognised speech at pauses and keeps lines short', () => {
    const lines = captionLines([...words(1, 'this program is brought to you by Stanford University'), ...words(5, 'please visit us at stanford.edu')], 'auto')
    expect(lines.map(line => line.source)).toEqual(['this program is brought to you by Stanford University', 'please visit us at stanford.edu'])
    const long = captionLines(words(0, Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ')), 'auto')
    expect(long.length).toBeGreaterThan(2)
    expect(long.every(line => line.end - line.start <= 6 && line.source.length <= 90)).toBe(true)
  })

  it('keeps sound labels apart and Chinese without spaces', () => {
    const lines = captionLines([{ start: 0, end: 5, text: '[Music]' }, { start: 5, end: 5.4, text: '大家' }, { start: 5.4, end: 5.8, text: '好' }], 'auto')
    expect(lines.map(line => line.source)).toEqual(['[Music]', '大家好'])
  })
})

describe('lineAt', () => {
  const lines = [{ start: 1, end: 3, source: 'a' }, { start: 8, end: 9, source: 'b' }]
  it('shows a line slightly early and holds it briefly', () => {
    expect(lineAt(lines, 0.5)).toBe(-1)
    expect(lineAt(lines, 0.85)).toBe(0)
    expect(lineAt(lines, 4.2)).toBe(0)
    expect(lineAt(lines, 5)).toBe(-1)
    expect(lineAt(lines, 8.5)).toBe(1)
  })
})

describe('batchOrder', () => {
  it('translates from the batch being watched, then the earlier ones', () => {
    expect(batchOrder(5, 2)).toEqual([2, 3, 4, 1, 0])
    expect(batchOrder(3, 0)).toEqual([0, 1, 2])
    expect(batchOrder(0, 0)).toEqual([])
  })
})

describe('planBatches', () => {
  it('cuts recognised words at the longest pause and times the translated subtitles by their words', () => {
    const pieces = Array.from({ length: 200 }, (_, index) => ({ start: index * 0.4 + (index === 45 ? 2 : 0) + (index > 45 ? 2 : 0), end: index * 0.4 + 0.3 + (index >= 45 ? 2 : 0), text: `w${index}` }))
    const batches = planBatches({ pieces, kind: 'auto', language: 'en' })
    expect(batches[0].words).toHaveLength(45)
    expect(batches.flatMap(batch => batch.words!)).toHaveLength(200)
    expect(batches[0].draft.every(line => line.translation === undefined)).toBe(true)
    const lines = speechLines(batches[0].words!, [{ from: 0, source: 'W0 w1.', translation: 'một' }, { from: 2, source: '', translation: 'hai' }])
    expect(lines[0]).toEqual({ start: 0, end: 0.7, source: 'W0 w1.', translation: 'một' })
    expect(lines[1]).toMatchObject({ start: 0.8, source: expect.stringMatching(/^w2 w3/), translation: 'hai' })
  })

  it('needs no translation for Vietnamese captions', () => {
    const batches = planBatches({ pieces: words(0, 'xin chào các bạn'), kind: 'auto', language: 'vi' })
    expect(batches[0].words).toBeUndefined()
    expect(batches[0].draft[0].translation).toBe('xin chào các bạn')
    const manual = planBatches({ pieces: Array.from({ length: 45 }, (_, index) => ({ start: index * 3, end: index * 3 + 2, text: `Line ${index}.` })), kind: 'manual', language: 'en' })
    expect(manual.map(batch => batch.draft.length)).toEqual([20, 20, 5])
  })
})

describe('heardWords', () => {
  it('joins parts of words and finds the spoken language', () => {
    const { pieces, language } = heardWords([['Stan', 0, 200, '1', 'en', 0], ['ford', 200, 450, '1', 'en', 0], [' is', 500, 600, '1', 'en', 0], [' great.', 600, 900, '1', 'en', 0], [' tuyệt', 600, 900, null, 'vi', 1], ['Hola', 1200, 1500, '1', 'es', 0]])
    expect(pieces.map(piece => piece.text)).toEqual(['Stanford', 'is', 'great.', 'Hola'])
    expect(pieces[0]).toEqual({ start: 0, end: 0.45, text: 'Stanford' })
    expect(language).toBe('en')
  })
})

describe('dubbing', () => {
  it('reads at normal pace when the line fits, faster when it runs long', () => {
    expect(dubRate(2, 4)).toBe(1)
    expect(dubRate(4, 3.15)).toBeCloseTo(4 / 3)
    expect(dubRate(10, 2)).toBe(1.6)
  })
  it('does not read sound labels', () => {
    expect(dubbable({ start: 0, end: 1, source: '[Music]', translation: '[Nhạc]' })).toBe(false)
    expect(dubbable({ start: 0, end: 1, source: '(Laughter)', translation: 'Tiếng cười' })).toBe(false)
    expect(dubbable({ start: 0, end: 1, source: 'hi', translation: 'xin chào' })).toBe(true)
    expect(dubbable({ start: 0, end: 1, source: 'hi' })).toBe(false)
  })
})
