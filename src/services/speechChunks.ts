/** A phrase this short sounds clipped on its own; wait for more. */
const MIN_PHRASE_WORDS = 3
/** Without punctuation, a run this long is read up to its last whole word. */
const MAX_PHRASE_WORDS = 9

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

/**
 * Where to cut the next phrase to read aloud from finalized translation text not yet read:
 * after the last clause punctuation, or at a word boundary once the run gets long.
 * Returns 0 to wait for more text.
 */
export function phraseCut(rest: string): number {
  let cut = 0
  for (const match of rest.matchAll(/[.,;:!?…](?=\s|$)/g)) {
    const end = match.index + 1
    if (words(rest.slice(0, end)) >= MIN_PHRASE_WORDS) cut = end
  }
  if (cut) return cut
  if (words(rest) <= MAX_PHRASE_WORDS) return 0
  // The last token may be half a word; stop before it.
  const space = rest.trimEnd().lastIndexOf(' ')
  return space > 0 ? space : 0
}

/**
 * Tracks how much of each line has been read, and returns the next phrase to read as the
 * translation streams in. `final` flushes whatever is left.
 */
export function createPhraseReader() {
  const read = new Map<string, number>()
  return {
    next(id: string, stable: string, text: string, final: boolean): { key: string; text: string } | null {
      const done = read.get(id) ?? 0
      const source = final ? text : stable
      if (final) read.delete(id)
      if (source.length <= done) return null
      const rest = source.slice(done)
      const cut = final ? rest.length : phraseCut(rest)
      if (!cut) return null
      if (!final) read.set(id, done + cut)
      const phrase = rest.slice(0, cut).trim()
      return phrase ? { key: `${id}#${done}`, text: phrase } : null
    },
    clear() { read.clear() },
  }
}
