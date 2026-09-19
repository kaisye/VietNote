import { BookOpen, Grid2X2, MoonStar, Settings, Sun, AudioLines } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Page } from '../services/types'
import { AnimatedWaveform } from './AnimatedWaveform'

const pages: { key: Page; title: string; Icon: typeof Grid2X2 }[] = [
  { key: 'home', title: 'Trang chủ', Icon: Grid2X2 }, { key: 'notes', title: 'Ghi chú', Icon: BookOpen },
  { key: 'translate', title: 'Phiên dịch', Icon: AudioLines }, { key: 'settings', title: 'Cài đặt', Icon: Settings },
]
export function Sidebar({ page, setPage, dark, toggleTheme, model }: { page: Page; setPage: (page: Page) => void; dark: boolean; toggleTheme: () => void; model: AppModel }) {
  return <aside className="sidebar glass-sidebar">
    <div className="brand-row"><div className="brand-icon"><AnimatedWaveform compact/></div><div className="brand-copy"><strong>VietNote</strong><small>MEETING INTELLIGENCE</small></div>
      <button className="theme-toggle" onClick={toggleTheme} aria-label={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'} title={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}>{dark ? <Sun size={17}/> : <MoonStar size={17}/>}</button></div>
    <div className="sidebar-caption">KHÔNG GIAN LÀM VIỆC</div>
    <nav className="sidebar-nav">{pages.map(({ key, title, Icon }) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => setPage(key)}><Icon size={18}/><span>{title}</span>{key === 'notes' && <small>{model.notes.length}</small>}</button>)}</nav>
    <div className="sidebar-spacer"/>
    <div className="worker-badge"><div><span className={`status-dot ${model.ready ? 'ready' : ''}`}/><strong>{model.ready ? 'Sẵn sàng' : 'Đang khởi động'}</strong></div><small>VietNote</small></div>
  </aside>
}
