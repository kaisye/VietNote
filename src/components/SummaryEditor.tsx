import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { AlertCircle, ArrowUp, Bold, Heading2, List, ListTodo, Loader2, Redo2, Sparkles, Undo2 } from 'lucide-react'
import { desktop } from '../services/desktop'
import { transcriptLines } from '../services/noteDocument'
import { evidenceIds } from '../services/summaryMarkdown'
import type { MeetingNote } from '../services/types'

/** Saved this long after the last keystroke, and right away when the editor closes. */
const SAVE_DELAY_MS = 400

const quickAsks = [
  { label: 'Viết lại cho mạch lạc', instruction: 'Cải thiện cách viết: câu rõ ràng, mạch lạc, đúng chính tả; gộp ý trùng; giữ nguyên các ý và cấu trúc.' },
  { label: 'Ngắn gọn hơn', instruction: 'Rút gọn còn khoảng một nửa: giữ ý quan trọng, quyết định và việc cần làm.' },
  { label: 'Bổ sung từ transcript', instruction: 'Đối chiếu với transcript: bổ sung ý quan trọng, quyết định, việc cần làm còn thiếu; sửa chỗ sai so với transcript.', needsTranscript: true },
  { label: 'Sắp xếp theo chủ đề', instruction: 'Sắp xếp lại theo chủ đề, mỗi chủ đề một phần ## rõ ràng; không bỏ ý nào.' },
]

/** Offered over a selection: they rewrite just that passage. */
const selectionAsks = [
  { label: 'Viết lại', instruction: 'Viết lại cho rõ ràng, mạch lạc, tự nhiên hơn; giữ nguyên ý.' },
  { label: 'Ngắn hơn', instruction: 'Viết ngắn gọn hơn, giữ ý chính.' },
  { label: 'Chi tiết hơn', instruction: 'Viết chi tiết hơn: thêm giải thích, số liệu, ví dụ đúng như trong transcript.', transcript: true },
  { label: 'Sửa lỗi', instruction: 'Chỉ sửa chính tả, ngữ pháp, dấu câu; không đổi ý và cách viết.' },
  { label: 'Dịch tiếng Anh', instruction: 'Dịch sang tiếng Anh tự nhiên, đúng thuật ngữ.' },
]

/**
 * The selection as Markdown, and the range a rewrite replaces. Within one paragraph or list item
 * just the selected words are sent; across blocks, the whole blocks they touch.
 */
