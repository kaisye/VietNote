import { useRef, useState, type RefObject } from 'react'
import { desktop, type WriteProgress } from '../services/desktop'
import { transcriptLines } from '../services/noteDocument'
import type { DocumentKind, DocumentLength, MeetingNote, NoteDocument, NoteGroup } from '../services/types'

export interface WriteOptions { kind: DocumentKind; length: DocumentLength; instruction: string; /** Rewrites this document instead of adding one. */ reviseId?: string }
export type DocumentStatus = { options: WriteOptions; progress?: WriteProgress; error?: string }

/** AI-written documents per note; a write keeps running while the user moves to another note or page. */
export function useNoteDocuments(
  notes: RefObject<MeetingNote[]>, groups: RefObject<NoteGroup[]>,
  persist: (notes: MeetingNote[], groups: NoteGroup[]) => void,
) {
  const active = useRef(new Set<string>())
  const [statuses, setStatuses] = useState<Record<string, DocumentStatus>>({})
  const setStatus = (id: string, status: DocumentStatus | null) => setStatuses(previous => {
    const next = { ...previous }
    if (status) next[id] = status; else delete next[id]
    return next
  })
  const change = (id: string, edit: (note: MeetingNote) => MeetingNote) =>
    persist(notes.current.map(note => note.id === id && !note.isDemo ? edit(note) : note), groups.current)

  /** Resolves to the written document's id, or null when it failed or the note is gone. */
  const write = async (id: string, options: WriteOptions): Promise<string | null> => {
    const note = notes.current.find(item => item.id === id)
    if (!note || note.isDemo || active.current.has(id)) return null
    const lines = transcriptLines(note)
    const size = lines.join('\n').length
    const revised = options.reviseId ? note.documents?.find(document => document.id === options.reviseId) : undefined
    active.current.add(id)
    setStatus(id, { options })
    try {
      if (!desktop.isDesktop) throw new Error('Hãy mở ứng dụng VietNote để dùng AI viết.')
      const result = await desktop.writeDocument({
        title: note.title, lines,
        digest: note.digest?.size === size ? note.digest.parts : [],
        current: revised?.markdown ?? '',
        kind: options.kind, length: options.length, instruction: options.instruction.trim(),
      }, progress => { if (active.current.has(id)) setStatus(id, { options, progress }) })
      if (!notes.current.some(item => item.id === id)) return null // Never recreate a deleted note.
      const now = new Date().toISOString()
      const document: NoteDocument = {
        id: revised?.id ?? crypto.randomUUID(), kind: options.kind, length: options.length,
        instruction: options.instruction.trim() || undefined, markdown: result.markdown,
        incomplete: result.incomplete || undefined, createdAt: revised?.createdAt ?? now, updatedAt: now,
      }
      change(id, current => ({
        ...current, updatedAt: now,
        digest: result.digest.length ? { size, parts: result.digest } : current.digest,
        documents: revised
          ? (current.documents ?? []).map(item => item.id === revised.id ? document : item)
          : [document, ...(current.documents ?? [])],
      }))
      setStatus(id, null)
      return document.id
    } catch (error) {
      setStatus(id, { options, error: error instanceof Error ? error.message : String(error) })
      return null
    } finally { active.current.delete(id) }
  }

  const save = (id: string, documentId: string, markdown: string) => change(id, note => ({
    ...note, updatedAt: new Date().toISOString(),
    documents: (note.documents ?? []).map(item => item.id === documentId ? { ...item, markdown, updatedAt: new Date().toISOString() } : item),
  }))
  const remove = (id: string, documentId: string) => change(id, note => ({ ...note, documents: (note.documents ?? []).filter(item => item.id !== documentId) }))
  const dismiss = (id: string) => { if (!active.current.has(id)) setStatus(id, null) }
  return { statuses, write, save, remove, dismiss }
}
