import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoteChat } from './NoteChat'
import { demoNote } from '../services/notes'
import type { NoteChatMessage } from '../services/types'

vi.mock('../services/desktop', () => ({ desktop: {} }))
const chat = { statuses: {}, ask: vi.fn(async () => {}), clear: vi.fn() }
const reply: NoteChatMessage = { id: 'answer', role: 'assistant', content: 'Phần đã nhận được.', createdAt: '2026-10-04T00:00:00Z', incomplete: true }

describe('incomplete meeting answers', () => {
  it('keeps the answer visible and offers continuation for the latest reply', () => {
    const html = renderToStaticMarkup(<NoteChat note={{ ...demoNote, chatMessages: [reply] }} chat={chat} onEvidence={() => {}}/>)
    expect(html).toContain('Phần đã nhận được.')
    expect(html).toContain('Câu trả lời chưa hoàn tất')
    expect(html).toContain('Viết tiếp')
  })
  it('does not show a truncation notice for complete or older stored answers', () => {
    const { incomplete: _incomplete, ...oldReply } = reply
    const html = renderToStaticMarkup(<NoteChat note={{ ...demoNote, chatMessages: [oldReply] }} chat={chat} onEvidence={() => {}}/>)
    expect(html).not.toContain('Câu trả lời chưa hoàn tất')
    expect(html).not.toContain('Viết tiếp')
  })
  it('does not offer to continue an older interrupted reply after another question was answered', () => {
    const html = renderToStaticMarkup(<NoteChat note={{ ...demoNote, chatMessages: [reply, { ...reply, id: 'complete', incomplete: false }] }} chat={chat} onEvidence={() => {}}/>)
    expect(html).toContain('Câu trả lời chưa hoàn tất')
    expect(html).not.toContain('Viết tiếp')
  })
})

describe('streaming meeting answer', () => {
  it('shows a formatted partial answer while the request is still pending', () => {
    const streamingChat = { ...chat, statuses: { demo: { pending: true, question: 'Tóm tắt chi tiết', answer: { answer: '## Tổng quan\n\n**Lan** gửi báo cáo.', evidenceIds: [] } } } }
    const html = renderToStaticMarkup(<NoteChat note={demoNote} chat={streamingChat} onEvidence={() => {}}/>)
    expect(html).toContain('<h2>Tổng quan</h2>')
    expect(html).toContain('<strong>Lan</strong>')
    expect(html).toContain('AI đang viết')
    expect(html).not.toContain('**Lan**')
  })
  it('renders previously saved assistant Markdown as a preview', () => {
    const html = renderToStaticMarkup(<NoteChat note={{ ...demoNote, chatMessages: [{ ...reply, content: '**Đã chốt**', incomplete: false }] }} chat={chat} onEvidence={() => {}}/>)
    expect(html).toContain('<strong>Đã chốt</strong>')
  })
})
