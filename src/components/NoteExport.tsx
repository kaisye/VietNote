import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Copy, Download, FileDown, FileText, Printer } from 'lucide-react'
import type { MeetingNote } from '../services/types'
import { desktop } from '../services/desktop'
import { noteContentText } from '../services/notes'
import { buildReport, reportDocx, reportFileName, reportHtml, type Report } from '../services/noteExport'

type Status = { kind: 'copied' | 'busy' | 'saved' | 'error'; text: string; path?: string }
/** WKWebView can print straight to a file; elsewhere PDF goes through the system print dialog. */
const directPdf = desktop.isDesktop && typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Copy with formatting, plus "Xuất" to Word or PDF (through the print panel). */
export function NoteExport({ note, groupName }: { note: MeetingNote; groupName?: string | null }) {
  const [menu, setMenu] = useState(false)
  const [withTranscript, setWithTranscript] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [printing, setPrinting] = useState<{ report: Report; at: number; mode: 'pdf' | 'print' } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hasTranscript = Boolean(note.transcriptSegments?.length || note.transcript.trim())

  const show = (next: Status, ms = 2400) => {
    clearTimeout(statusTimer.current)
    setStatus(next)
    if (next.kind !== 'busy') statusTimer.current = setTimeout(() => setStatus(null), ms)
  }
  useEffect(() => () => clearTimeout(statusTimer.current), [])
  useEffect(() => { setMenu(false); setStatus(null) }, [note.id])
  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => { if (!(event.target instanceof Node && root.current?.contains(event.target))) setMenu(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(false) } }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey, true) }
  }, [menu])
  // Print once the report is in the DOM; it stays mounted (hidden on screen) afterwards.
  useEffect(() => {
    if (!printing) return
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      if (printing.mode === 'pdf' && directPdf) {
        show({ kind: 'busy', text: 'Đang tạo file PDF…' })
        desktop.savePdf(reportFileName(printing.report, 'pdf'))
          .then(path => path ? show({ kind: 'saved', text: 'Đã lưu file PDF', path }, 6000) : setStatus(null))
          .catch(error => show({ kind: 'error', text: typeof error === 'string' ? error : 'Không tạo được file PDF' }))
        return
      }
      void (desktop.isDesktop ? desktop.printPage() : Promise.resolve(window.print())).catch(() => show({ kind: 'error', text: 'Không mở được hộp thoại in' }))
    }))
    return () => cancelAnimationFrame(frame)
  }, [printing])

  const report = () => buildReport(note, { groupName, transcript: withTranscript && hasTranscript })

  const copy = async () => {
    const text = noteContentText(note)
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) throw new Error('plain only')
      const html = reportHtml(buildReport(note, { groupName }))
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
      show({ kind: 'copied', text: 'Đã copy' }, 1800)
    } catch {
      try { await navigator.clipboard.writeText(text); show({ kind: 'copied', text: 'Đã copy' }, 1800) } catch { show({ kind: 'error', text: 'Không copy được' }) }
    }
  }

  const exportWord = async () => {
    setMenu(false)
    show({ kind: 'busy', text: 'Đang tạo file Word…' })
    try {
      const value = report()
      const bytes = await reportDocx(value)
      const name = reportFileName(value, 'docx')
      if (!desktop.isDesktop) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
        Object.assign(document.createElement('a'), { href: url, download: name }).click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        show({ kind: 'saved', text: 'Đã tải file Word' })
        return
      }
      const path = await desktop.saveExport(name, toBase64(bytes))
      if (path) show({ kind: 'saved', text: 'Đã lưu file Word', path }, 6000)
      else setStatus(null)
    } catch (error) {
      show({ kind: 'error', text: typeof error === 'string' ? error : 'Không xuất được file Word' })
    }
  }

  const printReport = (mode: 'pdf' | 'print') => { setMenu(false); setStatus(null); setPrinting({ report: report(), at: Date.now(), mode }) }

  return <div className="note-export" ref={root}>
    {status && status.kind !== 'copied' && <small className={`note-export-status ${status.kind}`} role="status">
      {status.text}{status.path && <button type="button" onClick={() => void desktop.revealFile(status.path!).catch(() => {})}>Hiện trong Finder</button>}
    </small>}
    <button className="copy-btn" onClick={() => void copy()} title="Copy giữ định dạng: dán vào Gmail, Google Docs, Notion…">{status?.kind === 'copied' ? <Check size={14}/> : <Copy size={14}/>}{status?.kind === 'copied' ? 'Đã copy' : 'Copy'}</button>
    <button className="copy-btn note-export-trigger" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)} disabled={status?.kind === 'busy'} title="Xuất báo cáo tóm tắt"><Download size={14}/>Xuất<ChevronDown size={13} className="chevron"/></button>
    {menu && <div className="note-export-menu" role="menu">
      <button role="menuitem" onClick={() => void exportWord()}><FileText size={17}/><span><strong>Word (.docx)</strong><small>Chỉnh sửa, gửi duyệt biên bản</small></span></button>
      <button role="menuitem" onClick={() => printReport('pdf')}><FileDown size={17}/><span><strong>PDF</strong><small>{directPdf ? 'Bản chốt để gửi, không sửa được' : 'Chọn "Lưu dưới dạng PDF" khi in'}</small></span></button>
      {directPdf && <button role="menuitem" onClick={() => printReport('print')}><Printer size={17}/><span><strong>In…</strong><small>Gửi tới máy in</small></span></button>}
      <label className={hasTranscript ? '' : 'disabled'}><input type="checkbox" checked={withTranscript && hasTranscript} disabled={!hasTranscript} onChange={event => setWithTranscript(event.target.checked)}/>Kèm transcript gốc</label>
    </div>}
    {printing && createPortal(<article className="print-report" key={printing.at} dangerouslySetInnerHTML={{ __html: reportHtml(printing.report) }}/>, document.body)}
  </div>
}
