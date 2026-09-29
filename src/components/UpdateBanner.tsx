import { useEffect, useState } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { Download } from 'lucide-react'

// Downloads a newer release from GitHub in the background, then waits for the
// user to restart so an in-progress meeting is never cut off.
export function UpdateBanner({ busy }: { busy: boolean }) {
  const [version, setVersion] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  useEffect(() => {
    if (import.meta.env.DEV) return
    let cancelled = false
    void (async () => {
      try {
        const update = await check()
        if (!update || cancelled) return
        await update.downloadAndInstall()
        if (!cancelled) setVersion(update.version)
      } catch (error) { console.warn('Update check failed', error) }
    })()
    return () => { cancelled = true }
  }, [])
  if (!version) return null
  const restart = async () => { setRestarting(true); await relaunch() }
  return <div className="update-banner">
    <Download size={16}/>
    <span>VietNote {version} đã sẵn sàng. {busy ? 'Khởi động lại sau khi kết thúc cuộc họp.' : 'Khởi động lại để cập nhật.'}</span>
    <button className="pill-btn primary" disabled={busy || restarting} onClick={() => void restart()}>{restarting ? 'Đang khởi động lại…' : 'Khởi động lại'}</button>
  </div>
}
