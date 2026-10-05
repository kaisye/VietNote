import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remend from 'remend'
import { desktop } from '../services/desktop'

/** Some models wrap the entire answer in a Markdown fence. Render its contents as the preview. */
export function markdownPreviewSource(content: string, streaming = false) {
  let source = content.trim()
  if (/^```(?:markdown|md)\s*\n/i.test(source)) {
    source = source.replace(/^```(?:markdown|md)\s*\n/i, '').replace(/\n```\s*$/, '')
  }
  return streaming ? remend(source, { linkMode: 'text-only' }) : source
}

export function ChatMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={url => /^(https?:|mailto:)/i.test(url) ? defaultUrlTransform(url) : ''}
    components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => { if (!desktop.isDesktop) return; event.preventDefault(); void desktop.openLink(href).catch(() => {}) }}>{children}</a> : <span>{children}</span>,
      img: () => null,
      table: ({ children }) => <div className="chat-table-wrap"><table>{children}</table></div>,
    }}>{markdownPreviewSource(content, streaming)}</Markdown></div>
}
