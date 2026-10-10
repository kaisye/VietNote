import { useState } from 'react'
import { emitTo } from '@tauri-apps/api/event'
import { Circle, PanelTop } from 'lucide-react'
import { islandEnabled, islandEvents, isMac, saveIslandEnabled, shortcutLabel } from '../services/island'
import type { Appearance } from '../services/types'


export function SettingsPage({ appearance, setAppearance }: { appearance: Appearance; setAppearance: (value: Appearance) => void }) {
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

    <section className="glass-card settings-card">
      <div className="settings-heading"><Circle size={19}/><h3>Giao diện</h3><small>Liquid Glass</small></div>
      <div className="segmented appearance-picker">{([['system','Hệ thống'], ['light','Sáng'], ['dark','Tối']] as const).map(([key, label]) => <button key={key} className={appearance === key ? 'selected' : ''} onClick={() => setAppearance(key)}>{label}</button>)}</div>
      <small className="muted">{appearance === 'system' ? 'Tự động theo giao diện hệ thống.' : appearance === 'light' ? 'Nền trắng hồng, ánh xanh băng và kính lavender.' : 'Nền tím đêm, ánh lavender và hồng phấn.'}</small>
    </section>

    <section className="glass-card settings-card">
      <div className="settings-heading"><PanelTop size={19}/><h3>VietNote Island</h3><small>{shortcutLabel} để hỏi</small></div>
      <label className="translation-mode-note"><strong>{isMac ? 'Hiện island ở notch' : 'Hiện island'}</strong><span>Xem bản ghi, bản dịch và hỏi đáp ngay trên mọi ứng dụng, kể cả khi xem video toàn màn hình. Kéo island tới góc hoặc cạnh màn hình; nhấp đúp để đưa về {isMac ? 'notch' : 'giữa cạnh trên'}.</span><span className="translate-switch"><input type="checkbox" role="switch" aria-label="Hiện VietNote Island" checked={island} onChange={event => toggleIsland(event.target.checked)}/><span aria-hidden="true"/></span></label>
    </section>
  </div></main>
}
