import { Languages, Mic, MicOff, SlidersHorizontal, Volume2 } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { AudioInput, Language } from '../services/types'
import { Choice, type ChoiceOption } from './Choice'

export const audioOptions: ChoiceOption<AudioInput>[] = [{ value: 'system', label: 'Âm thanh máy' }, { value: 'microphone', label: 'Micro' }, { value: 'both', label: 'Micro + âm thanh máy' }]
export const languageOptions: ChoiceOption<Language>[] = [{ value: 'auto', label: 'Tự động nhận diện → Tiếng Việt' }, { value: 'vi', label: 'Tiếng Việt' }, { value: 'en', label: 'Tiếng Anh → Tiếng Việt' }, { value: 'zh', label: 'Tiếng Trung → Tiếng Việt' }]

export function TranslateSwitch({ model }: { model: AppModel }) {
  return <span className="translate-switch"><input type="checkbox" role="switch" aria-label="Dịch tiếng nước ngoài sang tiếng Việt" checked={model.translateForeign} onChange={e => model.setTranslateForeign(e.target.checked)}/><span aria-hidden="true"/></span>
}

export function MicrophoneToggle({ model }: { model: AppModel }) {
  const label = model.microphoneOn ? 'Tắt micro' : 'Bật micro'
  return <button type="button" className={`pill-btn mic-toggle ${model.microphoneOn ? 'on' : ''}`} onClick={model.toggleMicrophone} aria-pressed={model.microphoneOn} title={model.microphoneOn ? 'Tắt thu giọng nói từ micro' : 'Bật thu giọng nói từ micro'}>{model.microphoneOn ? <Mic size={16}/> : <MicOff size={16}/>}{label}</button>
}

export function MeetingControls({ model }: { model: AppModel }) {
  return <section className="glass-card strong meeting-controls">
    <div className="controls-title"><SlidersHorizontal size={17}/><strong>Thiết lập phiên họp</strong><span>Chọn trước khi bắt đầu</span></div>
    <div className="control-grid"><label className="field"><span>NGUỒN ÂM THANH</span><Choice icon={<Volume2 size={17}/>} label="Nguồn âm thanh" value={model.audioInput} onChange={value => model.setAudioInput(value)} disabled={model.capturing || model.busy} options={audioOptions}/></label>
      <label className="field"><span>NGÔN NGỮ CUỘC HỌP</span><Choice icon={<Languages size={17}/>} label="Ngôn ngữ" value={model.sourceLanguage} onChange={value => model.setSourceLanguage(value)} disabled={model.capturing || model.busy} options={languageOptions}/></label></div>
    {model.sourceLanguage !== 'vi' && <label className="translation-mode-note"><strong>Dịch sang tiếng Việt</strong><span>{model.translateForeign ? 'Gom ngữ cảnh, chuẩn hóa lỗi nhận diện rồi mới dịch bằng tiếng Việt.' : 'Chỉ ghi lại lời nói gốc; tiếng nước ngoài không được dịch.'}</span><TranslateSwitch model={model}/></label>}
    <div className="divider"/>
    <div className="cadence-row"><div><strong>Nhịp cập nhật tóm tắt</strong><small>Lần đầu: ngay sau đoạn nhận diện đầu tiên.</small></div><div className="row-spacer"/>
      <div className="segmented" role="group" aria-label="Nhịp tóm tắt"><button className={model.summaryCadence === 'minutes' ? 'selected' : ''} onClick={() => model.setSummaryCadence('minutes')} disabled={model.capturing || model.busy}>Phút</button><button className={model.summaryCadence === 'words' ? 'selected' : ''} onClick={() => model.setSummaryCadence('words')} disabled={model.capturing || model.busy}>Số từ</button></div>
      <Choice className="cadence-value" label="Khoảng cập nhật" value={model.cadenceValue} onChange={value => model.setCadenceValue(value)} disabled={model.capturing || model.busy} options={(model.summaryCadence === 'words' ? [60, 100, 150, 200, 300] : [1, 2, 5, 10]).map(value => ({ value, label: `${value} ${model.summaryCadence === 'words' ? 'từ' : 'phút'}` }))}/></div>
  </section>
}
