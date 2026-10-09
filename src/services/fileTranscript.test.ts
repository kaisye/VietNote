import { describe, expect, it } from 'vitest'
import { buildFileTranscript, fileCost, fileNoteTranscript, type FileToken } from './fileTranscript'

const original = (text: string, start: number, speaker = '1'): FileToken => [text, start, start + 200, speaker, 'en', 0]
const translated = (text: string): FileToken => [text, 0, 0, '1', 'vi', 1]

describe('file transcripts', () => {
  it('splits lines on a speaker change and a long pause', () => {
    const { segments } = buildFileTranscript([
      original('Hello', 0), original(' team', 300),
      original(' Hi', 800, '2'),
      original(' later', 4000, '2'),
    ], Date.UTC(2026, 9, 9, 2, 0))
    expect(segments.map(segment => [segment.cleanText, segment.speaker])).toEqual([['Hello team', 'Người nói 1'], ['Hi', 'Người nói 2'], ['later', 'Người nói 2']])
    expect(segments[0].audioSource).toBe('file')
    expect(segments[1].timestamp).toBe(new Date(Date.UTC(2026, 9, 9, 2, 0) + 800).toISOString())
  })

  it('attaches each translation run to the lines it follows', () => {
    const { segments, paragraphs } = buildFileTranscript([
      original('Ship', 0), original(' it.', 200), translated('Phát'), translated(' hành.'),
      original(' Then', 600, '2'), original(' test.', 800, '2'), translated('Rồi'), translated(' kiểm thử.'),
    ], 0)
    expect(paragraphs).toEqual([
      { entryIds: [segments[0].id], translatedText: 'Phát hành.' },
      { entryIds: [segments[1].id], translatedText: 'Rồi kiểm thử.' },
    ])
    expect(fileNoteTranscript(segments, paragraphs)).toContain('ĐOẠN 2\nRồi kiểm thử.')
  })

  it('joins translation runs that belong to the same line', () => {
    const { paragraphs } = buildFileTranscript([
      original('Good', 0), original(' morning.', 200), translated('Chào'), translated(' buổi sáng.'),
      original(' Today', 500), original(' we decide.', 700), translated('Hôm nay'), translated(' ta quyết định.'),
    ], 0)
    expect(paragraphs).toEqual([{ entryIds: ['file-1'], translatedText: 'Chào buổi sáng. Hôm nay ta quyết định.' }])
  })

  it('splits a long monologue at a sentence end', () => {
    const words = Array.from({ length: 45 }, (_, index) => original(index === 44 ? ' end.' : ` w${index}`, index * 300))
    const { segments } = buildFileTranscript([...words, original(' Next', 45 * 300)], 0)
    expect(segments).toHaveLength(2)
    expect(segments[1].cleanText).toBe('Next')
  })

  it('charges 75% of the recording, rounded up', () => {
    expect(fileCost(3600)).toBe(2700)
    expect(fileCost(1)).toBe(1)
  })
})
