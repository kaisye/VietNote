import { Circle } from 'lucide-react'
import type { Appearance } from '../services/types'


export function SettingsPage({ appearance, setAppearance }: { appearance: Appearance; setAppearance: (value: Appearance) => void }) {
  return <main className="page-scroll"><div className="page-wrap settings-wrap animate-in">
    <div className="eyebrow">SYSTEM</div>
    <h1>Cài đặt & trạng thái</h1>
    <p className="page-subtitle">Tùy chỉnh VietNote theo cách bạn muốn sử dụng.</p>

    <section className="glass-card settings-card">
      <div className="settings-heading"><Circle size={19}/><h3>Giao diện</h3><small>Liquid Glass</small></div>
      <div className="segmented appearance-picker">{([['system','Hệ thống'], ['light','Sáng'], ['dark','Tối']] as const).map(([key, label]) => <button key={key} className={appearance === key ? 'selected' : ''} onClick={() => setAppearance(key)}>{label}</button>)}</div>
      <small className="muted">{appearance === 'system' ? 'Tự động theo giao diện hệ thống.' : appearance === 'light' ? 'Nền trắng hồng, ánh xanh băng và kính lavender.' : 'Nền tím đêm, ánh lavender và hồng phấn.'}</small>
    </section>


  </div></main>
}
