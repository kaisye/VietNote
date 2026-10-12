import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import remend from 'remend'
import { desktop } from '../services/desktop'

/** Some models wrap the entire answer in a Markdown fence. Render its contents as the preview. */
export function markdownPreviewSource(content: string, streaming = false) {
  let source = content.trim()
  if (/^```(?:markdown|md)\s*\n/i.test(source)) {
    source = source.replace(/^```(?:markdown|md)\s*\n/i, '').replace(/\n```\s*$/, '')
  }
  source = normalizeMath(source)
  return streaming ? remend(source, { linkMode: 'text-only' }) : source
}

/** Models also write \( … \) and \[ … \]; the math parser reads only $ … $ and $$ … $$. Code stays untouched. */
export function normalizeMath(source: string) {
  return source.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/\\\((.+?)\\\)/g, (_, math: string) => `$${math.trim()}$`)).join('')
}

export function ChatMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]} skipHtml
    urlTransform={url => /^(https?:|mailto:)/i.test(url) ? defaultUrlTransform(url) : ''}
    components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => { if (!desktop.isDesktop) return; event.preventDefault(); void desktop.openLink(href).catch(() => {}) }}>{children}</a> : <span>{children}</span>,
      img: () => null,
      table: ({ children }) => <div className="chat-table-wrap"><table>{children}</table></div>,
    }}>{markdownPreviewSource(content, streaming)}</Markdown></div>
}
