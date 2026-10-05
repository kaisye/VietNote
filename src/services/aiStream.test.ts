import { describe, expect, it, vi } from 'vitest'
import { relayAiStream } from '../../supabase/functions/_shared/ai-stream'
const encoder = new TextEncoder()
const wire = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`

async function collect(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text()
}

describe('AI SSE proxy', () => {
  it('relays text before the provider finishes and records usage once', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller } })
    const usage = vi.fn(async () => {})
    const reader = relayAiStream(source, usage).getReader()
    upstream.enqueue(encoder.encode(wire({ choices: [{ delta: { content: '## Tổng quan' } }] })))
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('## Tổng quan')
    expect(usage).not.toHaveBeenCalled()
    upstream.enqueue(encoder.encode(wire({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: .01 } }) + 'data: [DONE]\n\n'))
    upstream.close()
    let tail = ''
    while (true) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value) }
    expect(tail).toContain('"finish_reason":"stop"')
    expect(tail).toContain('[DONE]')
    expect(usage).toHaveBeenCalledTimes(1)
    expect(usage).toHaveBeenCalledWith({ prompt_tokens: 100, completion_tokens: 20, cost: .01 })
  })
  it('handles fragmented Vietnamese UTF-8, CRLF, comments and usage-only chunks', async () => {
    const bytes = encoder.encode(': keepalive\r\n' + wire({ choices: [{ delta: { content: 'Tiếng Việt' } }] }).replace(/\n/g, '\r\n') + wire({ choices: [], usage: { completion_tokens: 3 } }) + 'data: [DONE]\n\n')
    const source = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
    const usage = vi.fn(async () => {})
    const text = await collect(relayAiStream(source, usage))
    expect(text).toContain('Tiếng Việt')
    expect(text).not.toContain('keepalive')
    expect(usage).toHaveBeenCalledWith({ completion_tokens: 3 })
  })
  it('reports a dropped stream after relaying its available text', async () => {
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(wire({ choices: [{ delta: { content: 'Phần đầu' } }] }))); controller.close() } })
    const text = await collect(relayAiStream(source, async () => {}))
    expect(text).toContain('Phần đầu')
    expect(text).toContain('stream_interrupted')
    expect(text).not.toContain('[DONE]')
  })
  it('does not leak provider error details into the chat', async () => {
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(wire({ error: { message: 'private provider information' } }))); controller.close() } })
    const text = await collect(relayAiStream(source, async () => {}))
    expect(text).toContain('upstream_unavailable')
    expect(text).not.toContain('private provider information')
  })
})
