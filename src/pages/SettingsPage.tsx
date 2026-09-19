import { useEffect, useState } from 'react'
import { Circle } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Appearance } from '../services/types'
import { desktop } from '../services/desktop'

export function SettingsPage({ model, appearance, setAppearance }: { model: AppModel; appearance: Appearance; setAppearance: (value: Appearance) => void }) {
  const [accessKey, setAccessKey] = useState('')
  const [accessKeySaved, setAccessKeySaved] = useState(false)
  const [keyMessage, setKeyMessage] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => {
    if (!desktop.isDesktop) return
    let active = true
    void desktop.accessKeyStatus().then(saved => {
      if (!active) return
      setAccessKeySaved(saved)
    }).catch(error => {
      if (active) setKeyMessage(`Không đọc được cài đặt: ${error}`)
    })
    return () => { active = false }
  }, [])

  const disabled = !desktop.isDesktop || savingKey || model.capturing || model.meetingActive

  const saveAccessKey = async () => {
    setSavingKey(true)
    setKeyMessage('')
    try {
      const saved = await desktop.setAccessKey(accessKey)
      setAccessKeySaved(saved)
      setAccessKey('')
      setKeyMessage('Đã lưu key.')
    } catch (error) {
      setKeyMessage(`Không lưu được key: ${error}`)
    } finally {
      setSavingKey(false)
    }
  }

  return <main className="page-scroll"><div className="page-wrap settings-wrap animate-in">
    <div className="eyebrow">SYSTEM</div>
    <h1>Cài đặt & trạng thái</h1>
    <p className="page-subtitle">Tùy chỉnh VietNote theo cách bạn muốn sử dụng.</p>

    <section className="glass-card settings-card">
      <div className="settings-heading"><Circle size={19}/><h3>Giao diện</h3><small>Liquid Glass</small></div>
      <div className="segmented appearance-picker">{([['system','Hệ thống'], ['light','Sáng'], ['dark','Tối']] as const).map(([key, label]) => <button key={key} className={appearance === key ? 'selected' : ''} onClick={() => setAppearance(key)}>{label}</button>)}</div>
      <small className="muted">{appearance === 'system' ? 'Tự động theo giao diện hệ thống.' : appearance === 'light' ? 'Nền trắng hồng, ánh xanh băng và kính lavender.' : 'Nền tím đêm, ánh lavender và hồng phấn.'}</small>
    </section>

    <section className="glass-card settings-card">
      <h3>Nhập Key</h3>
      <small className="muted">Dùng key VietNote để mở rộng hạn mức sử dụng.</small>
      <div className="groq-key-actions">
        <input id="access-key" aria-label="Nhập Key" type="password" autoComplete="off" spellCheck={false} placeholder="Nhập key VietNote" value={accessKey} onChange={event => setAccessKey(event.target.value)} disabled={disabled}/>
        <button className="pill-btn primary" disabled={disabled || !accessKey.trim()} onClick={() => void saveAccessKey()}>Lưu key</button>
      </div>
      {accessKeySaved && !keyMessage && <small className="groq-key-message">Key đã được lưu.</small>}
      {keyMessage && <small role="status" className="groq-key-message">{keyMessage}</small>}
    </section>

  </div></main>
}
