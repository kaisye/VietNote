import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMarkdown } from './ChatMarkdown'
const preview = (content: string, streaming = false) => renderToStaticMarkup(<ChatMarkdown content={content} streaming={streaming}/>)

describe('chat Markdown preview', () => {
  it('renders headings, emphasis, lists and tables rather than showing their source markers', () => {
    const html = preview('## Việc cần làm\n\n**Lan** gửi báo cáo.\n\n- Kiểm thử\n- Tổng hợp\n\n| Người | Việc |\n| --- | --- |\n| Lan | Báo cáo |')
    expect(html).toContain('<h2>Việc cần làm</h2>')
    expect(html).toContain('<strong>Lan</strong>')
    expect(html).toContain('<li>Kiểm thử</li>')
    expect(html).toContain('<table>')
    expect(html).not.toContain('**Lan**')
  })
  it('formats partial emphasis and incomplete links as a stream arrives', () => {
    expect(preview('Người phụ trách: **Lan', true)).toContain('<strong>Lan</strong>')
    const html = preview('Xem [báo cáo](https://exam', true)
    expect(html).toContain('báo cáo')
    expect(html).not.toContain('](https://exam')
  })
  it('unwraps a whole-answer Markdown fence', () => {
    expect(preview('```markdown\n## Tổng quan\n\n**Đã chốt**\n```')).toContain('<h2>Tổng quan</h2>')
    expect(preview('```markdown\n**Đang viết', true)).toContain('<strong>Đang viết</strong>')
  })
  it('does not execute HTML or load remote images and only allows safe links', () => {
    const html = preview('<script>alert(1)</script>\n\n![ảnh](https://example.com/tracker)\n\n[x](javascript:alert%281%29)\n\n[nguồn](https://example.com)')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})
