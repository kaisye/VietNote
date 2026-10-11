import { useEffect, useRef, type MutableRefObject } from 'react'
import { desktop } from '../services/desktop'
import { hasDateTitle, noteSource, titleSourceText } from '../services/notes'
import type { MeetingNote, NoteGroup } from '../services/types'

/** Renames written to disk together, rather than one save per note. */
const BATCH = 8

/**
 * Gives notes still named by their date ("Cuộc họp · 22:47 10/10/26") a name from their content:
 * the summary's title when it has one, else one the AI suggests from the transcript. Runs in the
 * background, one note at a time; a title the user typed is never touched.
 */
export function useNoteTitles(notes: MeetingNote[], notesRef: MutableRefObject<MeetingNote[]>, groupsRef: MutableRefObject<NoteGroup[]>, persist: (notes: MeetingNote[], groups: NoteGroup[]) => void) {
  const tried = useRef(new Set<string>())
  const running = useRef(false)

  useEffect(() => {
    if (!desktop.isDesktop || running.current) return
    const queue = notes.filter(note => !note.isDemo && !note.saving && hasDateTitle(note) && !tried.current.has(note.id))
    if (!queue.length) return
    running.current = true
    void (async () => {
      const titles = new Map<string, string>()
      const save = () => {
        if (!titles.size) return
        // Applied to the notes as they are now, and only where the date name is still there.
        persist(notesRef.current.map(note => titles.has(note.id) && hasDateTitle(note) ? { ...note, title: titles.get(note.id)!, source: noteSource(note) } : note), groupsRef.current)
        titles.clear()
      }
      for (const note of queue) {
        tried.current.add(note.id)
        let title = note.structuredSummary?.title?.trim() ?? ''
        if (!title) {
          const text = titleSourceText(note)
          if (!text) continue
          try { title = (await desktop.suggestTitle(text)).trim() }
          catch {
            // Offline or signed out: leave the rest for the next launch.
            queue.forEach(item => tried.current.add(item.id))
            break
          }
        }
        if (title) titles.set(note.id, title)
        if (titles.size >= BATCH) save()
      }
      save()
      running.current = false
    })()
  }, [notes, notesRef, groupsRef, persist])
}
