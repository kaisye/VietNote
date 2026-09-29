import { ChevronDown, Languages, SlidersHorizontal, Volume2 } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { AudioInput, Language } from '../services/types'

export function TranslateSwitch({ model }: { model: AppModel }) {
  return <span className="translate-switch"><input type="checkbox" role="switch" aria-label="Dịch tiếng nước ngoài sang tiếng Việt" checked={model.translateForeign} onChange={e => model.setTranslateForeign(e.target.checked)}/><span aria-hidden="true"/></span>
}

export function MeetingControls({ model }: { model: AppModel }) {
  return <section className="glass-card strong meeting-controls">
    <div className="controls-title"><SlidersHorizontal size={17}/><strong>Thiết lập phiên họp</strong><span>Chọn trước khi bắt đầu</span></div>
    <div className="control-grid"><label className="field"><span>NGUỒN ÂM THANH</span><div className="meeting-choice"><Volume2 size={17}/><select value={model.audioInput} onChange={e => model.setAudioInput(e.target.value as AudioInput)} disabled={model.capturing || model.busy}><option value="system">Âm thanh máy</option><option value="microphone">Micro</option><option value="both">Micro + âm thanh máy</option></select><ChevronDown size={17}/></div></label>
      <label className="field"><span>NGÔN NGỮ CUỘC HỌP</span><div className="meeting-choice"><Languages size={17}/><select value={model.sourceLanguage} onChange={e => model.setSourceLanguage(e.target.value as Language)} disabled={model.capturing || model.busy}><option value="auto">Tự động nhận diện → Tiếng Việt</option><option value="vi">Tiếng Việt</option><option value="en">Tiếng Anh → Tiếng Việt</option><option value="zh">Tiếng Trung → Tiếng Việt</option></select><ChevronDown size={17}/></div></label></div>
    {model.sourceLanguage !== 'vi' && <label className="translation-mode-note"><strong>Dịch sang tiếng Việt</strong><span>{model.translateForeign ? 'Gom ngữ cảnh, chuẩn hóa lỗi nhận diện rồi mới dịch bằng tiếng Việt.' : 'Chỉ ghi lại lời nói gốc; tiếng nước ngoài không được dịch.'}</span><TranslateSwitch model={model}/></label>}
    <div className="divider"/>
    <div className="cadence-row"><div><strong>Nhịp cập nhật tóm tắt</strong><small>Lần đầu: ngay sau đoạn nhận diện đầu tiên.</small></div><div className="row-spacer"/>
      <div className="segmented" role="group" aria-label="Nhịp tóm tắt"><button className={model.summaryCadence === 'minutes' ? 'selected' : ''} onClick={() => model.setSummaryCadence('minutes')} disabled={model.capturing || model.busy}>Phút</button><button className={model.summaryCadence === 'words' ? 'selected' : ''} onClick={() => model.setSummaryCadence('words')} disabled={model.capturing || model.busy}>Số từ</button></div>
      <div className="meeting-choice cadence-value"><select value={model.cadenceValue} onChange={e => model.setCadenceValue(Number(e.target.value))} disabled={model.capturing || model.busy} aria-label="Khoảng cập nhật">{(model.summaryCadence === 'words' ? [30, 60, 120, 200] : [1, 2, 5, 10]).map(value => <option key={value} value={value}>{value} {model.summaryCadence === 'words' ? 'từ' : 'phút'}</option>)}</select><ChevronDown size={17}/></div></div>
  </section>
}
