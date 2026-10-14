import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AudioLines, Link2, LoaderCircle, Maximize2, Minimize2, RefreshCw, Speech, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import { AnimatedWaveform } from '../components/AnimatedWaveform'
import { YouTubePlayer, playerError, type PlayerControl } from '../components/YouTubePlayer'
import { desktop } from '../services/desktop'
import { fileCost } from '../services/fileTranscript'
import type { Listening } from '../hooks/useWatch'
import { DUB_VOLUME } from '../hooks/useDub'
import { clock, lineAt, lineBefore } from '../services/youtube'

type Mode = 'vi' | 'both' | 'source'
const modes: { mode: Mode; label: string }[] = [{ mode: 'vi', label: 'Tiếng Việt' }, { mode: 'both', label: 'Song ngữ' }, { mode: 'source', label: 'Gốc' }]
const SIZES = [18, 22, 26, 32, 40]

const stored = <T,>(key: string, fallback: T, valid: (value: unknown) => boolean): T => { try { const value = JSON.parse(localStorage.getItem(key) ?? 'null'); return valid(value) ? value : fallback } catch { return fallback } }
const store = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window */ } }
const listeningLabel = ({ stage, percent }: Listening) =>
  stage === 'fetching' ? `Đang lấy âm thanh${percent ? ` · ${percent}%` : '…'}` : stage === 'uploading' ? `Đang gửi âm thanh · ${percent}%` : 'Đang chép lời từ âm thanh…'
const setWindowFullscreen = (on: boolean) => { if (desktop.isDesktop) void getCurrentWindow().setFullscreen(on).catch(() => {}) }

