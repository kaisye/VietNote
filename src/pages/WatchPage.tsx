import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, Languages, Link2, LoaderCircle, Maximize2, Minimize2, RefreshCw, Sparkles, Speech, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Page } from '../services/types'
import { AnimatedWaveform } from '../components/AnimatedWaveform'
import { HoverMenu } from '../island/HoverMenu'
import { YouTubePlayer, playerError, type PlayerControl } from '../components/YouTubePlayer'
import { WatchScripts } from '../components/WatchScripts'
import { desktop } from '../services/desktop'
import { watchCost } from '../services/fileTranscript'
import type { Listening } from '../hooks/useWatch'
import { DUB_VOLUME } from '../hooks/useDub'
import { dubVoices } from '../hooks/useSpeech'
import { captionChunks, captionPageAt, lineAt, youtubeId } from '../services/youtube'
import type { WatchLine } from '../services/youtube'
import { buildWatchNote, summarizeWatchedVideo, watchedVideoSegments } from '../services/watchNote'

type Mode = 'vi' | 'both' | 'source' | 'off'
const modes: { mode: Mode; label: string }[] = [{ mode: 'vi', label: 'Tiếng Việt' }, { mode: 'both', label: 'Song ngữ' }, { mode: 'source', label: 'Gốc' }, { mode: 'off', label: 'Tắt' }]
const dubbingModes = [{ value: dubVoices[0].id, label: 'Nam' }, { value: dubVoices[1].id, label: 'Nữ' }, { value: 'off', label: 'Tắt' }]
const MIN_CAPTION_SIZE = 14
const MAX_CAPTION_SIZE = 56

const stored = <T,>(key: string, fallback: T, valid: (value: unknown) => boolean): T => { try { const value = JSON.parse(localStorage.getItem(key) ?? 'null'); return valid(value) ? value : fallback } catch { return fallback } }
const store = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window */ } }
const listeningLabel = ({ stage, percent }: Listening) =>
  stage === 'fetching' ? `Đang lấy âm thanh${percent ? ` · ${percent}%` : '…'}` : stage === 'uploading' ? `Đang gửi âm thanh · ${percent}%` : 'Đang chép lời từ âm thanh…'

