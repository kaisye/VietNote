import { useState } from 'react'
import { emitTo } from '@tauri-apps/api/event'
import { Palette, PanelTop } from 'lucide-react'
import type { Theme } from '../services/types'
import type { AppModel } from '../hooks/useAppModel'
import { MeetingControls } from '../components/MeetingControls'
import { islandEnabled, islandEvents, isMac, saveIslandEnabled, shortcutLabel } from '../services/island'


const themes: { key: Theme; label: string; hint: string }[] = [
  { key: 'light', label: 'Sáng', hint: 'Nền trắng hồng, ánh xanh băng và kính lavender.' },
  { key: 'night', label: 'Tối', hint: 'Đêm chàm tím, ánh xanh hồng, kính mờ, điểm nhấn xanh dương.' },
  { key: 'dark-gradient', label: 'Vũ trụ', hint: 'Không gian vũ trụ: tinh vân, sao và thiên thạch.' },
  { key: 'paper', label: 'Giấy', hint: 'Giấy ngà chấm lưới, chữ màu mực.' },
  { key: 'ocean', label: 'Đại dương', hint: 'Nước biển ngọc, kính mờ và điểm nhấn san hô.' },
]

export function SettingsPage({ model, theme, setTheme }: { model: AppModel; theme: Theme; setTheme: (value: Theme) => void }) {
  const [island, setIsland] = useState(islandEnabled)
  const toggleIsland = (enabled: boolean) => {
    setIsland(enabled)
    saveIslandEnabled(enabled)
    void emitTo('island', islandEvents.enabled, enabled).catch(() => {})
  }
  return <main className="page-scroll"><div className="page-wrap settings-wrap animate-in">
    <div className="eyebrow">SYSTEM</div>
    <h1>Cài đặt & trạng thái</h1>
    <p className="page-subtitle">Tùy chỉnh VietNote theo cách bạn muốn sử dụng.</p>


    {/* Recording options for meetings started from the main window. */}
    <MeetingControls model={model}/>

    <section className="glass-card settings-card">
      <div className="settings-heading"><Palette size={19}/><h3>Giao diện</h3></div>
      <div className="segmented appearance-picker">{themes.map(item => <button key={item.key} className={theme === item.key ? 'selected' : ''} onClick={() => setTheme(item.key)}>{item.label}</button>)}</div>
      <small className="muted">{themes.find(item => item.key === theme)!.hint}</small>
    </section>

    <section className="glass-card settings-card">
      <div className="settings-heading"><PanelTop size={19}/><h3>VietNote Island</h3><small>{shortcutLabel} để hỏi</small></div>
      <label className="translation-mode-note"><strong>{isMac ? 'Hiện island ở notch' : 'Hiện island'}</strong><span>Xem bản ghi, bản dịch và hỏi đáp ngay trên mọi ứng dụng, kể cả khi xem video toàn màn hình. Kéo island tới góc hoặc cạnh màn hình; nhấp đúp để đưa về {isMac ? 'notch' : 'giữa cạnh trên'}.</span><span className="translate-switch"><input type="checkbox" role="switch" aria-label="Hiện VietNote Island" checked={island} onChange={event => toggleIsland(event.target.checked)}/><span aria-hidden="true"/></span></label>
    </section>
  </div></main>
}