/** A YouTube video with Vietnamese subtitles translated before each line is spoken. */
export function WatchPage({ model }: { model: AppModel }) {
  const { watch, dub, speech } = model
  const { phase, video, lines } = watch
  const [link, setLink] = useState(video?.url ?? '')
  const [time, setTime] = useState(watch.position.current)
  const [playing, setPlaying] = useState(false)
  const [mode, setMode] = useState<Mode>(() => stored('watchMode', 'vi', value => modes.some(item => item.mode === value)))
  const [size, setSize] = useState(() => stored('watchSize', 1, value => typeof value === 'number' && value >= 0 && value < SIZES.length))
  const [theater, setTheater] = useState(false)
  const [failure, setFailure] = useState('')
  const control = useRef<PlayerControl>(null)
  const list = useRef<HTMLOListElement>(null)
  const browsing = useRef(0)

  useEffect(() => store('watchMode', mode), [mode])
  useEffect(() => store('watchSize', size), [size])
  useEffect(() => { setFailure(''); dub.reset() }, [video?.videoId]) // eslint-disable-line react-hooks/exhaustive-deps
  // The voice stays loaded while a dubbed video is open; YouTube's own sound goes down under it.
  const dubbing = dub.on && speech.installed
  const applyVolume = () => control.current?.volume(dubbing ? DUB_VOLUME : 100)
  useEffect(() => {
    speech.hold(dubbing && phase === 'ready')
    applyVolume()
  }, [dubbing, phase]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { speech.hold(false); dub.reset() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleDub = () => {
    if (dub.on) { dub.setOn(false); return }
    // The voice is a separate download, fetched the first time dubbing is turned on.
    if (!speech.installed) void speech.download(true)
    dub.setOn(true)
  }
  useEffect(() => {
    if (!theater) return
    const leave = (event: KeyboardEvent) => { if (event.key === 'Escape') setTheater(false) }
    window.addEventListener('keydown', leave)
    document.documentElement.classList.add('watch-theater')
    setWindowFullscreen(true)
    return () => { window.removeEventListener('keydown', leave); document.documentElement.classList.remove('watch-theater'); setWindowFullscreen(false) }
  }, [theater])

  const current = lineAt(lines, time)
  const line = current >= 0 ? lines[current] : null
  const following = lineBefore(lines, time)
  // Keep the line being heard in view, unless the reader scrolled the list in the last few seconds.
  useEffect(() => {
    if (following < 0 || Date.now() - browsing.current < 4000) return
    list.current?.querySelector<HTMLElement>(`[data-index="${following}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [following])

  const open = (event?: React.FormEvent) => { event?.preventDefault(); if (link.trim()) void watch.load(link.trim()) }
  const onTime = (at: number, isPlaying: boolean) => { setTime(at); setPlaying(isPlaying); watch.watching(at); if (dubbing) dub.tick(lines, at, isPlaying) }
  const seek = (at: number) => { control.current?.seek(at); setTime(at); watch.watching(at) }
  const waiting = playing && line && line.translation === undefined && mode !== 'source'
  const { done, total } = watch.progress
  const { listening } = watch
  /** Minutes hearing the video costs, charged like a recording. */
  const listenMinutes = video?.duration ? Math.max(1, Math.ceil(fileCost(video.duration) / 60)) : null
  const balance = model.account?.balanceSeconds
  const short = listenMinutes !== null && typeof balance === 'number' && balance < listenMinutes * 60
  const listenButton = (label: string) => <button className="pill-btn primary" onClick={() => void watch.listen()} disabled={short}><AudioLines size={15}/>{label}{listenMinutes ? ` · ~${listenMinutes} phút` : ''}</button>

  const caption = line && <div className="watch-caption" style={{ fontSize: SIZES[size] }} aria-live="off">
    {mode !== 'source' && line.translation !== undefined && <p className="watch-caption-vi">{line.translation}</p>}
    {(mode !== 'vi' || line.translation === undefined) && <p className={`watch-caption-source ${mode === 'vi' ? 'faint' : ''}`}>{line.source}</p>}
  </div>

  return <main className="page-scroll"><div className="page-wrap watch-page animate-in">
    <div className="eyebrow">WATCH WITH SUBTITLES</div><h1>Xem video có phụ đề</h1>
    <p className="page-subtitle">Dán link YouTube. VietNote dịch sẵn phụ đề trước đoạn bạn đang xem, nên tiếng Việt hiện cùng lúc với lời nói, không phải chờ.</p>
    <form className="glass-card link-form" onSubmit={open}>
      <div className="link-form-row"><label className="link-input-frame"><Link2 size={18} className="link-form-icon"/>
        <input value={link} autoComplete="off" onChange={event => setLink(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-label="Link video YouTube" spellCheck={false}/></label>
        <button type="submit" className="pill-btn primary" disabled={!link.trim() || phase === 'loading'}>{phase === 'loading' ? <LoaderCircle size={15} className="speech-loading"/> : null}Mở video</button></div>
    </form>

    {phase === 'loading' && <section className="glass-card strong file-card"><div className="file-working"><AnimatedWaveform/><div><strong>Đang đọc phụ đề của video…</strong><small>Lần đầu có thể mất thêm ít phút để chuẩn bị.</small></div></div></section>}
    {phase === 'error' && <section className="glass-card strong file-card"><p className="file-error" role="alert">{watch.error}</p></section>}

    {phase === 'ready' && video && <div className="watch-layout">
      <section className={`watch-stage ${theater ? 'theater' : ''}`}>
        <div className="watch-screen">
          <YouTubePlayer videoId={video.videoId} start={watch.position.current} control={control} onTime={onTime} onReady={applyVolume} onError={code => setFailure(playerError(code))}/>
          {caption}
          {listening && <span className="watch-waiting"><LoaderCircle size={13} className="speech-loading"/>{listeningLabel(listening)}</span>}
          {waiting && !listening && <span className="watch-waiting"><LoaderCircle size={13} className="speech-loading"/>Đang dịch đoạn này…</span>}
          {failure && <div className="watch-failure" role="alert"><p>{failure}</p><button className="pill-btn" onClick={() => void desktop.openLink(video.url)}>Mở trong trình duyệt</button></div>}
        </div>
        <div className="watch-toolbar">
          <div className="segmented" role="radiogroup" aria-label="Phụ đề">{modes.map(item => <button key={item.mode} role="radio" aria-checked={mode === item.mode} className={mode === item.mode ? 'selected' : ''} onClick={() => setMode(item.mode)}>{item.label}</button>)}</div>
          <div className="segmented" aria-label="Cỡ chữ"><button onClick={() => setSize(value => Math.max(0, value - 1))} disabled={size === 0} aria-label="Chữ nhỏ hơn">A−</button><button onClick={() => setSize(value => Math.min(SIZES.length - 1, value + 1))} disabled={size === SIZES.length - 1} aria-label="Chữ lớn hơn">A+</button></div>
          {speech.available && <button className={`pill-btn ${dub.on ? 'primary' : ''}`} onClick={toggleDub} aria-pressed={dub.on} title="Đọc bản dịch bằng giọng tiếng Việt, tiếng gốc hạ nhỏ"><Speech size={15}/>Lồng tiếng</button>}
          {dub.on && speech.progress && <span className="watch-progress"><LoaderCircle size={13} className="speech-loading"/>Đang tải giọng đọc{speech.progress.total ? ` · ${Math.round(speech.progress.downloaded / speech.progress.total * 100)}%` : '…'}</span>}
          {dubbing && speech.state === 'loading' && <span className="watch-progress"><LoaderCircle size={13} className="speech-loading"/>Đang chuẩn bị giọng đọc…</span>}
          {dubbing && speech.state === 'error' && <span className="watch-progress">{speech.message}</span>}
          <span className="watch-progress" role="status">{video.kind === 'none' ? 'Video chưa có phụ đề' : video.language === 'vi' ? 'Phụ đề tiếng Việt có sẵn' : done >= total ? 'Đã dịch xong cả video' : <><LoaderCircle size={13} className="speech-loading"/>Đang dịch trước · {done}/{total} đoạn</>}</span>
          <div className="row-spacer"/>
          <button className="watch-icon" onClick={() => setTheater(value => !value)} aria-label={theater ? 'Thoát toàn màn hình' : 'Toàn màn hình'} title={theater ? 'Thoát toàn màn hình (Esc)' : 'Toàn màn hình'}>{theater ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
          <button className="watch-icon" onClick={watch.close} aria-label="Đóng video" title="Đóng video"><X size={16}/></button>
        </div>
        {watch.translateError && <div className="watch-alert" role="alert"><span>{watch.translateError}</span><button className="pill-btn" onClick={watch.retry}><RefreshCw size={14}/>Thử lại</button></div>}
      </section>

      <aside className="glass-card watch-lines">
        <header><strong title={video.title}>{video.title || 'Video'}</strong>
          {video.kind !== 'none' && <small>{video.kind === 'auto' ? 'Phụ đề tự động của YouTube' : video.kind === 'heard' ? 'Chép lời từ âm thanh' : 'Phụ đề của video'} · {lines.length} câu</small>}
          {video.kind === 'auto' && !listening && <button className="watch-relisten" onClick={() => void watch.listen()} disabled={short} title="Phụ đề tự động hay thiếu dấu câu và nghe nhầm; nghe lại từ âm thanh cho bản chính xác hơn">Nghe lại để chính xác hơn{listenMinutes ? ` · ~${listenMinutes} phút` : ''}</button>}
        </header>
        {(video.kind === 'none' || listening || watch.listenError) && <div className="watch-listen">
          {listening ? <>
            <div className="file-working"><AnimatedWaveform/><div><strong>{listeningLabel(listening)}</strong><small>Thường mất 1–3 phút. Bạn cứ xem video, phụ đề sẽ hiện khi xong.</small></div></div>
            {listening.stage !== 'processing' && <div className="file-progress-bar"><span style={{ width: `${listening.percent}%` }}/></div>}
            <button className="pill-btn" onClick={watch.stopListening}><X size={14}/>Hủy</button>
          </> : video.kind === 'none' ? <>
            <strong>Video này chưa có phụ đề</strong>
            <p>VietNote có thể nghe âm thanh của video, chép lời rồi dịch trước như phụ đề. Phút sử dụng được tính như dịch file.</p>
            {listenButton('Nghe và dịch')}
          </> : null}
          {short && !listening && <p className="file-error">Số dư chưa đủ để nghe video này.</p>}
          {watch.listenError && <p className="file-error" role="alert">{watch.listenError}</p>}
        </div>}
        <ol ref={list} onWheel={() => { browsing.current = Date.now() }} onTouchMove={() => { browsing.current = Date.now() }}>
          {lines.map((item, index) => <li key={`${item.start}-${index}`} data-index={index} className={index === following ? 'active' : ''}>
            <button onClick={() => seek(item.start)}><time>{clock(item.start)}</time><span>{item.translation !== undefined && <b>{item.translation}</b>}<small>{item.source}</small></span></button>
          </li>)}
        </ol>
      </aside>
    </div>}
  </div></main>
}