/** A YouTube video with Vietnamese subtitles translated before each line is spoken. */
export function WatchPage({ model, setPage }: { model: AppModel; setPage: (page: Page) => void }) {
  const { watch, dub, speech } = model
  const { phase, video, lines } = watch
  const [link, setLink] = useState(video?.url ?? '')
  const [time, setTime] = useState(watch.position.current)
  const [mode, setMode] = useState<Mode>(() => stored('watchMode', 'vi', value => modes.some(item => item.mode === value)))
  const [size, setSize] = useState(MIN_CAPTION_SIZE)
  const [theater, setTheater] = useState(false)
  const [failure, setFailure] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [captionMenu, setCaptionMenu] = useState<string | null>(null)
  const [captionPosition, setCaptionPosition] = useState<{ left: number; bottom: number } | null>(null)
  const captionRef = useRef<HTMLDivElement>(null)
  const captionDrag = useRef<{ id: number; x: number; y: number; left: number; bottom: number } | null>(null)
  const captionResize = useRef<{ id: number; x: number; y: number; size: number } | null>(null)
  const control = useRef<PlayerControl>(null)
  const watchedRef = useRef<WatchLine[]>([])
  const saveSnapshot = useRef<WatchLine[]>([])
  const onWatchedChange = useCallback((watched: WatchLine[]) => { watchedRef.current = watched }, [])
  const captionMenuProps = (name: string) => ({ name, open: captionMenu === name, onOpen: (open: boolean) => setCaptionMenu(current => open ? name : current === name ? null : current) })

  useEffect(() => store('watchMode', mode), [mode])
  // Every newly opened video starts with the smallest unobtrusive caption frame. The viewer can
  // still enlarge it for the current video by dragging its lower-right corner.
  useEffect(() => { setFailure(''); setSize(MIN_CAPTION_SIZE); setCaptionPosition(null); dub.reset() }, [video?.videoId]) // eslint-disable-line react-hooks/exhaustive-deps
  // The voice stays loaded while a dubbed video is open; YouTube's own sound goes down under it.
  const dubbing = dub.on && speech.installed && speech.state === 'ready'
  const applyVolume = () => control.current?.volume(dubbing ? DUB_VOLUME : 100)
  useEffect(() => {
    // Prepare the selected voice while captions and the player are still loading.
    speech.hold(phase === 'loading' || phase === 'ready' ? dub.voice : null)
    applyVolume()
  }, [dubbing, phase, dub.voice, speech.installed]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { speech.hold(null); dub.reset() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const selectDubbing = (value: string) => {
    if (value === 'off') { dub.setOn(false); return }
    dub.setVoice(value)
    if (!speech.installed && !speech.progress) void speech.download(true)
    if (!dub.on) dub.setOn(true)
  }
  useEffect(() => {
    if (!theater) return
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setTheater(false)
    }
    window.addEventListener('keydown', leave, true)
    document.documentElement.classList.add('watch-theater')
    return () => { window.removeEventListener('keydown', leave, true); document.documentElement.classList.remove('watch-theater') }
  }, [theater])

  const current = lineAt(lines, time)
  const line = current >= 0 ? lines[current] : null
  const viChunks = line?.translation ? captionChunks(line.translation) : []
  const sourceChunks = line ? captionChunks(line.source) : []
  const showVi = mode !== 'source' && line?.translation !== undefined
  const showSource = mode !== 'vi' || !showVi
  const pageCount = Math.max(showVi ? viChunks.length : 0, showSource ? sourceChunks.length : 0, 1)
  const captionPage = line ? captionPageAt(line, time, pageCount) : 0
  const open = (event?: React.FormEvent) => {
    event?.preventDefault()
    const url = link.trim()
    if (!url) return
    if (youtubeId(url) && speech.available && !speech.installed && !speech.progress) void speech.download(true)
    void watch.load(url)
  }
  const onTime = (at: number, isPlaying: boolean) => { setTime(at); watch.watching(at, isPlaying); if (dubbing) dub.tick(lines, at, isPlaying) }
  const requestClose = () => {
    saveSnapshot.current = watchedRef.current.map(line => ({ ...line }))
    control.current?.pause()
    setSaveOpen(true)
  }
  const closeWithoutSaving = () => { setSaveOpen(false); watch.close() }
  const summarizeAndClose = () => {
    const snapshot = saveSnapshot.current
    if (!video || !snapshot.length) return
    setSaveOpen(false)
    const pending = buildWatchNote(video, snapshot)
    void (async () => {
      // Persist the transcript first, then replace the same note when its background summary is ready.
      await model.saveWatchNote(pending)
      try {
        const summary = await summarizeWatchedVideo(watchedVideoSegments(snapshot), video.title || 'Video YouTube')
        const completed = { ...buildWatchNote(video, snapshot, summary), id: pending.id, createdAt: pending.createdAt }
        await model.saveWatchNote(completed)
      } catch {
        await model.saveWatchNote({ ...pending, saving: false, updatedAt: new Date().toISOString(), summary: 'Chưa tạo được tóm tắt · lời thoại đã xem vẫn được lưu đầy đủ.' })
      }
    })()
    watch.close()
    setPage('notes')
  }
  const { listening } = watch
  /** Watch Video is billed one-for-one: one video minute consumes one credit minute. */
  const listenCost = video?.duration ? watchCost(video.duration) : null
  const listenMinutes = listenCost !== null ? Math.max(1, Math.ceil(listenCost / 60)) : null
  const balance = model.account?.balanceSeconds
  const short = listenCost !== null && typeof balance === 'number' && balance < listenCost
  const listenButton = (label: string) => <button className="pill-btn primary" onClick={() => void watch.listen()} disabled={short}><AudioLines size={15}/>{label}{listenMinutes ? ` · ~${listenMinutes} phút` : ''}</button>

  const caption = ((line && mode !== 'off') || theater) && <div ref={captionRef} className={`watch-caption ${mode === 'off' ? 'off' : ''}`} style={{ fontSize: theater ? size * 1.35 : Math.max(14, size * 0.65), ...(captionPosition ? { left: `${captionPosition.left}%`, bottom: `${captionPosition.bottom}%`, transform: 'none' } : {}) }} aria-live="off"
    onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button, .hover-menu')) setCaptionPosition(null) }}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button, .hover-menu')) return
      const box = event.currentTarget.getBoundingClientRect()
      const screen = event.currentTarget.parentElement!.getBoundingClientRect()
      captionDrag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.left - screen.left, bottom: screen.bottom - box.bottom }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    }}
    onPointerMove={event => {
      const drag = captionDrag.current
      if (!drag || drag.id !== event.pointerId) return
      const box = event.currentTarget.getBoundingClientRect()
      const screen = event.currentTarget.parentElement!.getBoundingClientRect()
      const left = Math.max(8, Math.min(screen.width - box.width - 8, drag.left + event.clientX - drag.x))
      const bottom = Math.max(8, Math.min(screen.height - box.height - 8, drag.bottom - event.clientY + drag.y))
      setCaptionPosition({ left: left / screen.width * 100, bottom: bottom / screen.height * 100 })
    }}
    onPointerUp={() => { captionDrag.current = null }} onPointerCancel={() => { captionDrag.current = null }}>
    {theater && <div className="watch-caption-controls" role="toolbar" aria-label="Tùy chọn phụ đề">
      <HoverMenu {...captionMenuProps('display')} value={mode} options={modes.map(item => ({ value: item.mode, label: item.label }))} onChange={setMode}
        icon={<Languages size={15}/>} title="Hiển thị phụ đề" on={mode !== 'off'}/>
      {speech.available && <HoverMenu {...captionMenuProps('voice')} value={dub.on ? dub.voice : 'off'} options={dubbingModes} onChange={selectDubbing}
        on={dub.on} icon={dub.on && (speech.progress || speech.state === 'loading') ? <LoaderCircle size={15} className="speech-loading"/> : <Speech size={15}/>}
        title="Lồng tiếng"/>}
    </div>}
    {line && mode !== 'off' && <div className="watch-caption-content">
      {showVi && <p className="watch-caption-primary">{viChunks[Math.floor(captionPage * viChunks.length / pageCount)]}</p>}
      {showSource && <p className={mode === 'source' ? 'watch-caption-primary' : `watch-caption-source ${mode === 'vi' ? 'faint' : ''}`}>{sourceChunks[Math.floor(captionPage * sourceChunks.length / pageCount)]}</p>}
    </div>}
    <button type="button" className="watch-caption-resize" aria-label="Chỉnh cỡ chữ phụ đề" title="Kéo góc để chỉnh cỡ chữ · phím mũi tên để tăng giảm"
      onDoubleClick={event => event.stopPropagation()}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.stopPropagation(); event.preventDefault()
        captionResize.current = { id: event.pointerId, x: event.clientX, y: event.clientY, size }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const drag = captionResize.current
        if (!drag || drag.id !== event.pointerId) return
        event.stopPropagation()
        setSize(Math.max(MIN_CAPTION_SIZE, Math.min(MAX_CAPTION_SIZE, Math.round(drag.size + (event.clientX - drag.x + event.clientY - drag.y) / 8))))
      }}
      onPointerUp={() => { captionResize.current = null }} onPointerCancel={() => { captionResize.current = null }} onLostPointerCapture={() => { captionResize.current = null }}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        setSize(value => Math.max(MIN_CAPTION_SIZE, Math.min(MAX_CAPTION_SIZE, value + (['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : -1))))
      }}/>
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
      <section className={`glass-card strong watch-stage ${theater ? 'theater' : ''}`} aria-label="Trình phát video">
        <div className="watch-panel-head panel-heading">
          <div className="watch-panel-title"><h3>{video.title || 'Video YouTube'}</h3><small>{lines.length ? `${lines.length} câu phụ đề` : 'Chưa có phụ đề'}</small></div>
          <button className="watch-icon" onClick={requestClose} aria-label="Đóng video" title="Đóng video"><X size={16}/></button>
        </div>
        <div className="divider watch-panel-divider"/>
        <div className="watch-stage-body">
        <div className="watch-screen">
          <YouTubePlayer videoId={video.videoId} start={watch.position.current} control={control} onTime={onTime} onReady={applyVolume} onError={code => setFailure(playerError(code))}/>
          {caption}
          {theater && dub.on && (dub.error || speech.state === 'error') && <span className="watch-waiting" role="alert">{dub.error || speech.message}</span>}
          {failure && <div className="watch-failure" role="alert"><p>{failure}</p><button className="pill-btn" onClick={() => void desktop.openLink(video.url)}>Mở trong trình duyệt</button></div>}
          <button className="watch-icon watch-expand" onClick={() => setTheater(value => !value)} aria-label={theater ? 'Thu nhỏ video' : 'Mở rộng video'} title={theater ? 'Thu nhỏ video (Esc)' : 'Mở rộng video'}>{theater ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button>
        </div>
        <div className="watch-side" aria-label="Tùy chỉnh video">
        <div className="watch-toolbar">
          <span className="watch-toolbar-label">Phụ đề</span>
          <div className="segmented" role="radiogroup" aria-label="Phụ đề">{modes.map(item => <button key={item.mode} role="radio" aria-checked={mode === item.mode} className={mode === item.mode ? 'selected' : ''} onClick={() => setMode(item.mode)}>{item.label}</button>)}</div>
        </div>
        {speech.available && <div className="watch-toolbar">
          <span className="watch-toolbar-label">Lồng tiếng</span>
          <div className="segmented" role="radiogroup" aria-label="Lồng tiếng">{dubbingModes.map(item => <button key={item.value} role="radio" aria-checked={(dub.on ? dub.voice : 'off') === item.value} className={(dub.on ? dub.voice : 'off') === item.value ? 'selected' : ''} onClick={() => selectDubbing(item.value)}>{item.label}</button>)}</div>
          {dub.on && speech.progress && <span className="watch-progress"><LoaderCircle size={13} className="speech-loading"/>Đang tải giọng đọc{speech.progress.total ? ` · ${Math.round(speech.progress.downloaded / speech.progress.total * 100)}%` : '…'}</span>}
          {dub.on && speech.installed && speech.state === 'loading' && <span className="watch-progress"><LoaderCircle size={13} className="speech-loading"/>Đang chuẩn bị giọng đọc…</span>}
          {dub.on && speech.state === 'error' && <span className="watch-progress" role="alert">{speech.message}</span>}
          {dub.on && dub.error && <span className="watch-progress" role="alert">{dub.error}</span>}
        </div>}
        {watch.translateError && <div className="watch-alert" role="alert"><span>{watch.translateError}</span><button className="pill-btn" onClick={watch.retry}><RefreshCw size={14}/>Thử lại</button></div>}
        {watch.usageError && <div className="watch-alert" role="alert"><span>{watch.usageError}</span></div>}
        {(video.kind === 'none' || listening || watch.listenError) && <div className="glass-card watch-listen">
          {listening ? <>
            <div className="file-working"><AnimatedWaveform/><div><strong>{listeningLabel(listening)}</strong><small>Thường mất 1–3 phút. Bạn cứ xem video, phụ đề sẽ hiện khi xong.</small></div></div>
            {listening.stage !== 'processing' && <div className="file-progress-bar"><span style={{ width: `${listening.percent}%` }}/></div>}
            <button className="pill-btn" onClick={watch.stopListening}><X size={14}/>Hủy</button>
          </> : video.kind === 'none' ? <>
            <strong>Video này chưa có phụ đề</strong>
            <p>VietNote có thể nghe âm thanh của video, chép lời rồi dịch trước như phụ đề. Mỗi phút video dùng 1 phút credit.</p>
            {listenButton('Nghe và dịch')}
          </> : null}
          {short && !listening && <p className="file-error">Số dư chưa đủ để nghe video này.</p>}
          {watch.listenError && <p className="file-error" role="alert">{watch.listenError}</p>}
        </div>}
        </div>
        </div>
      </section>
      <WatchScripts key={`${video.videoId}-${video.kind}`} title={video.title || 'Video YouTube'} lines={lines} time={time} onWatchedChange={onWatchedChange} onSeek={at => { control.current?.seek(at); setTime(at); watch.watching(at) }}/>
    </div>}
    {saveOpen && <div className="dialog-backdrop">
      <div className="app-dialog save-dialog watch-save-dialog" role="dialog" aria-modal="true" aria-label="Lưu ghi chú video">
        <div className="watch-save-heading"><Sparkles size={20}/><h2>Lưu ghi chú video?</h2></div>
        <p>VietNote sẽ chuyển ngay sang Ghi chú, rồi tự động tóm tắt những đoạn bạn đã xem ở chế độ nền.</p>
        <div className="watch-save-details"><strong>{saveSnapshot.current.length} câu lời thoại đã xem</strong><small>Đoạn tua qua không được đưa vào bản tóm tắt.</small></div>
        {!saveSnapshot.current.length && <p className="dialog-error">Chưa có lời thoại đã xem để lưu.</p>}
        <div className="dialog-actions"><button type="button" className="pill-btn danger" onClick={closeWithoutSaving}>Đóng không lưu</button><button type="button" className="pill-btn primary save-main" disabled={!saveSnapshot.current.length} onClick={summarizeAndClose}><Sparkles size={15}/>Tóm tắt & lưu</button></div>
      </div>
    </div>}
  </div></main>
}
