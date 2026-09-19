import { useEffect, useState } from 'react'
import { AudioLines, Check, ChevronDown, Gauge, Languages, Square, Volume2 } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { AudioInput, Language } from '../services/types'
import { formatTime } from '../services/notes'
import { desktop, type TtsVoiceConfig, type TtsVoiceId } from '../services/desktop'

const BUILT_IN_VOICES: TtsVoiceConfig = {
  selectedId: 'thuc-day-di',
  voices: [
    { id: 'thuc-day-di', displayName: 'Giọng Nam', description: 'Trung niên' },
    { id: 'ngoc-huyen', displayName: 'Giọng Nữ', description: 'Kể truyện · review phim' },
  ],
}

export function TranslatorPage({ model }: { model: AppModel }) {
  const [voiceConfig, setVoiceConfig] = useState<TtsVoiceConfig>(BUILT_IN_VOICES)
  const [changingVoice, setChangingVoice] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState('')

  useEffect(() => {
    if (!desktop.isDesktop) return
    let active = true
    void desktop.getTtsVoiceConfig()
      .then(config => { if (active) setVoiceConfig(config) })
      .catch(error => { if (active) setVoiceMessage(`Không đọc được danh sách giọng: ${error}`) })
    return () => { active = false }
  }, [])

  const selectVoice = async (voiceId: TtsVoiceId) => {
    if (voiceId === voiceConfig.selectedId) return
    setChangingVoice(true)
    setVoiceMessage('Đang tải giọng đọc…')
    try {
      const next = await desktop.setTtsVoice(voiceId)
      setVoiceConfig(next)
      const selected = next.voices.find(voice => voice.id === next.selectedId)
      setVoiceMessage(`Đã chuyển sang ${selected?.displayName ?? 'giọng mới'}.`)
    } catch (error) {
      setVoiceMessage(`Không đổi được giọng: ${error}`)
    } finally {
      setChangingVoice(false)
    }
  }

  return <main className="page-scroll"><div className="page-wrap narrow animate-in"><div className="eyebrow">REAL-TIME INTERPRETER</div><h1>Phiên dịch trực tiếp</h1><p className="page-subtitle">Nhận diện tiếng Anh, tiếng Trung hoặc tiếng Việt từ microphone và âm thanh hệ thống.</p>
    <section className="glass-card translator-controls"><div className="select-row"><label className="field"><span>NGÔN NGỮ</span><div className="meeting-choice"><Languages size={17}/><select value={model.sourceLanguage} onChange={e => model.setSourceLanguage(e.target.value as Language)} disabled={model.capturing || model.busy}><option value="vi">Tiếng Việt</option><option value="en">Tiếng Anh → Tiếng Việt</option><option value="zh">Tiếng Trung → Tiếng Việt</option></select><ChevronDown size={17}/></div></label><label className="field"><span>ÂM THANH</span><div className="meeting-choice"><Volume2 size={17}/><select value={model.audioInput} onChange={e => model.setAudioInput(e.target.value as AudioInput)} disabled={model.capturing || model.busy}><option value="system">Âm thanh máy</option><option value="microphone">Micro</option><option value="both">Micro + âm thanh máy</option></select><ChevronDown size={17}/></div></label></div>
      {model.sourceLanguage !== 'vi' && <div className={`translator-speech-panel${model.speechEnabled ? ' enabled' : ''}`}>
        <div className="translator-speech-header">
          <label className="speech-master-toggle">
            <input type="checkbox" checked={model.speechEnabled} onChange={e => model.setSpeechEnabled(e.target.checked)}/>
            <span className="speech-toggle-icon"><Volume2 size={19}/></span>
            <span className="speech-toggle-copy"><strong>Đọc bản dịch</strong><small>Phát giọng đọc tiếng Việt sau mỗi đoạn dịch</small></span>
          </label>
          <label className="speed-select"><span>TỐC ĐỘ</span><div className="meeting-choice"><Gauge size={17}/><select value={model.speechRate} onChange={e => model.setSpeechRate(Number(e.target.value))} disabled={!model.speechEnabled}>{[1, 1.15, 1.25, 1.4, 1.5].map(rate => <option key={rate} value={rate}>{rate === 1 ? '1.0' : rate}×</option>)}</select><ChevronDown size={17}/></div></label>
        </div>
        {model.speechEnabled && <div className="translator-voice-options" role="radiogroup" aria-label="Chọn giọng đọc bản dịch">
          {voiceConfig.voices.map(voice => {
            const selected = voice.id === voiceConfig.selectedId
            return <button key={voice.id} type="button" role="radio" aria-checked={selected} className={`translator-voice-option${selected ? ' selected' : ''}`} disabled={!desktop.isDesktop || model.capturing || model.busy || changingVoice} onClick={() => void selectVoice(voice.id)}>
              <span className="voice-option-icon"><Volume2 size={18}/></span>
              <span className="voice-option-copy"><strong>{voice.displayName}</strong><small>{voice.description}</small></span>
              <span className="voice-option-check" aria-hidden="true">{selected && <Check size={16}/>}</span>
            </button>
          })}
        </div>}
        {voiceMessage && <small role="status" className="translator-voice-message">{voiceMessage}</small>}
      </div>}
      <div className="action-row"><small>{model.status}</small><div className="row-spacer"/>{model.capturing ? <button className="pill-btn primary" onClick={() => void model.stop()}><Square size={14} fill="currentColor"/>Dừng</button> : <button className="pill-btn primary" onClick={() => void model.start()} disabled={!model.ready || model.busy}><AudioLines size={16}/>Bắt đầu</button>}</div></section>
    <section className="glass-card strong transcript-list"><h3>Bản ghi</h3>{model.entries.length ? model.entries.map(entry => { const block = model.translationBlocks.find(item => item.entryIds.at(-1) === entry.id); return <article key={entry.id} className="translation-entry"><small>{formatTime(entry.timestamp, false)}</small><p>{entry.sourceText}</p>{block && <div className={`translation-result ${block.pending ? 'pending' : ''}`}><small>TIẾNG VIỆT · DỊCH THEO ĐOẠN</small><p>{block.translatedText}</p></div>}</article> }) : <p className="muted">Chưa có lời nói được nhận diện.</p>}</section>
  </div></main>
}
