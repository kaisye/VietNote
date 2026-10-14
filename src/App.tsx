import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { useAppModel } from './hooks/useAppModel'
import { useIslandBridge } from './hooks/useIslandBridge'
import { HomePage } from './pages/HomePage'
import { NotesPage } from './pages/NotesPage'
import { SettingsPage } from './pages/SettingsPage'
import { TranslatorPage } from './pages/TranslatorPage'
import { FilePage } from './pages/FilePage'
import { WatchPage } from './pages/WatchPage'
import { UpdateBanner } from './components/UpdateBanner'
import type { Page, Theme } from './services/types'

const savedTheme = (): Theme => { try { const value = localStorage.getItem('theme'); return value === 'paper' || value === 'night' || value === 'dark-gradient' || value === 'ocean' ? value : 'light' } catch { return 'light' } }

export default function App() {
  const model = useAppModel()
  const [page, setPage] = useState<Page>('home')
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const toggleTheme = () => setTheme(value => value === 'light' ? 'night' : value === 'night' ? 'dark-gradient' : value === 'dark-gradient' ? 'paper' : value === 'paper' ? 'ocean' : 'light')
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('theme', theme) } catch { /* private window */ } }, [theme])
  const [noteScope, setNoteScope] = useState('all')
  useEffect(() => { if (model.savingNoteID) { setPage('notes'); setNoteScope(model.savingNoteGroupID ?? 'all') } }, [model.savingNoteID]) // eslint-disable-line react-hooks/exhaustive-deps
  // A deleted folder falls back to all notes.
  useEffect(() => { if (noteScope !== 'all' && !model.noteGroups.some(group => group.id === noteScope)) setNoteScope('all') }, [model.noteGroups, noteScope])
  useIslandBridge(model, () => setPage('home'))
  return <div className="app-shell"><Sidebar page={page} setPage={setPage} theme={theme} toggleTheme={toggleTheme} model={model} noteScope={noteScope} setNoteScope={setNoteScope}/><div className="main-stage"><div className="atmosphere"><div className="orb orb-blue"/><div className="orb orb-pink"/><div className="orb orb-lilac"/></div><UpdateBanner busy={model.meetingActive || model.capturing || Boolean(model.savingNoteID)}/><div className="page-stage" key={page}>{page === 'home' ? <HomePage model={model} setPage={setPage}/> : page === 'notes' ? <NotesPage model={model} scope={noteScope}/> : page === 'translate' ? <TranslatorPage model={model}/> : page === 'watch' ? <WatchPage model={model}/> : page === 'file' ? <FilePage model={model} setPage={setPage}/> : <SettingsPage model={model} theme={theme} setTheme={setTheme}/>}</div></div></div>
}
