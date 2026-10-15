import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder, FolderOpen, Layers, MoreHorizontal, Plus } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'

/** The note folders in the sidebar: picking one opens Notes filtered to it. */
export function NoteFolders({ model, scope, active, collapsed, onOpen }: { model: AppModel; scope: string; active: boolean; collapsed: boolean; onOpen: (scope: string) => void }) {
  // Fixed-position so the sidebar's scroll does not clip it.
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null)
  const [dialog, setDialog] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [dialogID, setDialogID] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('.group-popover, .folder-menu-button'))) setMenu(null) }
    const dismiss = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', dismiss)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', dismiss) }
  }, [menu])

  const open = (kind: typeof dialog, id: string | null = null, name = '') => { setDialog(kind); setDialogID(id); setValue(name); setError(''); setMenu(null) }
  const submit = () => {
    if (dialog === 'create') { const id = model.createGroup(value); if (!id) { setError('Tên thư mục không được trống hoặc trùng.'); return } onOpen(id) }
    if (dialog === 'rename' && dialogID && !model.renameGroup(dialogID, value)) { setError('Tên thư mục không được trống hoặc trùng.'); return }
    if (dialog === 'delete' && dialogID) { model.deleteGroup(dialogID); if (scope === dialogID) onOpen('all') }
    setDialog(null)
  }
  const count = (id: string) => model.notes.filter(note => note.groupID === id).length

  return <>
    <div className="sidebar-caption folder-caption"><span>THƯ MỤC</span><button className="folder-add" aria-label="Tạo thư mục" title="Tạo thư mục" onClick={() => open('create')}><Plus size={14}/></button></div>
    <div className="sidebar-folders" onScroll={() => setMenu(null)}>
      <button className={`nav-item folder-item ${active && scope === 'all' ? 'active' : ''}`} title={collapsed ? `Tất cả (${model.notes.length})` : 'Tất cả ghi chú'} onClick={() => onOpen('all')}><Layers size={17}/><span>Tất cả</span><small>{model.notes.length}</small></button>
      {model.noteGroups.map(group => {
        const selected = active && scope === group.id
        const Icon = selected ? FolderOpen : Folder
        return <div className={`folder-row ${menu?.id === group.id ? 'menu-open' : ''}`} key={group.id}>
          <button className={`nav-item folder-item ${selected ? 'active' : ''}`} title={collapsed ? `${group.name} (${count(group.id)})` : group.name} onClick={() => onOpen(group.id)}><Icon size={17}/><span>{group.name}</span><small>{count(group.id)}</small></button>
          {!collapsed && <button className="folder-menu-button" aria-label={`Tùy chọn thư mục ${group.name}`} aria-expanded={menu?.id === group.id} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(menu?.id === group.id ? null : { id: group.id, left: rect.left, top: rect.bottom + 6 }) }}><MoreHorizontal size={15}/></button>}
        </div>
      })}
      {collapsed && <button className="nav-item folder-item" title="Tạo thư mục" aria-label="Tạo thư mục" onClick={() => open('create')}><Plus size={17}/><span>Thư mục mới</span></button>}
    </div>
    {menu && createPortal(<div className="group-popover" role="menu" style={{ left: menu.left, top: menu.top }}><button role="menuitem" onClick={() => open('rename', menu.id, model.noteGroups.find(group => group.id === menu.id)?.name ?? '')}>Đổi tên</button><button role="menuitem" className="danger" onClick={() => open('delete', menu.id)}>Xóa thư mục</button></div>, document.body)}
    {dialog && createPortal(<div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null) }}><form className="app-dialog" role="dialog" aria-modal="true" aria-label={dialog === 'create' ? 'Tạo thư mục' : dialog === 'rename' ? 'Đổi tên' : 'Xóa thư mục'} onSubmit={event => { event.preventDefault(); submit() }}><h2>{dialog === 'create' ? 'Tạo thư mục ghi chú' : dialog === 'rename' ? 'Đổi tên thư mục' : 'Xóa thư mục?'}</h2>{dialog === 'delete' ? <p>Ghi chú trong thư mục vẫn còn ở Tất cả.</p> : <label className="field"><span>TÊN THƯ MỤC</span><input autoFocus value={value} onChange={event => setValue(event.target.value)} required/></label>}{error && <p className="dialog-error">{error}</p>}<div className="dialog-actions"><button type="button" className="pill-btn" onClick={() => setDialog(null)}>Hủy</button><button type="submit" className="pill-btn primary">{dialog === 'delete' ? 'Xóa' : 'Lưu'}</button></div></form></div>, document.body)}
  </>
}
