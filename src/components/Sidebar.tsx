import { useState } from 'react'
import { BookOpen, Grid2X2, MoonStar, Settings, Sun, AudioLines, ChevronLeft, FileAudio } from 'lucide-react'
import { AccountMenu } from './AccountMenu'
import type { AppModel } from '../hooks/useAppModel'
import type { Page } from '../services/types'

const pages: { key: Page; title: string; Icon: typeof Grid2X2 }[] = [
  { key: 'home', title: 'Trang chủ', Icon: Grid2X2 }, { key: 'notes', title: 'Ghi chú', Icon: BookOpen },
  { key: 'translate', title: 'Phiên dịch', Icon: AudioLines }, { key: 'file', title: 'Dịch file', Icon: FileAudio }, { key: 'settings', title: 'Cài đặt', Icon: Settings },
]
export function Sidebar({ page, setPage, dark, toggleTheme, model }: { page: Page; setPage: (page: Page) => void; dark: boolean; toggleTheme: () => void; model: AppModel }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebarCollapsed') === 'true' } catch { return false }
  })
  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem('sidebarCollapsed', String(next)) } catch { /* Keep working when storage is unavailable. */ }
  }
  return <aside className={`sidebar glass-sidebar ${collapsed ? 'sidebar-collapsed' : ''}`} aria-label="Thanh điều hướng">
    <div className="brand-row"><div className="brand-icon"><svg viewBox="0 0 512 512" width="38" height="38" aria-hidden="true"><rect width="512" height="512" rx="96" fill="#526ADE"/><g transform="translate(10 66) scale(1.1)"><path fill="#FFFFFF" d="M80 80 168 32V280L80 232Z"/><path fill="#D4CEFA" d="M168 168 280 104 368 152 280 216 168 280Z"/><path fill="#F4F2FF" d="M280 216 368 152V272L280 320Z"/></g></svg></div><div className="brand-copy"><strong>VietNote</strong><small>MEETING INTELLIGENCE</small></div>
      <button className="theme-toggle" onClick={toggleTheme} aria-label={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'} title={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}>{dark ? <Sun size={17}/> : <MoonStar size={17}/>}</button></div>
    <button className="sidebar-collapse-toggle" onClick={toggleCollapsed} aria-label={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'} title={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'} aria-expanded={!collapsed} aria-controls="workspace-navigation"><ChevronLeft size={15} strokeWidth={2.4}/></button>
    <div className="sidebar-caption">KHÔNG GIAN LÀM VIỆC</div>
    <nav className="sidebar-nav" id="workspace-navigation">{pages.map(({ key, title, Icon }) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-label={title} aria-current={page === key ? 'page' : undefined} title={collapsed && key === 'notes' ? `${title} (${model.notes.length})` : title} onClick={() => setPage(key)}><Icon size={18}/><span>{title}</span>{key === 'notes' && <small>{model.notes.length}</small>}{key === 'file' && ['uploading', 'processing', 'summarizing'].includes(model.fileJob.phase) && <i className="nav-busy" aria-label="Đang dịch file"/>}</button>)}</nav>
    <div className="sidebar-spacer"/>
    <AccountMenu model={model} compact={collapsed}/>
  </aside>
}
