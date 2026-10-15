import { describe, expect, it } from 'vitest'
import { billablePlayback } from './watchUsage'

describe('Watch Video usage', () => {
  it('charges actual forward playback at 100%', () => {
    expect(billablePlayback(10, 11, true, 'manual')).toBe(1)
    expect(billablePlayback(10, 11.5, true, 'auto')).toBe(1.5)
  })

  it('does not charge pauses, seeks or audio already charged by file-job', () => {
    expect(billablePlayback(10, 11, false, 'manual')).toBe(0)
    expect(billablePlayback(10, 50, true, 'manual')).toBe(0)
    expect(billablePlayback(10, 11, true, 'none')).toBe(0)
    expect(billablePlayback(10, 11, true, 'heard')).toBe(0)
  })
})
