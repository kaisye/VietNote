import { useEffect, useState } from 'react'
import { Download, Trash2, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import { desktop, type DiarizationModelStatus } from '../services/desktop'
import { ApiHealthIcon } from './ApiHealthIcon'

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`

export function DiarizationModelCard({ model }: { model: AppModel }) {
  const [status, setStatus] = useState<DiarizationModelStatus | null>(null)
  const [downloaded, setDownloaded] = useState(0)
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    if (!desktop.isDesktop) return
    let active = true
    const unlisten: Array<() => void> = []
    void desktop.onDiarizationDownload(progress => { if (active) setDownloaded(progress.downloaded) }).then(fn => unlisten.push(fn))
    void desktop.diarizationModelStatus().then(next => { if (active) { setStatus(next); setDownloaded(next.partialBytes) } })
      .catch(error => { if (active) setMessage(`Không đọc được trạng thái model: ${error}`) })
    return () => { active = false; unlisten.forEach(fn => fn()) }
  }, [])

  // A download started before this page was reopened still finishes in the
  // background; follow it by polling, since its result went to the old page.
  useEffect(() => {
    if (!status?.downloading) return
    const timer = setInterval(() => void desktop.diarizationModelStatus().then(next => { if (!next.downloading) setStatus(next) }).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [status?.downloading])

  const download = async () => {
    if (!status) return
    setMessage('')
    setStatus({ ...status, downloading: true })
    try {
      const next = await desktop.downloadDiarizationModel()
      setStatus(next)
      setMessage(model.capturing ? 'Đã tải xong. Model sẽ được dùng từ phiên họp sau khi khởi động lại app.' : 'Đã tải và kiểm tra model. Đang khởi động lại nhận diện người nói…')
    } catch (error) {
      setMessage(String(error))
      void desktop.diarizationModelStatus().then(next => { setStatus(next); setDownloaded(next.partialBytes) }).catch(() => {})
    }
  }

  const remove = async () => {
    setRemoving(true); setMessage('')
    try { setStatus(await desktop.removeDiarizationModel()); setDownloaded(0); setMessage('Đã xóa model khỏi máy.') }
    catch (error) { setMessage(`Không xóa được model: ${error}`) }
    finally { setRemoving(false) }
  }

  const busy = model.capturing || model.meetingActive
  const total = status?.sizeBytes ?? 0
  const percent = total ? Math.min(100, Math.round(downloaded / total * 100)) : 0

  return <section className="glass-card settings-card">
    <div className="settings-heading"><h3>Nhận diện người nói · Nemotron 3</h3><ApiHealthIcon health={{ ready: model.diarizationReady, checking: false, message: model.diarizationStatus }}/><small>{status ? megabytes(status.sizeBytes) : ''}</small></div>
    <small role="status">{model.diarizationStatus}</small>
    <p className="muted">Xử lý trên máy, tối đa 8 người nói mỗi nguồn. Nhãn người nói là ước lượng và có thể được cập nhật trong phiên; không phải tên thật.</p>
    {status && !status.runtimeAvailable && <small className="muted">Bản cài này chưa kèm bộ chạy Nemotron 3 (chỉ hỗ trợ Mac Apple Silicon).</small>}
    {status?.runtimeAvailable && (status.downloading
      ? <div className="model-download">
          <div className="model-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }}/></div>
          <div className="groq-key-actions"><small>Đang tải {megabytes(downloaded)} / {megabytes(total)} · {percent}%</small><div className="row-spacer"/><button className="pill-btn" onClick={() => void desktop.cancelDiarizationDownload()}><X size={15}/>Hủy</button></div>
        </div>
      : status.installed
        ? status.removable && <div className="groq-key-actions"><small className="muted">Model đã được tải và kiểm tra checksum.</small><div className="row-spacer"/><button className="pill-btn" disabled={busy || removing} onClick={() => void remove()}><Trash2 size={15}/>Xóa model</button></div>
        : <div className="groq-key-actions"><small className="muted">{downloaded > 0 ? `Đã tải ${megabytes(downloaded)}; có thể tải tiếp.` : 'Cần tải model một lần để gán người nói.'}</small><div className="row-spacer"/><button className="pill-btn primary" disabled={busy} onClick={() => void download()}><Download size={15}/>{downloaded > 0 ? 'Tải tiếp' : `Tải model (${megabytes(total)})`}</button></div>)}
    {message && <small role="status" className="groq-key-message">{message}</small>}
  </section>
}
