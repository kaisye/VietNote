import type { TranslationBlock } from './types'

/**
 * The one translation to show under a transcript entry. Gemini Live fills the gap
 * while the LLM paragraph translation is pending; once that paragraph is ready it
 * replaces the live text of every entry it covers (shown once, under its last entry).
 * A failed paragraph keeps the live text instead of an error line.
 */
export function visibleTranslation(blocks: TranslationBlock[], entryId: string): TranslationBlock | undefined {
  const paragraph = blocks.find(block => block.kind !== 'live' && !block.failed && block.entryIds.includes(entryId))
  if (paragraph && !paragraph.pending) return paragraph.entryIds.at(-1) === entryId ? paragraph : undefined
  const live = blocks.find(block => block.kind === 'live' && block.entryIds.at(-1) === entryId)
  return live ?? (paragraph?.entryIds.at(-1) === entryId ? paragraph : undefined)
}
