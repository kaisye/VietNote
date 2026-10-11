import { useEffect, useState } from 'react'
import { desktop, type AudioApp } from './desktop'
import { isMac } from './island'

/** Choosing apps for system audio needs per-process taps: macOS only for now. */
export const appChoiceAvailable = desktop.isDesktop && isMac

const STORAGE_KEY = 'excludedAudioApps'
const CHANGED = 'vietnote:excluded-apps'

export function savedExcludedApps(): AudioApp[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((app): app is AudioApp => typeof app?.id === 'string' && typeof app?.name === 'string') : []
  } catch { return [] }
}

/** Saves the left-out apps and applies them, also to a recording already running. */
export function saveExcludedApps(apps: AudioApp[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(apps)) } catch { /* private window */ }
  void desktop.setExcludedApps(apps.map(app => app.id)).catch(() => {})
  window.dispatchEvent(new Event(CHANGED))
}

// Applied once at launch, so a recording started from anywhere already leaves these apps out.
if (appChoiceAvailable) void desktop.setExcludedApps(savedExcludedApps().map(app => app.id)).catch(() => {})

/**
 * The apps playing now (polled while `active`) and the ones left out. The main window and the
 * island share the list through storage, so a change in one shows in the other.
 */
export function useAudioApps(active: boolean) {
  const [playing, setPlaying] = useState<AudioApp[]>([])
  const [excluded, setExcluded] = useState(savedExcludedApps)

  useEffect(() => {
    const reload = () => setExcluded(savedExcludedApps())
    const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) reload() }
    window.addEventListener(CHANGED, reload)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener(CHANGED, reload); window.removeEventListener('storage', onStorage) }
  }, [])

  useEffect(() => {
    if (!active || !appChoiceAvailable) return
    const poll = () => void desktop.audioApps().then(setPlaying).catch(() => {})
    poll()
    const timer = setInterval(poll, 1500)
    return () => clearInterval(timer)
  }, [active])

  const isPlaying = (app: AudioApp) => playing.some(item => item.id === app.id)
  const listening = (app: AudioApp) => !excluded.some(item => item.id === app.id)
  return {
    // Left-out apps stay listed while silent, so they can be turned back on.
    apps: [...playing, ...excluded.filter(app => !isPlaying(app))],
    excluded, isPlaying, listening,
    setListening: (app: AudioApp, listen: boolean) =>
      saveExcludedApps(listen ? excluded.filter(item => item.id !== app.id) : [...excluded.filter(item => item.id !== app.id), app]),
    listenToAll: () => saveExcludedApps([]),
    /** Leaves out every app playing now. */
    leaveOutAll: () => saveExcludedApps([...excluded, ...playing.filter(app => !excluded.some(item => item.id === app.id))]),
  }
}
