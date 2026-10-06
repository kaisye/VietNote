import { useRef, useState, type RefObject } from 'react'
import { desktop, type NoteChatAnswer } from '../services/desktop'
import { appendNoteChat, askNoteQuestion } from '../services/noteChat'
import type { MeetingNote, NoteGroup, NoteChatMessage } from '../services/types'

export interface NoteChatStatus { pending: boolean; question: string; error?: string; answer?: NoteChatAnswer }

export function useNoteChat(
  notes: RefObject<MeetingNote[]>, groups: RefObject<NoteGroup[]>,
  persist: (notes: MeetingNote[], groups: NoteGroup[]) => void,
) {
  const active = useRef(new Set<string>())
  const [statuses, setStatuses] = useState<Record<string, NoteChatStatus>>({})
  const ask = async (id: string, raw: string) => {
    const note = notes.current.find(item => item.id === id)
    const question = raw.trim()
    if (!note || note.saving || !question || active.current.has(id)) return
    const update = (status: NoteChatStatus) => setStatuses(previous => ({ ...previous, [id]: status }))
    active.current.add(id)
    update({ pending: true, question })
    try {
      if (!desktop.isDesktop) throw new Error('Hãy mở ứng dụng VietNote để hỏi đáp với AI.')
      const result = await askNoteQuestion(note, question, answer => {
        if (active.current.has(id)) update({ pending: true, question, answer })
      })
      const current = notes.current.find(item => item.id === id)
      if (!current) return // A deleted note must never be recreated by a late reply.
      const createdAt = new Date().toISOString()
      const messages: NoteChatMessage[] = [
        { id: crypto.randomUUID(), role: 'user', content: question, createdAt },
        { id: crypto.randomUUID(), role: 'assistant', content: result.answer, evidenceIds: result.evidenceIds, followUps: result.followUps, incomplete: result.incomplete, createdAt },
      ]
      persist(appendNoteChat(notes.current, note, messages), groups.current)
      update({ pending: false, question: '' })
    } catch (error) {
      update({ pending: false, question, error: error instanceof Error ? error.message : String(error) })
    } finally { active.current.delete(id) }
  }
  const clear = (id: string) => {
    if (active.current.has(id)) return
    persist(notes.current.map(note => note.id === id ? { ...note, chatMessages: [] } : note), groups.current)
    setStatuses(previous => { const next = { ...previous }; delete next[id]; return next })
  }
  return { statuses, ask, clear }
}
