import { AudioLines, Gauge, Languages, Loader2, Square, UserRound, Volume2, Zap } from 'lucide-react'
import { modeOptions, speechRates, voiceOptions } from '../hooks/useSpeech'
import { useRef } from 'react'
import type { AppModel } from '../hooks/useAppModel'
import { formatTime } from '../services/notes'
import { MicrophoneToggle, SystemAudioToggle, audioOptions, languageOptions } from '../components/MeetingControls'
import { Choice } from '../components/Choice'
import { visibleTranslation } from '../services/translationView'
import { LiveAssistant } from '../components/LiveAssistant'

const speechNote = (model: AppModel) => {
  const { speech } = model
  if (speech.message) return speech.message
  if (!speech.enabled) return 'Đọc bản dịch tiếng Việt bằng giọng ZeroTTS chạy trên máy'
  if (speech.state === 'loading') return 'Đang tải giọng đọc…'
  if (model.microphoneOn) return 'Đang bật mic: nên dùng tai nghe để mic không thu lại giọng đọc'
  return 'Giọng đọc sẵn sàng · đọc từng câu ngay khi dịch xong'
}

function SpeechPanel({ model }: { model: AppModel }) {
  const { speech } = model
  return <div className={`translator-speech-panel ${speech.enabled ? 'enabled' : ''}`}>
    <div className="translator-speech-header">
      <label className="speech-master-toggle">
        <input type="checkbox" checked={speech.enabled} onChange={event => speech.setEnabled(event.target.checked)}/>
        <span className="speech-toggle-icon">{speech.state === 'loading' ? <Loader2 size={19} className="speech-loading"/> : <Volume2 size={19}/>}</span>
        <span className="speech-toggle-copy"><strong>Nghe bản dịch</strong><small>{speechNote(model)}</small></span>
      </label>
      {speech.enabled && <label className="speed-select wide"><span>CHẾ ĐỘ ĐỌC</span><Choice icon={<Zap size={16}/>} label="Chế độ đọc" value={speech.mode} onChange={speech.setMode} options={modeOptions}/></label>}
      {speech.enabled && <label className="speed-select wide"><span>GIỌNG ĐỌC</span><Choice icon={<UserRound size={16}/>} label="Giọng đọc" value={speech.voice} onChange={speech.setVoice} options={voiceOptions}/></label>}
      {speech.enabled && <label className="speed-select"><span>TỐC ĐỘ ĐỌC</span><Choice icon={<Gauge size={16}/>} label="Tốc độ đọc" value={speech.rate} onChange={speech.setRate} options={speechRates.map(rate => ({ value: rate as number, label: `${rate}×` }))}/></label>}
    </div>
  </div>
}

export function TranslatorPage({ model }: { model: AppModel }) {
  const transcript = useRef<HTMLElement>(null)
  return <main className="page-scroll"><div className="page-wrap narrow animate-in"><div className="eyebrow">REAL-TIME INTERPRETER</div><h1>Phiên dịch trực tiếp</h1><p className="page-subtitle">Dịch tiếng Anh hoặc tiếng Trung sang tiếng Việt ngay khi đang nói.</p>
    <section className="glass-card translator-controls"><div className="select-row"><label className="field"><span>NGÔN NGỮ</span><Choice icon={<Languages size={17}/>} label="Ngôn ngữ" value={model.sourceLanguage} onChange={value => model.setSourceLanguage(value)} disabled={model.capturing || model.busy} options={languageOptions}/></label><label className="field"><span>ÂM THANH</span><Choice icon={<Volume2 size={17}/>} label="Nguồn âm thanh" value={model.audioInput} onChange={value => model.setAudioInput(value)} disabled={model.capturing || model.busy} options={audioOptions}/></label></div>
      {model.sourceLanguage !== 'vi' && model.speech.available && <SpeechPanel model={model}/>}
      <div className="action-row"><small>{model.status}</small><div className="row-spacer"/>{model.capturing && <><SystemAudioToggle model={model}/><MicrophoneToggle model={model}/></>}{model.capturing ? <button className="pill-btn primary" onClick={() => void model.stop()}><Square size={14} fill="currentColor"/>Dừng</button> : <button className="pill-btn primary" onClick={() => void model.start()} disabled={!model.ready || model.busy}><AudioLines size={16}/>Bắt đầu</button>}</div></section>
    <section className="glass-card strong transcript-list" ref={transcript}><h3>Bản ghi</h3>{model.entries.map(entry => { const blocks = [visibleTranslation(model.translationBlocks, entry.id)].filter(block => block !== undefined); return <article key={entry.id} className="translation-entry" data-entry-id={entry.id}><small>{formatTime(entry.timestamp, false)} · {entry.audioSource === 'microphone' ? 'Mic' : 'System'} · {entry.speaker ?? 'Chưa xác định người nói'}{entry.speaker && entry.speakerProvisional ? ' (tạm)' : ''}</small><p>{entry.sourceText}</p>{blocks.map(block => <div key={block.id} className={`translation-result ${block.pending ? 'pending' : ''}`}><small>TIẾNG VIỆT · {block.kind === 'live' ? (block.pending ? 'ĐANG DỊCH TRỰC TIẾP' : 'DỊCH TRỰC TIẾP') : (block.pending ? 'ĐANG DỊCH CẢ ĐOẠN' : 'BẢN DỊCH THEO ĐOẠN')}</small><p>{block.translatedText}</p></div>)}</article> })}{model.interimTranscripts.map(item => { const translated = model.translationBlocks.find(block => block.kind === 'live' && block.id === item.id); return <article key={item.id} className="translation-entry interim"><small>{translated ? 'ĐANG DỊCH' : 'ĐANG NHẬN DIỆN'} · {item.source === 'microphone' ? 'Mic' : 'System'}{item.speaker ? ` · ${item.speaker} (tạm)` : ''}</small><p>{item.text}</p>{translated && <div className="translation-result pending"><small>TIẾNG VIỆT · ĐANG DỊCH TRỰC TIẾP</small><p>{translated.translatedText}</p></div>}</article> })}{!model.entries.length && !model.interimTranscripts.length && <p className="muted">Chưa có lời nói được nhận diện.</p>}</section>
    <LiveAssistant chat={model.liveChat} entries={model.entries} transcript={transcript}/>
  </div></main>
}
