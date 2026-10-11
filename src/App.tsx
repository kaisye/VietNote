import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { useAppModel } from './hooks/useAppModel'
import { useIslandBridge } from './hooks/useIslandBridge'
import { HomePage } from './pages/HomePage'
import { NotesPage } from './pages/NotesPage'
import { SettingsPage } from './pages/SettingsPage'
import { TranslatorPage } from './pages/TranslatorPage'
import { FilePage } from './pages/FilePage'
import { UpdateBanner } from './components/UpdateBanner'
import type { Page, Theme } from './services/types'

const savedTheme = (): Theme => { try { return localStorage.getItem('theme') === 'paper' ? 'paper' : 'light' } catch { return 'light' } }

export default function App() {
  const model = useAppModel()
  const [page, setPage] = useState<Page>('home')
  const [theme, setTheme] = useState<Theme>(savedTheme)
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('theme', theme) } catch { /* private window */ } }, [theme])
  useEffect(() => { if (model.savingNoteID) setPage('notes') }, [model.savingNoteID])
  useIslandBridge(model, () => setPage('home'))
  return <div className="app-shell"><Sidebar page={page} setPage={setPage} theme={theme} toggleTheme={() => setTheme(theme === 'paper' ? 'light' : 'paper')} model={model}/><div className="main-stage"><div className="atmosphere"><div className="orb orb-blue"/><div className="orb orb-pink"/><div className="orb orb-lilac"/></div><UpdateBanner busy={model.meetingActive || model.capturing || Boolean(model.savingNoteID)}/><div className="page-stage" key={page}>{page === 'home' ? <HomePage model={model}/> : page === 'notes' ? <NotesPage model={model}/> : page === 'translate' ? <TranslatorPage model={model}/> : page === 'file' ? <FilePage model={model} setPage={setPage}/> : <SettingsPage theme={theme} setTheme={setTheme}/>}</div></div></div>
}
