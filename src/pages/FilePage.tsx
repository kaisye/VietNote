import { CheckCircle2, FileAudio, Languages, LoaderCircle, RefreshCw, Upload, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Page } from '../services/types'
import { fileCost, FILE_RATE } from '../services/fileTranscript'
import { languageOptions } from '../components/MeetingControls'
import { Choice } from '../components/Choice'
import { AnimatedWaveform } from '../components/AnimatedWaveform'

const MAX_SECONDS = 300 * 60
const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60))
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
const length = (seconds: number) => { const total = Math.round(seconds); const h = Math.floor(total / 3600); const m = Math.floor(total % 3600 / 60); const s = total % 60; return h ? `${h} giờ ${m} phút` : m ? `${m} phút ${s} giây` : `${s} giây` }

export function FilePage({ model, setPage }: { model: AppModel; setPage: (page: Page) => void }) {
  const job = model.fileJob
  const { file, phase } = job
  const working = phase === 'uploading' || phase === 'processing' || phase === 'summarizing'
  const tooLong = (file?.durationSeconds ?? 0) > MAX_SECONDS
  const balance = model.account?.balanceSeconds ?? null
  const cost = file?.durationSeconds ? fileCost(file.durationSeconds) : null
  const short = cost !== null && balance !== null && balance < cost

  return <main className="page-scroll"><div className="page-wrap narrow animate-in"><div className="eyebrow">RECORDING TO NOTES</div><h1>Dịch file ghi âm</h1>
    <p className="page-subtitle">Chọn file ghi âm hoặc video cuộc họp. VietNote chép lời, phân biệt người nói, dịch sang tiếng Việt và tóm tắt thành ghi chú, với giá chỉ bằng {FILE_RATE * 100}% so với ghi trực tiếp.</p>

    {!file && <button type="button" className="glass-card file-drop" onClick={() => void job.pick()}>
      <span className="file-drop-icon"><Upload size={22}/></span><strong>Chọn file ghi âm</strong>
      <small>MP3, M4A, WAV, MP4, MOV… · tối đa 500 MB và 5 giờ</small>
    </button>}

    {file && <section className="glass-card strong file-card">
      <div className="file-row"><span className="file-icon"><FileAudio size={20}/></span><div className="file-meta"><strong title={file.path}>{file.name}</strong><small>{size(file.size)}{file.durationSeconds ? ` · ${length(file.durationSeconds)}` : ' · chưa đọc được thời lượng'}</small></div>
        {!working && phase !== 'done' && <button type="button" className="pill-btn" onClick={() => void job.pick()}>Đổi file</button>}</div>

      {(phase === 'picked' || phase === 'error') && <>
        <div className="divider"/>
        <label className="field"><span>NGÔN NGỮ TRONG FILE</span><Choice icon={<Languages size={17}/>} label="Ngôn ngữ" value={job.language} onChange={job.setLanguage} options={languageOptions}/></label>
        {job.language !== 'vi' && <label className="translation-mode-note"><strong>Dịch sang tiếng Việt</strong><span>{job.translate ? 'Tiếng nước ngoài được dịch theo từng đoạn trong ghi chú.' : 'Chỉ chép lời gốc, không dịch.'}</span><span className="translate-switch"><input type="checkbox" role="switch" aria-label="Dịch sang tiếng Việt" checked={job.translate} onChange={event => job.setTranslate(event.target.checked)}/><span aria-hidden="true"/></span></label>}
        <div className="file-cost"><div><small>CHI PHÍ ƯỚC TÍNH</small><strong>{cost === null ? 'Tính theo thời lượng thực' : `~${minutes(cost)} phút`}</strong>{file.durationSeconds ? <span>{FILE_RATE * 100}% của {minutes(file.durationSeconds)} phút ghi âm</span> : <span>Trừ đúng {FILE_RATE * 100}% thời lượng sau khi xử lý</span>}</div>
          {balance !== null && <div><small>SỐ DƯ</small><strong>{Math.floor(balance / 60)} phút</strong></div>}</div>
        {tooLong && <p className="file-error">File dài hơn 5 giờ. Hãy cắt nhỏ rồi thử lại.</p>}
        {short && !tooLong && <p className="file-error">Số dư chưa đủ cho file này.</p>}
        {phase === 'error' && <p className="file-error" role="alert">{job.error}</p>}
        <div className="action-row"><div className="row-spacer"/><button type="button" className="pill-btn primary" disabled={tooLong} onClick={() => void job.start()}>{phase === 'error' ? <RefreshCw size={15}/> : <FileAudio size={15}/>}{phase === 'error' ? 'Thử lại' : 'Bắt đầu dịch'}</button></div>
      </>}

      {working && <>
        <div className="divider"/>
        <div className="file-progress" role="status">
          {phase === 'uploading' ? <><div className="file-progress-label"><span>Đang gửi file…</span><span>{job.progress}%</span></div><div className="file-progress-bar"><span style={{ width: `${job.progress}%` }}/></div></>
            : <div className="file-working"><AnimatedWaveform/><div><strong>{phase === 'processing' ? 'Đang chép lời và dịch…' : 'Đang tóm tắt thành ghi chú…'}</strong><small>Thường xong nhanh hơn nhiều so với thời lượng file. Bạn có thể chuyển sang tab khác.</small></div></div>}
        </div>
        {phase !== 'summarizing' && <div className="action-row"><div className="row-spacer"/><button type="button" className="pill-btn" onClick={job.cancel}><X size={15}/>Hủy</button></div>}
      </>}

      {phase === 'done' && <>
        <div className="divider"/>
        <div className="file-done"><CheckCircle2 size={22}/><div><strong>Đã lưu thành ghi chú</strong>{job.charged !== null && <small>Đã trừ {minutes(job.charged)} phút</small>}</div></div>
        <div className="action-row"><button type="button" className="pill-btn" onClick={job.reset}>Dịch file khác</button><div className="row-spacer"/><button type="button" className="pill-btn primary" onClick={() => setPage('notes')}>Mở ghi chú</button></div>
      </>}
    </section>}
    {!file && phase === 'error' && <p className="file-error" role="alert">{job.error}</p>}
    {(phase === 'processing' || phase === 'summarizing') && <p className="file-hint"><LoaderCircle size={13}/>Nếu đóng app, VietNote sẽ tiếp tục khi mở lại.</p>}
  </div></main>
}
