import { AudioLines, ChevronDown, Languages, Square, Volume2 } from 'lucide-react'
import { useRef } from 'react'
import type { AppModel } from '../hooks/useAppModel'
import type { AudioInput, Language } from '../services/types'
import { formatTime } from '../services/notes'
import { MicrophoneToggle } from '../components/MeetingControls'
import { visibleTranslation } from '../services/translationView'
import { LiveAssistant } from '../components/LiveAssistant'

export function TranslatorPage({ model }: { model: AppModel }) {
  const transcript = useRef<HTMLElement>(null)
  return <main className="page-scroll"><div className="page-wrap narrow animate-in"><div className="eyebrow">REAL-TIME INTERPRETER</div><h1>Phiên dịch trực tiếp</h1><p className="page-subtitle">Dịch tiếng Anh hoặc tiếng Trung sang tiếng Việt ngay khi đang nói.</p>
    <section className="glass-card translator-controls"><div className="select-row"><label className="field"><span>NGÔN NGỮ</span><div className="meeting-choice"><Languages size={17}/><select value={model.sourceLanguage} onChange={e => model.setSourceLanguage(e.target.value as Language)} disabled={model.capturing || model.busy}><option value="auto">Tự động nhận diện → Tiếng Việt</option><option value="vi">Tiếng Việt</option><option value="en">Tiếng Anh → Tiếng Việt</option><option value="zh">Tiếng Trung → Tiếng Việt</option></select><ChevronDown size={17}/></div></label><label className="field"><span>ÂM THANH</span><div className="meeting-choice"><Volume2 size={17}/><select value={model.audioInput} onChange={e => model.setAudioInput(e.target.value as AudioInput)} disabled={model.capturing || model.busy}><option value="system">Âm thanh máy</option><option value="microphone">Micro</option><option value="both">Micro + âm thanh máy</option></select><ChevronDown size={17}/></div></label></div>
      {model.sourceLanguage !== 'vi' && <div className="translator-speech-panel">
        <div className="translator-speech-header">
          <label className="speech-master-toggle" aria-disabled="true">
            <input type="checkbox" checked={false} disabled readOnly/>
            <span className="speech-toggle-icon"><Volume2 size={19}/></span>
            <span className="speech-toggle-copy"><strong>Nghe bản dịch · Sắp ra mắt</strong><small>Đọc bản dịch tiếng Việt thành tiếng đang được phát triển</small></span>
          </label>
        </div>
      </div>}
      <div className="action-row"><small>{model.status}</small><div className="row-spacer"/>{model.capturing && <MicrophoneToggle model={model}/>}{model.capturing ? <button className="pill-btn primary" onClick={() => void model.stop()}><Square size={14} fill="currentColor"/>Dừng</button> : <button className="pill-btn primary" onClick={() => void model.start()} disabled={!model.ready || model.busy}><AudioLines size={16}/>Bắt đầu</button>}</div></section>
    <section className="glass-card strong transcript-list" ref={transcript}><h3>Bản ghi</h3>{model.entries.map(entry => { const blocks = [visibleTranslation(model.translationBlocks, entry.id)].filter(block => block !== undefined); return <article key={entry.id} className="translation-entry" data-entry-id={entry.id}><small>{formatTime(entry.timestamp, false)} · {entry.audioSource === 'microphone' ? 'Mic' : 'System'} · {entry.speaker ?? 'Chưa xác định người nói'}{entry.speaker && entry.speakerProvisional ? ' (tạm)' : ''}</small><p>{entry.sourceText}</p>{blocks.map(block => <div key={block.id} className={`translation-result ${block.pending ? 'pending' : ''}`}><small>TIẾNG VIỆT · {block.kind === 'live' ? (block.pending ? 'ĐANG DỊCH TRỰC TIẾP' : 'SONIOX') : (block.pending ? 'ĐANG DỊCH CẢ ĐOẠN' : 'BẢN DỊCH THEO ĐOẠN')}</small><p>{block.translatedText}</p></div>)}</article> })}{model.interimTranscripts.map(item => { const translated = model.translationBlocks.find(block => block.kind === 'live' && block.id === item.id); if (!item.showSource && !translated) return null; return <article key={item.id} className="translation-entry interim"><small>{item.showSource ? 'ĐANG NHẬN DIỆN' : 'ĐANG DỊCH'} · {item.source === 'microphone' ? 'Mic' : 'System'}{item.speaker ? ` · ${item.speaker} (tạm)` : ''}</small>{item.showSource && <p>{item.text}</p>}{translated && <div className="translation-result pending"><small>TIẾNG VIỆT · ĐANG DỊCH TRỰC TIẾP</small><p>{translated.translatedText}</p></div>}</article> })}{!model.entries.length && !model.interimTranscripts.length && <p className="muted">Chưa có lời nói được nhận diện.</p>}</section>
    <LiveAssistant chat={model.liveChat} entries={model.entries} transcript={transcript}/>
  </div></main>
}
