import { useState } from 'react'
import { BookOpen, Grid2X2, NotebookPen, Settings, Sparkles, AudioLines, ChevronLeft, FileAudio } from 'lucide-react'
import { AccountMenu } from './AccountMenu'
import { BrandIcon } from './BrandIcon'
import type { AppModel } from '../hooks/useAppModel'
import type { Page, Theme } from '../services/types'

const pages: { key: Page; title: string; Icon: typeof Grid2X2 }[] = [
  { key: 'home', title: 'Trang chủ', Icon: Grid2X2 }, { key: 'notes', title: 'Ghi chú', Icon: BookOpen },
  { key: 'translate', title: 'Phiên dịch', Icon: AudioLines }, { key: 'file', title: 'Dịch file · link', Icon: FileAudio }, { key: 'settings', title: 'Cài đặt', Icon: Settings },
]
export function Sidebar({ page, setPage, theme, toggleTheme, model }: { page: Page; setPage: (page: Page) => void; theme: Theme; toggleTheme: () => void; model: AppModel }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebarCollapsed') === 'true' } catch { return false }
  })
  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem('sidebarCollapsed', String(next)) } catch { /* Keep working when storage is unavailable. */ }
  }
  return <aside className={`sidebar glass-sidebar ${collapsed ? 'sidebar-collapsed' : ''}`} aria-label="Thanh điều hướng">
    <div className="brand-row"><div className="brand-icon"><BrandIcon size={38}/></div><div className="brand-copy"><strong>VietNote</strong><small>MEETING INTELLIGENCE</small></div>
      <button className="theme-toggle" onClick={toggleTheme} aria-label={theme === 'paper' ? 'Chuyển sang giao diện Sáng' : 'Chuyển sang giao diện Giấy'} title={theme === 'paper' ? 'Chuyển sang giao diện Sáng' : 'Chuyển sang giao diện Giấy'}>{theme === 'paper' ? <Sparkles size={17}/> : <NotebookPen size={17}/>}</button></div>
    <button className="sidebar-collapse-toggle" onClick={toggleCollapsed} aria-label={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'} title={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'} aria-expanded={!collapsed} aria-controls="workspace-navigation"><ChevronLeft size={15} strokeWidth={2.4}/></button>
    <div className="sidebar-caption">KHÔNG GIAN LÀM VIỆC</div>
    <nav className="sidebar-nav" id="workspace-navigation">{pages.map(({ key, title, Icon }) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-label={title} aria-current={page === key ? 'page' : undefined} title={collapsed && key === 'notes' ? `${title} (${model.notes.length})` : title} onClick={() => setPage(key)}><Icon size={18}/><span>{title}</span>{key === 'notes' && <small>{model.notes.length}</small>}{key === 'file' && ['fetching', 'uploading', 'processing', 'summarizing', 'writing'].includes(model.fileJob.phase) && <i className="nav-busy" aria-label="Đang dịch file"/>}</button>)}</nav>
    <div className="sidebar-spacer"/>
    <AccountMenu model={model} compact={collapsed}/>
  </aside>
}
