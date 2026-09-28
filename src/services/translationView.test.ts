import { describe, expect, it } from 'vitest'
import type { TranslationBlock } from './types'
import { visibleTranslation } from './translationView'

const block = (id: string, entryIds: string[], extra: Partial<TranslationBlock> = {}): TranslationBlock =>
  ({ id, entryIds, sourceText: '', translatedText: id, createdAt: '', pending: false, ...extra })

describe('visibleTranslation', () => {
  const live = [block('live-a', ['a'], { kind: 'live' }), block('live-b', ['b'], { kind: 'live' })]

  it('shows live text while the paragraph is pending', () => {
    const blocks = [...live, block('para', ['a', 'b'], { kind: 'paragraph', pending: true })]
    expect(visibleTranslation(blocks, 'a')?.id).toBe('live-a')
    expect(visibleTranslation(blocks, 'b')?.id).toBe('live-b')
  })

  it('replaces every covered live text with the finished paragraph once', () => {
    const blocks = [...live, block('para', ['a', 'b'], { kind: 'paragraph' })]
    expect(visibleTranslation(blocks, 'a')).toBeUndefined()
    expect(visibleTranslation(blocks, 'b')?.id).toBe('para')
  })

  it('keeps live text when the paragraph failed', () => {
    const blocks = [...live, block('para', ['a', 'b'], { kind: 'paragraph', failed: true })]
    expect(visibleTranslation(blocks, 'b')?.id).toBe('live-b')
  })

  it('shows the pending paragraph when there is no live text', () => {
    expect(visibleTranslation([block('para', ['a'], { kind: 'paragraph', pending: true })], 'a')?.id).toBe('para')
  })
})
