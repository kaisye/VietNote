export interface AiUsage { prompt_tokens?: number; completion_tokens?: number; cost?: number }

/** Relay complete SSE events as soon as they arrive, and record the final usage once. */
export function relayAiStream(source: ReadableStream<Uint8Array>, recordUsage: (usage: AiUsage) => Promise<void>) {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = ''
      let data: string[] = []
      let usage: AiUsage = {}
      let done = false
      let failed = false
      const send = (value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) }
      const dispatch = () => {
        if (!data.length) return
        const raw = data.join('\n'); data = []
        if (raw === '[DONE]') { done = true; return }
        const event = JSON.parse(raw) as {
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
          usage?: AiUsage; error?: unknown
        }
        if (event.usage) usage = event.usage
        if (event.error) { failed = true; send({ error: 'upstream_unavailable' }); return }
        const choice = event.choices?.[0]
        if (choice?.delta?.content || choice?.finish_reason) {
          send({ content: choice.delta?.content ?? '', finish_reason: choice.finish_reason ?? null })
        }
      }
      const line = (raw: string) => {
        const value = raw.replace(/\r$/, '')
        if (!value) dispatch()
        else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
      }
      try {
        while (!cancelled && !done && !failed) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          let index: number
          while ((index = buffer.indexOf('\n')) !== -1 && !done && !failed) {
            line(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
          }
          if (buffer.length > 1_000_000) throw new Error('SSE frame too large')
        }
        if (!done && !failed && !cancelled) {
          buffer += decoder.decode()
          if (buffer) line(buffer)
          dispatch()
          if (!done) { failed = true; send({ error: 'stream_interrupted' }) }
        }
      } catch {
        failed = true
        send({ error: 'stream_interrupted' })
      } finally {
        await reader.cancel().catch(() => {})
        try { await recordUsage(usage) } catch { /* Accounting must not discard an answer. */ }
        if (!cancelled) {
          if (!failed && done) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      }
    },
    async cancel() { cancelled = true; await reader.cancel().catch(() => {}) },
  })
}
