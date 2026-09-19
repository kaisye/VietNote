import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { useAppModel } from './hooks/useAppModel'
import { HomePage } from './pages/HomePage'
import { NotesPage } from './pages/NotesPage'
import { SettingsPage } from './pages/SettingsPage'
import { TranslatorPage } from './pages/TranslatorPage'
import type { Appearance, Page } from './services/types'

export default function App() {
  const model = useAppModel()
  const [page, setPage] = useState<Page>('home')
  const [appearance, setAppearance] = useState<Appearance>(() => (localStorage.getItem('appearanceMode') as Appearance) || 'dark')
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches)
  const dark = appearance === 'dark' || (appearance === 'system' && systemDark)
  useEffect(() => { const query = matchMedia('(prefers-color-scheme: dark)'); const listener = () => setSystemDark(query.matches); query.addEventListener('change', listener); return () => query.removeEventListener('change', listener) }, [])
  useEffect(() => { localStorage.setItem('appearanceMode', appearance); document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [appearance, dark])
  useEffect(() => { if (model.savingNoteID) setPage('notes') }, [model.savingNoteID])
  return <div className="app-shell"><Sidebar page={page} setPage={setPage} dark={dark} toggleTheme={() => setAppearance(dark ? 'light' : 'dark')} model={model}/><div className="main-stage"><div className="atmosphere"><div className="orb orb-blue"/><div className="orb orb-pink"/><div className="orb orb-lilac"/></div><div className="page-stage" key={page}>{page === 'home' ? <HomePage model={model}/> : page === 'notes' ? <NotesPage model={model}/> : page === 'translate' ? <TranslatorPage model={model}/> : <SettingsPage model={model} appearance={appearance} setAppearance={setAppearance}/>}</div></div></div>
}
