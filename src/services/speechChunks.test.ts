import { describe, expect, it } from 'vitest'
import { createPhraseReader, phraseCut } from './speechChunks'

describe('reading translations phrase by phrase', () => {
  it('cuts after clause punctuation, or at a word boundary once a run gets long', () => {
    expect(phraseCut('Hôm nay chúng ta, sẽ')).toBe('Hôm nay chúng ta,'.length)
    expect(phraseCut('Vâng, hôm nay')).toBe(0)
    expect(phraseCut('Xin chào các bạn')).toBe(0)
    const long = 'chúng ta sẽ thảo luận về kế hoạch ra mắt sản phẩm'
    expect(long.slice(0, phraseCut(long))).toBe('chúng ta sẽ thảo luận về kế hoạch ra mắt sản')
  })

  it('reads each finalized phrase once and flushes the rest when the line ends', () => {
    const reader = createPhraseReader()
    expect(reader.next('a', 'Hôm nay', 'Hôm nay chúng', false)).toBeNull()
    expect(reader.next('a', 'Hôm nay chúng ta, sẽ bàn', 'Hôm nay chúng ta, sẽ bàn về', false)).toEqual({ key: 'a#0', text: 'Hôm nay chúng ta,' })
    expect(reader.next('a', 'Hôm nay chúng ta, sẽ bàn', 'Hôm nay chúng ta, sẽ bàn về', false)).toBeNull()
    expect(reader.next('a', '', 'Hôm nay chúng ta, sẽ bàn về kế hoạch.', true)).toEqual({ key: 'a#17', text: 'sẽ bàn về kế hoạch.' })
    // A new line starts from the beginning.
    expect(reader.next('b', '', 'Cảm ơn.', true)).toEqual({ key: 'b#0', text: 'Cảm ơn.' })
  })
})
