import { useEffect, useState } from 'react'
import { Circle } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Appearance } from '../services/types'
import { ApiHealthIcon, type Health } from '../components/ApiHealthIcon'
import { DiarizationModelCard } from '../components/DiarizationModelCard'
import { desktop, type SummaryAiConfig } from '../services/desktop'

const OPENROUTER_AI: SummaryAiConfig = { provider: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3.7-flash' }
const CHECKING: Health = { ready: false, checking: true, message: 'Đang kiểm tra API…' }


export function SettingsPage({ model, appearance, setAppearance }: { model: AppModel; appearance: Appearance; setAppearance: (value: Appearance) => void }) {
  const [accessKey, setAccessKey] = useState('')
  const [accessKeySaved, setAccessKeySaved] = useState(false)
  const [keyMessage, setKeyMessage] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [sonioxKey, setSonioxKey] = useState('')
  const [sonioxKeyStatus, setSonioxKeyStatus] = useState('')
  const [summaryAi, setSummaryAi] = useState<SummaryAiConfig>(OPENROUTER_AI)
  const [summaryKey, setSummaryKey] = useState('')
  const [summaryAiStatus, setSummaryAiStatus] = useState('')
  const [providerHealth, setProviderHealth] = useState<Record<'soniox' | 'openrouter', Health>>({ soniox: CHECKING, openrouter: CHECKING })

  const refreshHealth = async (provider: 'soniox' | 'openrouter') => {
    setProviderHealth(current => ({ ...current, [provider]: CHECKING }))
    try {
      const health = await desktop.checkAiProvider(provider)
      setProviderHealth(current => ({ ...current, [provider]: { ...health, checking: false } }))
    } catch (error) {
      setProviderHealth(current => ({ ...current, [provider]: { ready: false, checking: false, message: `Không kiểm tra được API: ${error}` } }))
    }
  }

  useEffect(() => {
    if (!desktop.isDesktop) return
    let active = true
    void desktop.accessKeyStatus().then(saved => {
      if (!active) return
      setAccessKeySaved(saved)
    }).catch(error => {
      if (active) setKeyMessage(`Không đọc được cài đặt: ${error}`)
    })
    void desktop.aiKeyStatus('soniox').then(status => {
      if (active) setSonioxKeyStatus(status === 'none' ? '' : status === 'saved' ? 'Soniox API key đã được lưu an toàn.' : 'Đang dùng SONIOX_API_KEY từ môi trường.')
    }).catch(error => { if (active) setSonioxKeyStatus(`Không đọc được Soniox key: ${error}`) })
    void desktop.getSummaryAiConfig().then(config => {
      if (!active) return
      setSummaryAi(config)
      return desktop.aiKeyStatus(config.provider).then(status => {
        if (active) setSummaryAiStatus(status === 'saved' ? 'API key đã được lưu an toàn.' : status === 'environment' ? 'Đang dùng API key từ môi trường hoặc bản build.' : '')
      })
    }).catch(error => { if (active) setSummaryAiStatus(`Không đọc được cấu hình AI: ${error}`) })
    void refreshHealth('soniox')
    void refreshHealth('openrouter')
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

  const saveSonioxKey = async () => {
    setSavingKey(true)
    try {
      const status = await desktop.setAiApiKey('soniox', sonioxKey.trim() || null)
      setSonioxKey('')
      setSonioxKeyStatus(status === 'saved' ? 'Đã lưu Soniox API key và khởi động lại nhận diện.' : status === 'environment' ? 'Đang dùng SONIOX_API_KEY từ môi trường.' : 'Đã xóa Soniox API key.')
      await refreshHealth('soniox')
    } catch (error) {
      setSonioxKeyStatus(`Không lưu được Soniox key: ${error}`)
    } finally {
      setSavingKey(false)
    }
  }

  const saveSummaryAi = async () => {
    setSavingKey(true)
    setSummaryAiStatus('')
    try {
      const saved = await desktop.setSummaryAiConfig(summaryAi)
      setSummaryAi(saved)
      if (summaryKey.trim()) {
        await desktop.setAiApiKey(saved.provider, summaryKey.trim())
        setSummaryKey('')
      }
      setSummaryAiStatus('Đã lưu cấu hình OpenRouter.')
      await refreshHealth(saved.provider)
    } catch (error) {
      setSummaryAiStatus(`Không lưu được cấu hình AI: ${error}`)
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
      <div className="settings-heading"><h3>Soniox nhận diện + dịch</h3><ApiHealthIcon health={providerHealth.soniox}/><small>{providerHealth.soniox.message}</small></div>
      <small className="muted">Chép lời realtime và dịch Anh/Trung sang tiếng Việt (~$0.12/giờ). Bản dịch được đọc bằng giọng ZeroTTS trên máy.</small>
      <div className="groq-key-actions">
        <input aria-label="Soniox API key" type="password" autoComplete="off" spellCheck={false} placeholder="Nhập Soniox API key" value={sonioxKey} onChange={event => setSonioxKey(event.target.value)} disabled={disabled}/>
        <button className="pill-btn primary" disabled={disabled || !sonioxKey.trim()} onClick={() => void saveSonioxKey()}>Lưu key</button>
      </div>
      {sonioxKeyStatus && <small role="status" className="groq-key-message">{sonioxKeyStatus}</small>}
    </section>


    <DiarizationModelCard model={model}/>

    <section className="glass-card settings-card">
      <div className="settings-heading"><h3>OpenRouter dịch và tóm tắt</h3><ApiHealthIcon health={providerHealth.openrouter}/><small>{providerHealth.openrouter.message}</small></div>
      <small className="muted">Chuẩn hóa bản dịch theo đoạn và tóm tắt cuộc họp. Mặc định Qwen3.7 Flash, đã tắt chế độ suy nghĩ.</small>
      <label className="groq-key-label">Model</label>
      <input className="summary-config-input" aria-label="Model dịch và tóm tắt" placeholder="qwen/qwen3.7-flash" value={summaryAi.model} onChange={event => setSummaryAi({ ...summaryAi, model: event.target.value })} disabled={disabled}/>
      <label className="groq-key-label">API key</label>
      <div className="groq-key-actions">
        <input aria-label="OpenRouter API key" type="password" autoComplete="off" spellCheck={false} placeholder="Nhập OpenRouter API key" value={summaryKey} onChange={event => setSummaryKey(event.target.value)} disabled={disabled}/>
        <button className="pill-btn primary" disabled={disabled} onClick={() => void saveSummaryAi()}>Lưu cấu hình</button>
      </div>
      {summaryAiStatus && <small role="status" className="groq-key-message">{summaryAiStatus}</small>}
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
