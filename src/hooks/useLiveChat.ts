import { useRef, useState } from 'react'
import { desktop, type NoteChatAnswer } from '../services/desktop'
import { askLiveQuestion, type LiveQuestion } from '../services/liveChat'
import type { NoteChatMessage, Subtitle } from '../services/types'

export interface LiveChatStatus { pending: boolean; request: LiveQuestion; error?: string; answer?: NoteChatAnswer }

/** Q&A over the transcript while it is still being recorded; the meeting's note keeps the thread. */
export function useLiveChat(context: () => { title: string; summary: string; entries: Subtitle[] }) {
  const [messages, setMessages] = useState<NoteChatMessage[]>([])
  const messagesRef = useRef<NoteChatMessage[]>([])
  const [status, setStatus] = useState<LiveChatStatus | null>(null)
  const session = useRef(0)
  const busy = useRef(false)
  const publish = (next: NoteChatMessage[]) => { messagesRef.current = next; setMessages(next) }

  const ask = async (request: LiveQuestion) => {
    const question = request.question.trim()
    if (!question || busy.current) return
    const current = session.current
    busy.current = true
    setStatus({ pending: true, request })
    try {
      if (!desktop.isDesktop) throw new Error('Hãy mở ứng dụng VietNote để hỏi đáp với AI.')
      const result = await askLiveQuestion(context(), messagesRef.current, { ...request, question }, answer => {
        if (session.current === current) setStatus({ pending: true, request, answer })
      })
      if (session.current !== current) return
      const createdAt = new Date().toISOString()
      publish([...messagesRef.current,
        { id: crypto.randomUUID(), role: 'user', content: request.label ?? question, quote: request.quote?.trim() || undefined, createdAt },
        { id: crypto.randomUUID(), role: 'assistant', content: result.answer, evidenceIds: result.evidenceIds, followUps: result.followUps, incomplete: result.incomplete, createdAt },
      ])
      setStatus(null)
    } catch (error) {
      if (session.current === current) setStatus({ pending: false, request, error: error instanceof Error ? error.message : String(error) })
    } finally { if (session.current === current) busy.current = false }
  }
  /** A new meeting starts a new thread; late replies to the old one are dropped. */
  const reset = () => { session.current += 1; busy.current = false; publish([]); setStatus(null) }
  return { messages, messagesRef, status, ask, reset, dismissError: () => setStatus(previous => previous?.pending ? previous : null) }
}
