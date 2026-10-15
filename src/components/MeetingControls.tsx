import { Languages, MicOff, Settings2, SlidersHorizontal, TriangleAlert, Volume2 } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { AudioInput, Language } from '../services/types'
import { Choice, type ChoiceOption } from './Choice'
import { desktop } from '../services/desktop'
import { isMac } from '../services/island'
import { saveExcludedApps } from '../services/audioApps'

export const audioOptions: ChoiceOption<AudioInput>[] = [{ value: 'system', label: 'Âm thanh máy' }, { value: 'microphone', label: 'Micro' }, { value: 'both', label: 'Micro + âm thanh máy' }]
export const languageOptions: ChoiceOption<Language>[] = [{ value: 'auto', label: 'Tự động nhận diện → Tiếng Việt' }, { value: 'vi', label: 'Tiếng Việt' }, { value: 'en', label: 'Tiếng Anh → Tiếng Việt' }, { value: 'zh', label: 'Tiếng Trung → Tiếng Việt' }]

/** Compact native input meter, embedded under a source button's label. */
export function AudioLevelBar({ level }: { level: number }) {
  const normalized = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(level, 1e-6)) + 60) / 60))
  return <span className="source-level" aria-hidden="true"><i style={{ transform: `scaleX(${normalized})` }}/></span>
}

export function TranslateSwitch({ model }: { model: AppModel }) {
  return <span className="translate-switch"><input type="checkbox" role="switch" aria-label="Dịch tiếng nước ngoài sang tiếng Việt" checked={model.translateForeign} onChange={e => model.setTranslateForeign(e.target.checked)}/><span aria-hidden="true"/></span>
}

export function MicrophoneToggle({ model }: { model: AppModel }) {
  return <button type="button" className={`source-toggle ${model.microphoneOn ? 'on' : ''}`} onClick={model.toggleMicrophone} aria-pressed={model.microphoneOn} title={model.microphoneOn ? 'Tắt thu giọng nói từ micro' : 'Bật thu giọng nói từ micro'}><span className="source-toggle-copy"><strong>Micro</strong><AudioLevelBar level={model.microphoneOn ? model.audioLevels.microphone : 0}/></span></button>
}

/** The microphone opened but hears nothing at all: point to where the system lets the app use it. */
export function MicrophoneSilentNotice({ model }: { model: AppModel }) {
  if (!model.microphoneSilent) return null
  return <div className="mic-silent-notice" role="alert"><MicOff size={18}/>
    <div><strong>Micro không thu được tiếng nào</strong>
      {isMac
        ? <p>macOS có thể đang chặn micro. Mở Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Micro và bật VietNote. Nếu đã bật, kiểm tra micro đầu vào trong mục Âm thanh.</p>
        : <p>Windows có thể đang chặn micro. Trong trang cài đặt micro, bật <b>Microphone access</b> và <b>Let desktop apps access your microphone</b> (Truy cập micro, Cho ứng dụng máy tính dùng micro). Nếu đã bật, kiểm tra micro mặc định trong Settings → System → Sound → Input.</p>}
    </div>
    <button type="button" className="pill-btn" onClick={() => void desktop.openPermission('microphone').catch(() => {})}><Settings2 size={15}/>Mở cài đặt micro</button>
  </div>
}

/** The native system-audio stream opened but is silent, or stopped after opening. */
export function SystemAudioNotice({ model }: { model: AppModel }) {
  if (!model.systemAudioIssue) return null
  const guidance = isMac
    ? 'Trong macOS, hãy bật VietNote tại Quyền riêng tư & Bảo mật → Ghi màn hình & âm thanh hệ thống, rồi mở lại ứng dụng.'
    : 'Trong Windows, hãy kiểm tra thiết bị đầu ra mặc định và thử phát âm thanh không được bảo vệ.'
  const message = `${model.systemAudioIssue} ${guidance}`
  return <details className="audio-warning-disclosure">
    <summary className="audio-warning-trigger" aria-label="Xem cảnh báo âm thanh máy" title="Không nhận được âm thanh máy"><TriangleAlert size={19}/></summary>
    <div className="mic-silent-notice system-audio-detail" role="alert">
      <div><strong>Không nhận được âm thanh máy</strong>
        <p title={message}>{message}</p>
      </div>
      <div className="audio-notice-actions">
        {isMac && <button type="button" className="pill-btn" onClick={() => saveExcludedApps([])}><Volume2 size={15}/>Nghe tất cả ứng dụng</button>}
        <button type="button" className="pill-btn" onClick={() => void desktop.openPermission('screen').catch(() => {})}><Settings2 size={15}/>{isMac ? 'Mở quyền hệ thống' : 'Mở cài đặt âm thanh'}</button>
      </div>
    </div>
  </details>
}

export function SystemAudioToggle({ model }: { model: AppModel }) {
  return <button type="button" className={`source-toggle ${model.systemAudioOn ? 'on' : ''}`} onClick={model.toggleSystemAudio} aria-pressed={model.systemAudioOn} title={model.systemAudioOn ? 'Tắt thu âm thanh phát từ loa' : 'Bật thu âm thanh phát từ loa'}><span className="source-toggle-copy"><strong>Âm thanh máy</strong><AudioLevelBar level={model.systemAudioOn ? model.audioLevels.system : 0}/></span></button>
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