function selectedPassage(editor: Editor): { from: number; to: number; inline: boolean; markdown: string; context?: string } | null {
  const { from, to, $from, $to, empty } = editor.state.selection
  if (empty || !editor.markdown) return null
  if ($from.sameParent($to) && $from.parent.isTextblock) {
    const content = editor.state.doc.slice(from, to).content.toJSON() as JSONContent[]
    const line = $from.parent.textContent
    return { from, to, inline: true, markdown: editor.markdown.serialize({ type: 'doc', content: [{ type: 'paragraph', content }] }).trim(),
      context: line.length > to - from && line.length <= 1200 ? line : undefined }
  }
  const start = $from.before(1), end = $to.after(1)
  const content = editor.state.doc.slice(start, end).content.toJSON() as JSONContent[]
  return { from: start, to: end, inline: false, markdown: editor.markdown.serialize({ type: 'doc', content }).trim() }
}

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({ editor, selector: ({ editor }) => ({
    heading: editor.isActive('heading', { level: 2 }), bold: editor.isActive('bold'), bullets: editor.isActive('bulletList'), tasks: editor.isActive('taskList'),
    undo: editor.can().undo(), redo: editor.can().redo(),
  }) })
  const tool = (label: string, Icon: typeof Bold, active: boolean, run: () => void, disabled = false) =>
    <button type="button" className={active ? 'selected' : ''} aria-pressed={active} disabled={disabled} title={label} aria-label={label}
      onMouseDown={event => event.preventDefault()} onClick={run}><Icon size={15}/></button>
  return <div className="summary-toolbar" role="toolbar" aria-label="Định dạng">
    {tool('Tiêu đề · gõ ## rồi dấu cách', Heading2, state.heading, () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
    {tool('In đậm · ⌘B', Bold, state.bold, () => editor.chain().focus().toggleBold().run())}
    {tool('Danh sách · gõ - rồi dấu cách', List, state.bullets, () => editor.chain().focus().toggleBulletList().run())}
    {tool('Việc cần làm · gõ [ ] rồi dấu cách', ListTodo, state.tasks, () => editor.chain().focus().toggleTaskList().run())}
    <span className="summary-toolbar-gap"/>
    {tool('Hoàn tác · ⌘Z', Undo2, false, () => editor.chain().focus().undo().run(), !state.undo)}
    {tool('Làm lại · ⇧⌘Z', Redo2, false, () => editor.chain().focus().redo().run(), !state.redo)}
  </div>
}

/**
 * The note's summary as one document edited in place, like a page in a notes app: headings,
 * lists and to-dos format as you type (## , - , [ ] ). The AI can rewrite it on request.
 */
export function SummaryEditor({ note, markdown, editable, showEvidence, autoFocus, onChange, onEvidence }: {
  note: MeetingNote; markdown: string; editable: boolean; showEvidence: boolean; autoFocus?: boolean
  onChange: (markdown: string) => void; onEvidence: (ids: string[]) => void
}) {
  const saved = useRef(markdown)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onEvidenceRef = useRef(onEvidence)
  onEvidenceRef.current = onEvidence
  const [ai, setAi] = useState<{ running: boolean; selection?: boolean; error?: string; before?: string }>({ running: false })
  const [request, setRequest] = useState('')
  // The AI's options open from the toolbar, so the page keeps one ask box: the meeting Q&A.
  // Opened by hovering closes when the pointer leaves; opened by a click (or typing in it) stays.
  const [menu, setMenu] = useState<false | 'hover' | 'click'>(false)
  const menuTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const menuRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false) }
    document.addEventListener('pointerdown', onPointerDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKey) }
  }, [menu])

  const save = (editor: Editor) => {
    clearTimeout(timer.current); timer.current = undefined
    // Blank paragraphs left between blocks are spacing, not content.
    const next = editor.getMarkdown().replace(/^[ \t]*&nbsp;[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    if (next === saved.current) return
    saved.current = next
    onChangeRef.current(next)
  }
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false, autolink: false } }),
      TaskList, TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Ghi gì cũng được… Gõ ## để tạo tiêu đề, - để liệt kê, [ ] để thêm việc cần làm.' }),
      Markdown,
    ],
    content: markdown, contentType: 'markdown', editable, autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'summary-editor-body', 'aria-label': 'Nội dung tóm tắt', spellcheck: 'false' },
      // Timestamp links open the transcript lines they come from.
      handleClick: (_view, _pos, event) => {
        const link = (event.target as Element).closest?.('a')
        if (!link) return false
        event.preventDefault()
        const ids = evidenceIds(link.getAttribute('href'))
        if (ids.length) onEvidenceRef.current(ids)
        else if (desktop.isDesktop && /^https?:\/\//.test(link.getAttribute('href') ?? '')) void desktop.openLink(link.getAttribute('href')!).catch(() => {})
        return true
      },
    },
    onUpdate: ({ editor }) => { clearTimeout(timer.current); timer.current = setTimeout(() => save(editor), SAVE_DELAY_MS) },
    onBlur: ({ editor }) => { if (timer.current) save(editor) },
  })
  useEffect(() => () => { if (editor && timer.current) save(editor) }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps
  // The rewrite menu lives on the page itself, placed in screen coordinates, so a dimmed or
  // scrolling container around the editor (as in Focus) cannot throw it off. It follows that
  // container's scrolling instead of the window's.
  // Known before the menu mounts: it reads its options once.
  const [scrollParent, setScrollParent] = useState<HTMLElement | null | undefined>(undefined)
  const findScrollParent = (root: HTMLDivElement | null) => {
    if (!root) return
    let node = root.parentElement
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement
    setScrollParent(node)
  }
  useEffect(() => { editor?.setEditable(editable && !ai.running) }, [editor, editable, ai.running])
  // A change from elsewhere (the AI, another window) replaces what is shown.
  useEffect(() => {
    if (!editor || markdown === saved.current) return
    saved.current = markdown
    editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false })
  }, [editor, markdown])

  const hasTranscript = transcriptLines(note).length > 0
  const improve = async (instruction: string) => {
    if (!editor || ai.running) return
    setMenu(false)
    if (timer.current) save(editor)
    const before = saved.current
    setAi({ running: true })
    try {
      if (!desktop.isDesktop) throw new Error('Hãy mở ứng dụng VietNote để dùng AI.')
      const result = await desktop.writeDocument({
        title: note.title, lines: transcriptLines(note), digest: note.digest?.parts ?? [], current: before,
        kind: 'summary', length: 'medium', instruction,
      }, progress => { if (progress.stage === 'writing' && progress.text) editor.commands.setContent(progress.text, { contentType: 'markdown', emitUpdate: false }) })
      editor.commands.setContent(result.markdown, { contentType: 'markdown', emitUpdate: false })
      save(editor)
      setAi({ running: false, before })
    } catch (error) {
      editor.commands.setContent(before, { contentType: 'markdown', emitUpdate: false })
      setAi({ running: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  /** Rewrites the selected passage in place; undo restores the whole summary as it was. */
  const rewriteSelection = async (instruction: string, withTranscript = false) => {
    if (!editor || ai.running) return
    const passage = selectedPassage(editor)
    if (!passage?.markdown) return
    if (timer.current) save(editor)
    const before = saved.current
    setAi({ running: true, selection: true })
    try {
      if (!desktop.isDesktop) throw new Error('Hãy mở ứng dụng VietNote để dùng AI.')
      const result = await desktop.writeDocument({
        title: note.title, lines: withTranscript ? transcriptLines(note) : [], digest: withTranscript ? note.digest?.parts ?? [] : [],
        current: passage.markdown, kind: 'selection', length: 'medium',
        // A few picked words need their sentence to be rewritten well.
        instruction: passage.context ? `${instruction}\n\nĐoạn được chọn nằm trong câu sau (chỉ để hiểu ngữ cảnh, không viết lại phần ngoài đoạn được chọn): "${passage.context}"` : instruction,
      }, () => {})
      const parsed = editor.markdown!.parse(result.markdown).content ?? []
      // Words picked inside a line go back as words, so the line keeps its bullet or heading.
      const replacement = passage.inline && parsed.length === 1 && parsed[0].type === 'paragraph' ? parsed[0].content ?? [] : parsed
      editor.setEditable(true)
      editor.chain().focus().insertContentAt({ from: passage.from, to: passage.to }, replacement).run()
      save(editor)
      setAi({ running: false, before })
    } catch (error) {
      setAi({ running: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const [selectionRequest, setSelectionRequest] = useState('')
  const runningRef = useRef(false)
  runningRef.current = ai.running

  const revert = () => {
    if (!editor || ai.before === undefined) return
    editor.commands.setContent(ai.before, { contentType: 'markdown', emitUpdate: false })
    save(editor)
    setAi({ running: false })
  }
  const submit = () => { const value = request.trim(); if (value) { void improve(value); setRequest('') } }
  const empty = !markdown.trim() && (editor?.isEmpty ?? true)

  return <div ref={findScrollParent} className={`summary-editor ${showEvidence ? '' : 'hide-evidence'} ${ai.running ? 'ai-running' : ''}`}>
    {editable && editor && <div className="summary-bar">
      <Toolbar editor={editor}/>
      {/* Opens on hover; a click pins it open with the cursor in the request box. */}
      <div className="summary-ai" ref={menuRoot} onMouseEnter={() => { clearTimeout(menuTimer.current); if (!ai.running) setMenu(current => current || 'hover') }}
        onMouseLeave={() => { clearTimeout(menuTimer.current); menuTimer.current = setTimeout(() => setMenu(current => current === 'hover' ? false : current), 220) }}>
        <button type="button" className={`summary-ai-button ${menu ? 'selected' : ''}`} aria-expanded={Boolean(menu)} aria-haspopup="dialog" disabled={ai.running}
          onMouseDown={event => event.preventDefault()} onClick={() => setMenu(current => current === 'click' ? false : 'click')} title="Nhờ AI chỉnh bản tóm tắt">
          {ai.running ? <Loader2 size={14} className="spin"/> : <Sparkles size={14}/>}AI</button>
        {menu && <div className="summary-ai-menu" role="dialog" aria-label="Nhờ AI chỉnh bản tóm tắt">
          {quickAsks.filter(ask => !ask.needsTranscript || hasTranscript).map(ask =>
            <button type="button" key={ask.label} className="summary-ai-option" disabled={empty && !ask.needsTranscript} onClick={() => void improve(ask.instruction)}><Sparkles size={13}/>{ask.label}</button>)}
          <form className="document-revise" onSubmit={event => { event.preventDefault(); submit() }}>
            <input autoFocus={menu === 'click'} value={request} maxLength={2000} onFocus={() => setMenu('click')} onChange={event => setRequest(event.target.value)} placeholder="Hoặc gõ yêu cầu: thêm phần rủi ro, dịch sang tiếng Anh…" aria-label="Yêu cầu AI chỉnh bản tóm tắt"/>
            <button type="submit" className="document-send" disabled={!request.trim() || (empty && !hasTranscript)} aria-label="Gửi yêu cầu"><ArrowUp size={15}/></button>
          </form>
        </div>}
      </div>
    </div>}
    {editable && editor && scrollParent !== undefined && <BubbleMenu editor={editor} className="summary-bubble" appendTo={() => document.body}
      options={{ placement: 'bottom-start', offset: 8, strategy: 'fixed', scrollTarget: scrollParent ?? window }}
      shouldShow={({ editor, state }) => !state.selection.empty && (runningRef.current || editor.isEditable) && Boolean(state.doc.textBetween(state.selection.from, state.selection.to).trim())}>
      {ai.running && ai.selection ? <p className="summary-bubble-status"><Loader2 size={13} className="spin"/>AI đang viết lại đoạn này…</p> : <>
        <div className="summary-bubble-actions"><Sparkles size={14} className="summary-bubble-icon" aria-hidden="true"/>{selectionAsks.filter(ask => !ask.transcript || hasTranscript).map(ask =>
          <button type="button" key={ask.label} onMouseDown={event => event.preventDefault()} onClick={() => void rewriteSelection(ask.instruction, ask.transcript)}>
            {ask.label}</button>)}</div>
        <form onSubmit={event => { event.preventDefault(); const value = selectionRequest.trim(); if (value) { setSelectionRequest(''); void rewriteSelection(value) } }}>
          <input value={selectionRequest} maxLength={2000} onChange={event => setSelectionRequest(event.target.value)} placeholder="Yêu cầu khác cho đoạn này…" aria-label="Yêu cầu AI viết lại đoạn đã chọn"/>
          <button type="submit" className="document-send" disabled={!selectionRequest.trim()} aria-label="Gửi"><ArrowUp size={13}/></button>
        </form>
      </>}
    </BubbleMenu>}
    {editable && (ai.running ? <p className="summary-ai-status"><Loader2 size={14} className="spin"/>{ai.selection ? 'AI đang viết lại đoạn đã chọn…' : 'AI đang chỉnh bản tóm tắt…'}</p>
      : ai.before !== undefined ? <p className="summary-ai-status">AI đã chỉnh xong.<button type="button" onClick={revert}>Hoàn tác thay đổi của AI</button><button type="button" onClick={() => setAi({ running: false })}>Giữ</button></p>
      : ai.error ? <p className="file-error" role="alert"><AlertCircle size={14}/>{ai.error}</p> : null)}
    <EditorContent editor={editor}/>
  </div>
}
