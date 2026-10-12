import { describe, expect, it } from 'vitest'
import { firstSounds } from './useSpeech'

// Base64 of `seconds` of 32-bit samples at 1 kHz.
const chunk = (seconds: number) => ({ pcm: 'A'.repeat(seconds * 1000 * 4 * 4 / 3), format: 'f32' as const, sampleRate: 1000 })

describe('firstSounds', () => {
  it('starts each phrase after what is already playing and the phrases before it', () => {
    const batch = [{ key: 'a#0', chunk: chunk(1.5) }, { key: 'a#0', chunk: chunk(0.5) }, { key: 'a#20', chunk: chunk(1) }]
    // 3 s of this batch behind 4 s still playing.
    const starts = firstSounds(batch, 7, 1)
    expect([...starts.keys()]).toEqual(['a#0', 'a#20'])
    expect(starts.get('a#0')).toBeCloseTo(4)
    expect(starts.get('a#20')).toBeCloseTo(6)
    // Read faster, the batch lasts 2 s: it starts 1 s from now and its second phrase 4/3 s later.
    expect(firstSounds(batch, 3, 1.5).get('a#20')).toBeCloseTo(1 + 4 / 3)
  })
})
