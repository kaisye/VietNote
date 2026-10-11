import type { AudioApp } from '../services/desktop'
import type { useAudioApps } from '../services/audioApps'

/** The source menu's app choice: which apps system audio listens to. A whole row toggles. */
export function AppList({ audio }: { audio: ReturnType<typeof useAudioApps> }) {
  const row = (key: string, title: string, detail: string, checked: boolean, onChange: (checked: boolean) => void, app?: AudioApp) =>
    <label key={key} className="menu-app">
      <span><b>{title}</b><small>{detail}</small></span>
      <span className="island-switch"><input type="checkbox" role="switch" aria-label={app ? `Nghe ${app.name}` : title} checked={checked} onChange={event => onChange(event.target.checked)}/><i/></span>
    </label>
  return <span className="menu-apps">
    <span className="menu-caption">Ứng dụng được nghe</span>
    {row('all', 'Tất cả ứng dụng', audio.excluded.length ? `Đang bỏ qua ${audio.excluded.length}` : 'Đang nghe tất cả', !audio.excluded.length,
      on => on ? audio.listenToAll() : audio.leaveOutAll())}
    {audio.apps.length === 0 ? <span className="menu-app-empty">Chưa có ứng dụng nào đang phát tiếng.</span>
      : <span className="menu-app-list">{audio.apps.map(app => row(app.id, app.name, audio.isPlaying(app) ? 'Đang phát' : 'Im lặng', audio.listening(app), listen => audio.setListening(app, listen), app))}</span>}
  </span>
}
